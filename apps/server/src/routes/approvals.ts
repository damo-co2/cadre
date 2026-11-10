import { Hono } from "hono";
import { createRuleSchema, decideApprovalSchema, MAX_CUSTOM_RULES_PER_KIND, type ApprovalStatus } from "@grokbot/shared";
import type { AppEnv } from "../context.js";

export const approvalsRoutes = new Hono<AppEnv>();

approvalsRoutes.get("/", (c) => {
  const status = c.req.query("status") as ApprovalStatus | undefined;
  return c.json(c.get("store").approvals.list(status ?? "pending"));
});

approvalsRoutes.get("/:id", (c) => {
  const a = c.get("store").approvals.get(c.req.param("id"));
  return a ? c.json(a) : c.json({ error: "Not found" }, 404);
});

approvalsRoutes.post("/:id", async (c) => {
  const parsed = decideApprovalSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const a = c.get("runtime").approvals.decide(c.req.param("id"), parsed.data.decision);
  return a ? c.json(a) : c.json({ error: "Not found" }, 404);
});

export const rulesRoutes = new Hono<AppEnv>();

rulesRoutes.get("/", (c) => c.json(c.get("store").rules.list()));

rulesRoutes.post("/", async (c) => {
  const parsed = createRuleSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  const count = store.rules.list().filter((r) => r.kind === parsed.data.kind).length;
  if (count >= MAX_CUSTOM_RULES_PER_KIND) {
    return c.json({ error: `You can have up to ${MAX_CUSTOM_RULES_PER_KIND} "${parsed.data.kind}" rules.` }, 400);
  }
  return c.json(store.rules.create(parsed.data), 201);
});

rulesRoutes.delete("/:id", (c) => {
  c.get("store").rules.delete(c.req.param("id"));
  return c.body(null, 204);
});
