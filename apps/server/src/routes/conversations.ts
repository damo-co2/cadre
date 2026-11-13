import { Hono } from "hono";
import { createGroupSchema, sendMessageSchema, updateConversationSchema } from "@grokbot/shared";
import type { AppEnv } from "../context.js";

export const conversationsRoutes = new Hono<AppEnv>();

/** Group chats only (direct chats are reached through /api/bots/:id/conversation). */
conversationsRoutes.get("/", (c) => c.json(c.get("store").conversations.listGroups()));

/** "New chat" → "To:" with 2 to 6 Bots. */
conversationsRoutes.post("/", async (c) => {
  const parsed = createGroupSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  const ids = [...new Set(parsed.data.botIds)];
  const bots = ids.map((id) => store.bots.get(id));
  if (bots.some((b) => !b) || ids.length < 2) return c.json({ error: "Pick 2 to 6 existing Bots" }, 400);
  const title = parsed.data.title || bots.map((b) => b!.name).join(", ");
  const conversation = store.conversations.create("group", ids, title);
  c.get("emit")({ type: "conversation.updated", conversation });
  return c.json(conversation, 201);
});

conversationsRoutes.get("/:id", (c) => {
  const conv = c.get("store").conversations.get(c.req.param("id"));
  return conv ? c.json(conv) : c.json({ error: "Not found" }, 404);
});

conversationsRoutes.patch("/:id", async (c) => {
  const parsed = updateConversationSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  const conv = store.conversations.get(c.req.param("id"));
  if (!conv) return c.json({ error: "Not found" }, 404);
  if (conv.kind !== "group" && parsed.data.botIds) return c.json({ error: "Only group chats can change members" }, 400);
  if (parsed.data.botIds) {
    // Members change through the runtime so the chat shows who joined or left.
    const want = [...new Set(parsed.data.botIds)];
    const res = c.get("runtime").changeGroupMembers(
      conv.id,
      want.filter((id) => !conv.botIds.includes(id)),
      conv.botIds.filter((id) => !want.includes(id)),
      "you",
    );
    if (res.error) return c.json({ error: res.error }, 400);
  }
  let updated = store.conversations.get(conv.id)!;
  if (parsed.data.title !== undefined) {
    updated = store.conversations.update(conv.id, { title: parsed.data.title })!;
    c.get("emit")({ type: "conversation.updated", conversation: updated });
  }
  return c.json(updated);
});

conversationsRoutes.delete("/:id", (c) => {
  const store = c.get("store");
  const conv = store.conversations.get(c.req.param("id"));
  if (!conv) return c.json({ error: "Not found" }, 404);
  if (conv.kind !== "group") return c.json({ error: "Direct chats are deleted with their Bot" }, 400);
  c.get("runtime").stop(conv.id);
  store.conversations.delete(conv.id);
  c.get("emit")({ type: "conversation.deleted", conversationId: conv.id });
  return c.body(null, 204);
});

conversationsRoutes.get("/:id/messages", (c) => {
  const store = c.get("store");
  if (!store.conversations.get(c.req.param("id"))) return c.json({ error: "Not found" }, 404);
  // ?limit=N&before=<messageId> pages backwards; with no limit, the newest 500 (older clients).
  const limit = Number(c.req.query("limit"));
  if (limit > 0) return c.json(store.messages.page(c.req.param("id"), Math.min(limit, 500), c.req.query("before") || undefined));
  return c.json(store.messages.list(c.req.param("id")));
});

conversationsRoutes.post("/:id/messages", async (c) => {
  const parsed = sendMessageSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  const conv = store.conversations.get(c.req.param("id"));
  if (!conv) return c.json({ error: "Not found" }, 404);
  const attachments = parsed.data.attachmentIds.map((id) => store.uploads.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
  if (!parsed.data.content.trim() && !attachments.length) return c.json({ error: "Empty message" }, 400);
  const message = store.messages.create({ conversationId: conv.id, role: "user", content: parsed.data.content, attachments });
  store.conversations.touch(conv.id);
  c.get("emit")({ type: "message.created", message });
  c.get("runtime").routeUserMessage(conv, message);
  return c.json(message, 201);
});

conversationsRoutes.post("/:id/stop", (c) => {
  const id = c.req.param("id");
  if (c.get("runtime").stop(id)) return c.json({ stopped: true });
  // Nothing is running, but a reply may still show as in progress (e.g. cut off by a restart).
  const closed = c.get("store").messages.stopStreaming(id);
  for (const message of closed) {
    c.get("emit")({ type: "message.done", message });
    if (message.botId) c.get("emit")({ type: "bot.status", botId: message.botId, status: "idle" });
  }
  return c.json({ stopped: closed.length > 0 });
});

conversationsRoutes.post("/:id/reset", (c) => {
  const store = c.get("store");
  const conv = store.conversations.get(c.req.param("id"));
  if (!conv) return c.json({ error: "Not found" }, 404);
  c.get("runtime").stop(conv.id);
  store.conversations.clearMessages(conv.id);
  c.get("emit")({ type: "conversation.updated", conversation: conv });
  return c.json({ ok: true });
});
