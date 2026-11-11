import { Hono } from "hono";
import type { AppEnv } from "../context.js";

/** GitHub pull requests the Bots mentioned recently, for the Team pulse panel. */
export const pullRequestsRoutes = new Hono<AppEnv>();

pullRequestsRoutes.get("/", (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 14) || 14, 1), 90);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return c.json(c.get("store").messages.pullRequests(since));
});
