import { Hono } from "hono";
import { createPinSchema, messageText } from "@grokbot/shared";
import type { AppEnv } from "../context.js";

/** Messages the user pinned to come back to later; Team pulse lists them. */
export const pinsRoutes = new Hono<AppEnv>();

pinsRoutes.get("/", (c) => c.json(c.get("store").pins.list()));

pinsRoutes.post("/", async (c) => {
  const parsed = createPinSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  const message = store.messages.get(parsed.data.messageId);
  if (!message) return c.json({ error: "Message not found" }, 404);
  const conversation = store.conversations.get(message.conversationId);
  if (!conversation) return c.json({ error: "Chat not found" }, 404);
  const text = messageText(message);
  if (!text) return c.json({ error: "Nothing to pin in this message yet" }, 400);
  const pin = store.pins.create({
    conversationId: message.conversationId,
    messageId: message.id,
    botId: conversation.kind === "direct" ? (conversation.botIds[0] ?? message.botId) : message.botId,
    role: message.role,
    text,
    messageAt: message.createdAt,
  });
  c.get("emit")({ type: "pins.updated" });
  return c.json(pin, 201);
});

pinsRoutes.delete("/:id", (c) => {
  c.get("store").pins.delete(c.req.param("id"));
  c.get("emit")({ type: "pins.updated" });
  return c.json({ ok: true });
});
