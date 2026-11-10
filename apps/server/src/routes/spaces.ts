import { Hono } from "hono";
import { createSpaceSchema, updateSpaceSchema } from "@grokbot/shared";
import type { AppEnv } from "../context.js";

/** Spaces (Work, Personal, …): each has its own Bots, lead Bot and default model. */
export const spacesRoutes = new Hono<AppEnv>();

spacesRoutes.get("/", (c) => c.json(c.get("store").spaces.list()));

spacesRoutes.post("/", async (c) => {
  const parsed = createSpaceSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const space = c.get("store").spaces.create(parsed.data);
  c.get("emit")({ type: "space.updated", space });
  return c.json(space, 201);
});

spacesRoutes.patch("/:id", async (c) => {
  const parsed = updateSpaceSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const space = c.get("store").spaces.update(c.req.param("id"), parsed.data);
  if (!space) return c.json({ error: "Not found" }, 404);
  c.get("emit")({ type: "space.updated", space });
  return c.json(space);
});

spacesRoutes.delete("/:id", (c) => {
  const store = c.get("store");
  const id = c.req.param("id");
  if (!store.spaces.get(id)) return c.json({ error: "Not found" }, 404);
  if (store.spaces.list().length <= 1) return c.json({ error: "Keep at least one space." }, 400);
  if (store.spaces.botCount(id)) return c.json({ error: "Move or delete this space's Bots first." }, 400);
  store.memories.releaseSpace(id); // its About you facts now apply everywhere
  store.spaces.delete(id);
  c.get("emit")({ type: "space.deleted", spaceId: id });
  return c.body(null, 204);
});
