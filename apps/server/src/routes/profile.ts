import { Hono } from "hono";
import { createProfileFactSchema, updateProfileFactSchema } from "@grokbot/shared";
import type { AppEnv } from "../context.js";

/** About you: what Bots know about the user. Everything here is the user's to see, edit and delete. */
export const profileRoutes = new Hono<AppEnv>();

profileRoutes.get("/", (c) => c.json(c.get("store").memories.profile()));

profileRoutes.post("/", async (c) => {
  const parsed = createProfileFactSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  if (parsed.data.spaceId && !store.spaces.get(parsed.data.spaceId)) return c.json({ error: "Unknown space" }, 400);
  const fact = store.memories.addProfileFact({ ...parsed.data, source: "you" });
  c.get("emit")({ type: "profile.updated" });
  return c.json(fact, 201);
});

profileRoutes.patch("/:id", async (c) => {
  const parsed = updateProfileFactSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  if (parsed.data.spaceId && !store.spaces.get(parsed.data.spaceId)) return c.json({ error: "Unknown space" }, 400);
  // Anything the user edits becomes theirs: the learning pass won't change or remove it.
  const fact = store.memories.updateProfileFact(c.req.param("id"), { ...parsed.data, source: "you" });
  if (!fact) return c.json({ error: "Not found" }, 404);
  c.get("emit")({ type: "profile.updated" });
  return c.json(fact);
});

profileRoutes.delete("/:id", (c) => {
  if (!c.get("store").memories.deleteProfileFact(c.req.param("id"))) return c.json({ error: "Not found" }, 404);
  c.get("emit")({ type: "profile.updated" });
  return c.body(null, 204);
});
