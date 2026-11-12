import { Hono } from "hono";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createRoutineSchema, MAX_ROUTINES_PER_BOT, updateRoutineSchema, upsertSkillSchema } from "@grokbot/shared";
import { validateCron } from "@grokbot/agent-runtime";
import type { AppEnv } from "../context.js";

// ---------- skills ----------

export const skillsRoutes = new Hono<AppEnv>();

skillsRoutes.get("/", (c) => c.json([...c.get("store").skills.list(), ...c.get("runtime").plugins.skillList()]));

/** A plugin skill's instructions (read from its folder each time). */
skillsRoutes.get("/plugin/:name", (c) => {
  const content = c.get("runtime").plugins.readSkill(c.req.param("name"));
  return content == null ? c.json({ error: "Not found" }, 404) : c.json({ content });
});

skillsRoutes.put("/", async (c) => {
  const parsed = upsertSkillSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const skill = c.get("store").skills.upsert(parsed.data);
  c.get("emit")({ type: "skill.updated", skill });
  return c.json(skill);
});

skillsRoutes.delete("/:id", (c) => {
  c.get("store").skills.delete(c.req.param("id"));
  c.get("emit")({ type: "skill.deleted", skillId: c.req.param("id") });
  return c.body(null, 204);
});

// ---------- routines ----------

export const routinesRoutes = new Hono<AppEnv>();

/** Mounted under /api/bots/:botId/routines via botRoutinesRoutes; this handles /api/routines/:id. */
routinesRoutes.get("/:id", (c) => {
  const r = c.get("store").routines.get(c.req.param("id"));
  return r ? c.json(r) : c.json({ error: "Not found" }, 404);
});

routinesRoutes.get("/:id/runs", (c) => c.json(c.get("store").routines.runs(c.req.param("id"))));

routinesRoutes.patch("/:id", async (c) => {
  const parsed = updateRoutineSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  const r = store.routines.get(c.req.param("id"));
  if (!r) return c.json({ error: "Not found" }, 404);
  const trigger = parsed.data.trigger;
  if (trigger?.kind === "schedule") {
    const v = validateCron(trigger.cron, parsed.data.timezone ?? r.timezone ?? store.settings.get().timezone);
    if (!v.ok) return c.json({ error: v.error }, 400);
  }
  const webhookKey = trigger?.kind === "webhook" && !r.webhookKey ? randomBytes(24).toString("base64url") : undefined;
  const updated = store.routines.update(r.id, { ...parsed.data, webhookKey })!;
  return c.json(c.get("runtime").scheduler.schedule(updated));
});

routinesRoutes.delete("/:id", (c) => {
  const store = c.get("store");
  const r = store.routines.get(c.req.param("id"));
  if (!r) return c.json({ error: "Not found" }, 404);
  c.get("runtime").scheduler.unschedule(r.id);
  store.routines.delete(r.id);
  c.get("emit")({ type: "routine.deleted", routineId: r.id, botId: r.botId });
  return c.body(null, 204);
});

/** Every routine on the team, soonest next run first (Team panel "Next up"). */
routinesRoutes.get("/", (c) =>
  c.json(
    c
      .get("store")
      .routines.list()
      .sort((a, b) => (a.nextRunAt ?? "9999").localeCompare(b.nextRunAt ?? "9999")),
  ),
);

routinesRoutes.post("/:id/test", async (c) => {
  const run = await c.get("runtime").scheduler.fire(c.req.param("id"), "test");
  return run ? c.json(run) : c.json({ error: "Not found" }, 404);
});

export const botRoutinesRoutes = new Hono<AppEnv>();

botRoutinesRoutes.get("/:id/routines", (c) => c.json(c.get("store").routines.list(c.req.param("id"))));

botRoutinesRoutes.post("/:id/routines", async (c) => {
  const parsed = createRoutineSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  const botId = c.req.param("id");
  if (!store.bots.get(botId)) return c.json({ error: "Not found" }, 404);
  if (store.routines.countForBot(botId) >= MAX_ROUTINES_PER_BOT) return c.json({ error: `A Bot can own up to ${MAX_ROUTINES_PER_BOT} routines.` }, 400);
  const { trigger } = parsed.data;
  if (trigger.kind === "schedule") {
    const v = validateCron(trigger.cron, parsed.data.timezone ?? store.settings.get().timezone);
    if (!v.ok) return c.json({ error: v.error }, 400);
  }
  const routine = store.routines.create({
    botId,
    name: parsed.data.name,
    instruction: parsed.data.instruction,
    trigger,
    timezone: parsed.data.timezone ?? null,
    enabled: parsed.data.enabled,
    webhookKey: trigger.kind === "webhook" ? randomBytes(24).toString("base64url") : null,
    nextRunAt: null,
  });
  return c.json(c.get("runtime").scheduler.schedule(routine), 201);
});

// ---------- webhooks ----------

export const hooksRoutes = new Hono<AppEnv>();

/** POST /api/hooks/:routineId with Authorization: Bearer <key>. 200 = accepted and started. */
hooksRoutes.post("/:id", async (c) => {
  const store = c.get("store");
  const r = store.routines.get(c.req.param("id"));
  if (!r || r.trigger.kind !== "webhook" || !r.webhookKey) return c.json({ error: "Not found" }, 404);
  const auth = c.req.header("authorization") ?? "";
  const given = Buffer.from(auth.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(r.webhookKey);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return c.json({ error: "Unauthorized" }, 401);
  if (!r.enabled) return c.json({ error: "Routine is paused" }, 409);
  const body = await c.req.text().catch(() => "");
  const run = await c.get("runtime").scheduler.fire(r.id, "webhook", body.slice(0, 8000));
  if (!run) return c.json({ error: "Could not start" }, 500);
  if (run.status === "skipped") return c.json({ error: run.error, run }, 429);
  return c.json({ accepted: true, run });
});
