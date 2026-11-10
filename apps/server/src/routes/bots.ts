import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createBotSchema, startTeachSchema, updateBotSchema } from "@grokbot/shared";
import type { AppEnv } from "../context.js";

export const botsRoutes = new Hono<AppEnv>();

botsRoutes.get("/", (c) => c.json(c.get("store").bots.list()));

botsRoutes.post("/", async (c) => {
  const parsed = createBotSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  const bot = store.bots.create(parsed.data);
  const conversation = store.conversations.directForBot(bot.id);
  c.get("emit")({ type: "bot.updated", bot });
  return c.json({ bot, conversation }, 201);
});

botsRoutes.get("/:id", (c) => {
  const bot = c.get("store").bots.get(c.req.param("id"));
  return bot ? c.json(bot) : c.json({ error: "Not found" }, 404);
});

botsRoutes.patch("/:id", async (c) => {
  const parsed = updateBotSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  const bot = store.bots.update(c.req.param("id"), parsed.data);
  if (!bot) return c.json({ error: "Not found" }, 404);
  c.get("emit")({ type: "bot.updated", bot });
  // The Chief's model is the space's model: every Bot in the space follows it, and so do future hires.
  if (parsed.data.modelRef !== undefined && bot.isPrimary && bot.spaceId) {
    const modelRef = parsed.data.modelRef;
    for (const other of store.bots.listInSpace(bot.spaceId)) {
      if (other.id === bot.id || other.modelRef === modelRef) continue;
      const updated = store.bots.update(other.id, { modelRef });
      if (updated) c.get("emit")({ type: "bot.updated", bot: updated });
    }
    const space = store.spaces.update(bot.spaceId, { defaultModelRef: modelRef });
    if (space) c.get("emit")({ type: "space.updated", space });
  }
  return c.json(bot);
});

botsRoutes.delete("/:id", (c) => {
  const id = c.req.param("id");
  const store = c.get("store");
  const runtime = c.get("runtime");
  // Its routines go with it (and must be disarmed); its tasks fall back to the user.
  for (const r of store.routines.list(id)) runtime.scheduler.unschedule(r.id);
  store.routines.deleteForBot(id);
  for (const t of store.tasks.list({ ownerBotId: id, includeClosed: true })) {
    const task = store.tasks.update(t.id, { ownerBotId: null, status: t.status === "done" || t.status === "dropped" ? t.status : "open" });
    if (task) c.get("emit")({ type: "task.updated", task });
  }
  store.bots.delete(id);
  c.get("emit")({ type: "bot.deleted", botId: id });
  return c.body(null, 204);
});

botsRoutes.get("/:id/computer", (c) => c.json(c.get("computer").getState(c.req.param("id"))));

botsRoutes.post("/:id/computer/reset", async (c) => {
  await c.get("computer").reset(c.req.param("id"));
  return c.json(c.get("computer").getState(c.req.param("id")));
});

/** Teach a task: record the user driving the Bot's screen, then have the Bot draft a skill. */
botsRoutes.post("/:id/teach/start", async (c) => {
  const parsed = startTeachSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const botId = c.req.param("id");
  const store = c.get("store");
  if (!store.bots.get(botId)) return c.json({ error: "Not found" }, 404);
  const computer = c.get("computer");
  if (computer.isRecording(botId)) return c.json({ error: "Already recording" }, 409);
  const id = randomUUID().slice(0, 8);
  const outDir = join(c.get("runtime").workspaceDir, "teach", id);
  mkdirSync(outDir, { recursive: true });
  await computer.startRecording(botId, { id, description: parsed.data.description, outDir });
  return c.json(computer.getState(botId));
});

botsRoutes.post("/:id/teach/stop", async (c) => {
  const botId = c.req.param("id");
  const store = c.get("store");
  const bot = store.bots.get(botId);
  if (!bot) return c.json({ error: "Not found" }, 404);
  const computer = c.get("computer");
  if (!computer.isRecording(botId)) return c.json({ error: "Not recording" }, 409);
  const runtime = c.get("runtime");
  const rec = await computer.stopRecording(botId);
  const ws = runtime.workspaceDir;
  const frames = rec.frames.map((f) => relative(ws, f));
  const dir = join("teach", rec.id);
  writeFileSync(join(ws, dir, "events.json"), JSON.stringify({ ...rec, frames }, null, 2));
  const conv = store.conversations.directForBot(botId);
  const msg = store.messages.create({
    conversationId: conv.id,
    role: "system",
    botId,
    content: [
      `Teach a task: the user just showed you how to do this once: "${rec.description}".`,
      `The recording (${rec.events.length} actions, ${frames.length} screenshots) is in your workspace: ${dir}/events.json (actions with targets and urls) and ${dir}/frame-*.jpg (look at the key ones with attachment_view).`,
      "Study it, then save a draft skill with skill_save (pass taught: true): name it from the description (lowercase-dashes), and write when to use it, inputs, the steps as the user did them (urls, what to click/type, decision rules you can infer), how to verify success, the expected output, and where to pause for approval. Mark it as a draft in the description. Then summarise the skill for the user in a few lines and ask if anything should change.",
    ].join("\n"),
  });
  c.get("emit")({ type: "message.created", message: msg });
  runtime.wake({ source: "user", conversationId: conv.id, botId, messageId: msg.id });
  return c.json({ recording: { id: rec.id, events: rec.events.length, frames: frames.length } });
});

/** The bot's 1:1 conversation (created on first access). */
botsRoutes.get("/:id/conversation", (c) => {
  const store = c.get("store");
  const bot = store.bots.get(c.req.param("id"));
  if (!bot) return c.json({ error: "Not found" }, 404);
  return c.json(store.conversations.directForBot(bot.id));
});
