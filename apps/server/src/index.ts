import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openStore } from "@grokbot/db";
import { DriverRegistry } from "@grokbot/model-drivers";
import { AgentRuntime } from "@grokbot/agent-runtime";
import { ComputerService } from "@grokbot/sandbox";
import type { ClientMessage, ServerEvent } from "@grokbot/shared";
import { botsRoutes } from "./routes/bots.js";
import { conversationsRoutes } from "./routes/conversations.js";
import { providersRoutes } from "./routes/providers.js";
import { spacesRoutes } from "./routes/spaces.js";
import { profileRoutes } from "./routes/profile.js";
import { settingsRoutes } from "./routes/settings.js";
import { approvalsRoutes, rulesRoutes } from "./routes/approvals.js";
import { botRoutinesRoutes, hooksRoutes, routinesRoutes, skillsRoutes } from "./routes/automation.js";
import { connectorRoutes, secureFormRoutes, vaultRoutes } from "./routes/vault.js";
import { filesRoutes } from "./routes/files.js";
import { moveOldWorkspace } from "./workspace.js";
import { mcpRoute } from "./routes/mcp.js";
import { templatesRoutes } from "./routes/templates.js";
import { tasksRoutes } from "./routes/tasks.js";
import { pullRequestsRoutes } from "./routes/pullRequests.js";
import { AccessManager, accessMiddleware, accessRoutes, rendererHandler } from "./access.js";
import type { AppEnv } from "./context.js";

const PORT = Number(process.env.PORT ?? 3123);
const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${PORT}`;
const WORKSPACE_DIR = resolve(process.env.WORKSPACE_DIR ?? resolve(DATA_DIR, "workspace"));
moveOldWorkspace(resolve(DATA_DIR, "workspace"), WORKSPACE_DIR);
mkdirSync(WORKSPACE_DIR, { recursive: true });

const store = openStore(DATA_DIR);
const access = new AccessManager(DATA_DIR, PORT);
/** Built renderer served to phones: RENDERER_DIR (packaged app) or the dev build output. */
const RENDERER_DIR = process.env.RENDERER_DIR ?? [resolve("apps/desktop/out/renderer"), resolve("../desktop/out/renderer")].find((d) => existsSync(d)) ?? null;
const drivers = new DriverRegistry((p) => store.providers.get(p));

// ---- realtime fan-out ----
type WsLike = { send(data: string): void; readyState: number };
const clients = new Set<WsLike>();
const sendTo = (ws: WsLike, event: ServerEvent) => {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(event));
  } catch {
    clients.delete(ws);
  }
};
const emit = (event: ServerEvent) => {
  for (const ws of clients) sendTo(ws, event);
};

const computer = new ComputerService({ workspaceDir: WORKSPACE_DIR, headless: !store.settings.get().headedBrowser });
computer.onState((state) => emit({ type: "screen.state", state }));

const FILES_DIR = resolve(DATA_DIR, "files");
// A restart mid-reply leaves the reply "streaming" forever; nothing can resume it now.
const orphans = store.messages.stopOrphans();
if (orphans) console.log(`marked ${orphans} unfinished repl${orphans === 1 ? "y" : "ies"} as stopped`);
const runtime = new AgentRuntime({ store, drivers, emit, computer, workspaceDir: WORKSPACE_DIR, serverUrl: SERVER_URL, filesDir: FILES_DIR });

const app = new Hono<AppEnv>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use("*", logger((s) => process.env.LOG_HTTP && console.log(s)));
// Same-origin for phones; the desktop renderer is file:// ("null") or the Vite dev server.
app.use(
  "*",
  cors({
    origin: (origin) => (!origin || origin === "null" || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) ? origin || "*" : null),
    credentials: true,
  }),
);
app.use("*", accessMiddleware(access));
app.use("*", async (c, next) => {
  c.set("store", store);
  c.set("drivers", drivers);
  c.set("runtime", runtime);
  c.set("computer", computer);
  c.set("emit", emit);
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true, dataDir: DATA_DIR }));
app.route("/api/bots", botsRoutes);
app.route("/api/bots", botRoutinesRoutes);
app.route("/api/routines", routinesRoutes);
app.route("/api/skills", skillsRoutes);
app.route("/api/hooks", hooksRoutes);
const fileRoutes = filesRoutes(FILES_DIR, WORKSPACE_DIR);
app.route("/api/uploads", fileRoutes.uploads);
app.route("/api/files", fileRoutes.files);
app.route("/api/workspace", fileRoutes.workspace);
app.route("/api/vault", vaultRoutes);
app.route("/api/secureforms", secureFormRoutes);
app.route("/api/connectors", connectorRoutes);
app.route("/api/conversations", conversationsRoutes);
app.route("/api/providers", providersRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/spaces", spacesRoutes);
app.route("/api/profile", profileRoutes);
app.route("/api/approvals", approvalsRoutes);
app.route("/api/rules", rulesRoutes);
app.route("/mcp", mcpRoute);
app.route("/api/templates", templatesRoutes);
app.route("/api/tasks", tasksRoutes);
app.route("/api/pull-requests", pullRequestsRoutes);
app.route("/api/access", accessRoutes(access));

// Apps' sign-in pages send the browser back here (Connect apps → Connect).
app.get("/oauth/callback", async (c) => {
  const page = (title: string, body: string, ok: boolean) =>
    c.html(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cadre</title><body style="font:16px -apple-system,system-ui,sans-serif;background:#0b1416;color:#e6f1f2;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center"><div><div style="font-size:40px;margin-bottom:8px">${ok ? "✓" : "!"}</div><div style="font-size:22px;font-weight:600;margin-bottom:8px">${title}</div><div style="color:#9fb3b6;max-width:560px">${body}</div></div></body>`,
      ok ? 200 : 400,
    );
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const error = c.req.query("error");
  if (error) {
    const description = c.req.query("error_description");
    const who = runtime.connectors.authFailed(c.req.query("state"), error, description);
    if (who?.oauthApp === "google" && error === "access_denied") {
      return page(
        "Google said access denied",
        `<div style="text-align:left;line-height:1.5">Google stopped the sign-in. Usually one of these:<ol style="padding-left:20px;margin:10px 0">
<li><b>"Access blocked … Error 403"</b>: your Google account isn't a test user. In Google Cloud open <a style="color:#6ccfdb" href="https://console.cloud.google.com/auth/audience">Google Auth Platform → Audience</a>, add your address under Test users, then try again.</li>
<li><b>"Google hasn't verified this app"</b>: this is your own app, so it's safe. Click <b>Advanced</b>, then <b>Go to Cadre (unsafe)</b>, then <b>Continue</b>.</li>
<li><b>A work Google account</b>: your admin may block apps that aren't approved. Try a personal Google account, or ask the admin to trust your app's Client ID.</li></ol>
Then go back to Cadre → Connect apps and click <b>Open sign-in page</b> on Gmail.</div>`,
        false,
      );
    }
    return page("Sign-in cancelled", `${esc(description ?? error)}<br><br>Go back to Cadre → Connect apps to try again.`, false);
  }
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return page("Sign-in failed", "The app did not send a sign-in code. Click Connect in Cadre to try again.", false);
  try {
    const connector = await runtime.connectors.finishAuth(state, code);
    if (connector.status === "connected") return page(`${esc(connector.label)} is connected`, "You can close this tab and go back to Cadre.", true);
    return page(`Signed in to ${esc(connector.label)}`, `But Cadre could not connect yet: ${esc(connector.statusDetail ?? "unknown error")}`, false);
  } catch (err) {
    return page("Sign-in failed", esc((err as Error).message), false);
  }
});

