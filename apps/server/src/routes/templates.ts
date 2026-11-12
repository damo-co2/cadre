import { Hono } from "hono";
import { createFromTemplateSchema, createSquadSchema, type Bot } from "@grokbot/shared";
import { findSquad, findTemplate, instantiateTemplate, introductionMessage, templateCatalog } from "@grokbot/agent-runtime";
import type { AppEnv } from "../context.js";

/** Bot templates and squads: GET the catalog, create a Bot or a whole team from one. */
export const templatesRoutes = new Hono<AppEnv>();

templatesRoutes.get("/", (c) => c.json(templateCatalog()));

templatesRoutes.post("/:id/create", async (c) => {
  const t = findTemplate(c.req.param("id"));
  if (!t) return c.json({ error: "No such template" }, 404);
  const parsed = createFromTemplateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const runtime = c.get("runtime");
  const { bot, conversation, routines, skipped } = instantiateTemplate(
    { store: c.get("store"), scheduler: runtime.scheduler, emit: c.get("emit") },
    t,
    { name: parsed.data.name, modelRef: parsed.data.modelRef, withRoutines: parsed.data.withRoutines, makePrimary: parsed.data.makePrimary, spaceId: parsed.data.spaceId },
  );
  if (parsed.data.introduce) runtime.postSystemAndWake(bot.id, introductionMessage(t, routines));
  return c.json({ bot: c.get("store").bots.get(bot.id) ?? bot, conversation, routines, skipped }, 201);
});

templatesRoutes.post("/squads/:id/create", async (c) => {
  const squad = findSquad(c.req.param("id"));
  if (!squad) return c.json({ error: "No such squad" }, 404);
  const parsed = createSquadSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  const emit = c.get("emit");
  const runtime = c.get("runtime");
  const deps = { store, scheduler: runtime.scheduler, emit };
  const bots: Bot[] = [];
  for (const id of squad.botTemplateIds) {
    const t = findTemplate(id);
    if (!t) continue;
    // The space already has a Chief of Staff: it leads this squad instead of a second one.
    const spaceId = (parsed.data.spaceId && store.spaces.get(parsed.data.spaceId)?.id) || store.spaces.fallback().id;
    const existingLead = t.primary ? store.bots.listInSpace(spaceId).find((b) => b.isPrimary && !b.hidden) : undefined;
    if (existingLead) {
      bots.push(existingLead);
      continue;
    }
    bots.push(instantiateTemplate(deps, t, { modelRef: parsed.data.modelRef, withRoutines: parsed.data.withRoutines, spaceId }).bot);
  }
  const fresh = bots.map((b) => store.bots.get(b.id) ?? b);
  const lead = fresh.find((b) => b.isPrimary) ?? fresh[0]!;
  const conversation = store.conversations.create("group", fresh.map((b) => b.id), squad.groupTitle);
  emit({ type: "conversation.updated", conversation });
  const message = store.messages.create({ conversationId: conversation.id, role: "user", content: squad.kickoff.replaceAll("{lead}", `@${lead.name}`) });
  emit({ type: "message.created", message });
  runtime.routeUserMessage(conversation, message);
  return c.json({ bots: fresh, conversation }, 201);
});
