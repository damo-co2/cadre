import { Hono } from "hono";
import { installPluginSchema, pluginSourceSchema, updatePluginSchema } from "@grokbot/shared";
import type { AppEnv } from "../context.js";

/** Plugins and skills folders from any agent harness: preview, install, refresh, update, remove. */
export const pluginsRoutes = new Hono<AppEnv>();

const failure = (err: unknown) => ({ error: (err as Error).message || String(err) });

pluginsRoutes.get("/", (c) => c.json(c.get("runtime").plugins.list()));

pluginsRoutes.get("/suggestions", (c) => c.json(c.get("runtime").plugins.suggestions()));

pluginsRoutes.post("/preview", async (c) => {
  const parsed = pluginSourceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Give a folder path or a git URL." }, 400);
  try {
    return c.json(await c.get("runtime").plugins.preview(parsed.data.source));
  } catch (err) {
    return c.json(failure(err), 400);
  }
});

pluginsRoutes.post("/", async (c) => {
  const parsed = installPluginSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  try {
    return c.json(await c.get("runtime").plugins.install(parsed.data), 201);
  } catch (err) {
    return c.json(failure(err), 400);
  }
});

pluginsRoutes.post("/:id/refresh", (c) => {
  const p = c.get("runtime").plugins.refresh(c.req.param("id"));
  return p ? c.json(p) : c.json({ error: "Not found" }, 404);
});

pluginsRoutes.post("/:id/update", async (c) => {
  try {
    const p = await c.get("runtime").plugins.update(c.req.param("id"));
    return p ? c.json(p) : c.json({ error: "Not found" }, 404);
  } catch (err) {
    return c.json(failure(err), 400);
  }
});

pluginsRoutes.patch("/:id", async (c) => {
  const parsed = updatePluginSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const p = await c.get("runtime").plugins.setEnabled(c.req.param("id"), parsed.data.enabled);
  return p ? c.json(p) : c.json({ error: "Not found" }, 404);
});

/** ?keepApps=1 leaves the apps it added in Connect apps. */
pluginsRoutes.delete("/:id", async (c) => {
  const ok = await c.get("runtime").plugins.remove(c.req.param("id"), c.req.query("keepApps") === "1");
  return ok ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
});
