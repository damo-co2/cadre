import { Hono } from "hono";
import { PROVIDER_IDS, updateProviderSchema, type ModelListing, type ProviderId } from "@grokbot/shared";
import type { AppEnv } from "../context.js";

export const providersRoutes = new Hono<AppEnv>();

function asProvider(id: string): ProviderId | null {
  return (PROVIDER_IDS as readonly string[]).includes(id) ? (id as ProviderId) : null;
}

providersRoutes.get("/", async (c) => c.json(await c.get("drivers").describeAll()));

providersRoutes.get("/:id", async (c) => {
  const p = asProvider(c.req.param("id"));
  if (!p) return c.json({ error: "Unknown provider" }, 404);
  return c.json(await c.get("drivers").describe(p));
});

providersRoutes.put("/:id", async (c) => {
  const p = asProvider(c.req.param("id"));
  if (!p) return c.json({ error: "Unknown provider" }, 404);
  const parsed = updateProviderSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  c.get("store").providers.set(p, parsed.data);
  return c.json(await c.get("drivers").describe(p));
});

providersRoutes.get("/:id/models", async (c) => {
  const p = asProvider(c.req.param("id"));
  if (!p) return c.json({ error: "Unknown provider" }, 404);
  const driver = c.get("drivers").get(p);
  const models = await driver.listModels();
  const listing: ModelListing = { provider: p, models, source: "live" };
  return c.json(listing);
});