app.get(
  "/ws",
  upgradeWebSocket(() => {
    const watching = new Map<string, () => void>(); // botId → unwatch
    return {
      onOpen(_evt, ws) {
        const w = ws as unknown as WsLike;
        clients.add(w);
        sendTo(w, { type: "hello", serverTime: new Date().toISOString() });
      },
      onMessage(evt, ws) {
        const w = ws as unknown as WsLike;
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(evt.data)) as ClientMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case "screen.watch": {
            if (watching.has(msg.botId)) return;
            sendTo(w, { type: "screen.state", state: computer.getState(msg.botId) });
            const unwatch = computer.watch(msg.botId, (f) =>
              sendTo(w, { type: "screen.frame", botId: msg.botId, data: f.data, width: f.width, height: f.height }),
            );
            watching.set(msg.botId, unwatch);
            break;
          }
          case "screen.unwatch":
            watching.get(msg.botId)?.();
            watching.delete(msg.botId);
            break;
          case "screen.control":
            void computer.setControl(msg.botId, msg.enabled).catch((err) => sendTo(w, { type: "error", message: String(err) }));
            break;
          case "screen.input":
            // The panel sends down + up + click for one physical click; down/up already click the page.
            if (msg.input.kind === "mouse" && msg.input.action === "click") break;
            void computer.input(msg.botId, msg.input).catch((err) => sendTo(w, { type: "error", message: String(err) }));
            break;
        }
      },
      onClose(_evt, ws) {
        clients.delete(ws as unknown as WsLike);
        for (const unwatch of watching.values()) unwatch();
        watching.clear();
      },
    };
  }),
);

// Everything else: the web app for phones.
app.use("*", rendererHandler(RENDERER_DIR));

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: err.message }, 500);
});

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`cadre server listening on http://localhost:${info.port}  (data: ${DATA_DIR})`);
  console.log(`phone access: ${access.hosts().map((h) => `http://${h}:${info.port}`).join("  ")}  (scan the QR in Settings → Phone)`);
});
injectWebSocket(server);

const shutdown = () => {
  void runtime.shutdown();
  void computer.shutdown().finally(() => {
    store.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
