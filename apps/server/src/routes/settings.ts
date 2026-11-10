import { Hono } from "hono";
import { parseModelRef, updateSettingsSchema, type Bot } from "@grokbot/shared";
import type { AppEnv } from "../context.js";

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get("/", (c) => c.json(c.get("store").settings.get()));

/**
 * The model a Bot with no model of its own actually gets, and where that comes from:
 * its space's default, the app default, or the automatic pick (first provider that is on).
 */
settingsRoutes.get("/default-model", (c) => {
  const store = c.get("store");
  const spaceId = c.req.query("spaceId") ?? "";
  const space = spaceId ? store.spaces.get(spaceId) : undefined;
  const app = store.settings.get().defaultModelRef;
  const probe = { modelRef: null, spaceId: space?.id ?? "" } as unknown as Bot;
  const modelRef = c.get("runtime").resolveModelRef(probe);
  const on = (ref: string | null | undefined) => {
    if (!ref) return false;
    try {
      return !store.providers.get(parseModelRef(ref).provider).disabled;
    } catch {
      return false;
    }
  };
  const source = on(space?.defaultModelRef) ? "space" : on(app) ? "app" : "auto";
  return c.json({ modelRef, source, spaceName: space?.name ?? null });
});

settingsRoutes.put("/", async (c) => {
  const parsed = updateSettingsSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  return c.json(c.get("store").settings.update(parsed.data));
});
