import { Hono } from "hono";
import { createConnectorSchema, createVaultItemSchema, fillSecureFormSchema, updateConnectorSchema, updateVaultItemSchema } from "@grokbot/shared";
import { CONNECTOR_TEMPLATES, OAUTH_APPS } from "@grokbot/agent-runtime";
import type { AppEnv } from "../context.js";

// ---------- Vault ----------

export const vaultRoutes = new Hono<AppEnv>();

vaultRoutes.get("/", (c) => c.json(c.get("store").vault.list()));

vaultRoutes.post("/", async (c) => {
  const parsed = createVaultItemSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const item = c.get("store").vault.create(parsed.data);
  c.get("emit")({ type: "vault.updated", item });
  return c.json(item, 201);
});

vaultRoutes.patch("/:id", async (c) => {
  const parsed = updateVaultItemSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const item = c.get("store").vault.update(c.req.param("id"), parsed.data);
  if (!item) return c.json({ error: "Not found" }, 404);
  c.get("emit")({ type: "vault.updated", item });
  return c.json(item);
});

vaultRoutes.delete("/:id", (c) => {
  c.get("store").vault.delete(c.req.param("id"));
  c.get("emit")({ type: "vault.deleted", itemId: c.req.param("id") });
  return c.body(null, 204);
});

/** CSV import for 1Password, Chrome/Edge, Safari, Firefox, Bitwarden and LastPass exports. */
vaultRoutes.post("/import-csv", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { csv?: string };
  if (!body.csv || body.csv.length > 5 * 1024 * 1024) return c.json({ error: "Send { csv } under 5 MB" }, 400);
  const rows = parseCsv(body.csv);
  if (rows.length < 2) return c.json({ error: "No rows found" }, 400);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iTitle = col("title", "name", "account");
  const iUrl = col("url", "website", "login_uri", "urls", "website url");
  const iUser = col("username", "login_username", "user name", "email");
  const iPass = col("password", "login_password");
  const iNotes = col("notes", "note", "extra");
  if (iPass < 0) return c.json({ error: "No password column found" }, 400);
  const store = c.get("store");
  let imported = 0;
  for (const r of rows.slice(1)) {
    const password = r[iPass]?.trim();
    if (!password) continue;
    const website = iUrl >= 0 ? r[iUrl]?.trim() : "";
    const title = (iTitle >= 0 && r[iTitle]?.trim()) || website?.replace(/^https?:\/\//, "").split("/")[0] || "Imported login";
    const item = store.vault.create({
      kind: "login",
      title,
      website: website || undefined,
      username: iUser >= 0 ? r[iUser]?.trim() || undefined : undefined,
      password,
      hints: iNotes >= 0 && r[iNotes]?.trim() ? r[iNotes].trim().slice(0, 500) : undefined,
    });
    c.get("emit")({ type: "vault.updated", item });
    imported++;
  }
  return c.json({ imported });
});

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.length)) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.length)) rows.push(row);
  return rows;
}

// ---------- Secure Forms ----------

export const secureFormRoutes = new Hono<AppEnv>();

secureFormRoutes.get("/", (c) => c.json(c.get("store").secureForms.list((c.req.query("status") as "pending" | undefined) ?? "pending")));

secureFormRoutes.post("/:id/fill", async (c) => {
  const parsed = fillSecureFormSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const r = c.get("runtime").vault.fill(c.req.param("id"), parsed.data.values, parsed.data.title);
  return r ? c.json(r) : c.json({ error: "Not found" }, 404);
});

secureFormRoutes.post("/:id/cancel", (c) => {
  const r = c.get("runtime").vault.cancel(c.req.param("id"));
  return r ? c.json(r) : c.json({ error: "Not found" }, 404);
});

// ---------- Connectors ----------

export const connectorRoutes = new Hono<AppEnv>();

connectorRoutes.get("/", (c) => c.json(c.get("runtime").connectors.describeAll()));
connectorRoutes.get("/templates", (c) => c.json(CONNECTOR_TEMPLATES));

connectorRoutes.post("/", async (c) => {
  const parsed = createConnectorSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const store = c.get("store");
  if (store.connectors.getByName(parsed.data.name)) return c.json({ error: "A connector with that name exists" }, 400);
  if (parsed.data.transport === "http" && !parsed.data.url) return c.json({ error: "http connectors need a url" }, 400);
  if (parsed.data.transport === "stdio" && !parsed.data.command) return c.json({ error: "stdio connectors need a command" }, 400);
  const row = store.connectors.create(parsed.data);
  return c.json(await c.get("runtime").connectors.connect(row.id), 201);
});

connectorRoutes.patch("/:id", async (c) => {
  const parsed = updateConnectorSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const row = c.get("store").connectors.update(c.req.param("id"), parsed.data);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(await c.get("runtime").connectors.connect(row.id));
});

connectorRoutes.post("/:id/test", async (c) => {
  if (!c.get("store").connectors.get(c.req.param("id"))) return c.json({ error: "Not found" }, 404);
  return c.json(await c.get("runtime").connectors.connect(c.req.param("id")));
});

/** Vendor apps the owner registers once (Google): setup steps and whether it's done. */
connectorRoutes.get("/oauth-apps", (c) => {
  const store = c.get("store");
  const redirectUri = c.get("runtime").connectors.callbackUrl;
  return c.json(
    Object.entries(OAUTH_APPS).map(([id, app]) => {
      const oc = store.oauthClients.get(id);
      return { id, label: app.label, docsUrl: app.docsUrl, steps: app.steps, redirectUri, configured: !!oc, clientIdHint: oc ? `…${oc.clientId.slice(-12)}` : null };
    }),
  );
});

connectorRoutes.put("/oauth-apps/:id", async (c) => {
  const id = c.req.param("id");
  if (!OAUTH_APPS[id]) return c.json({ error: "Unknown app" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { clientId?: string; clientSecret?: string };
  const clientId = body.clientId?.trim() ?? "";
  const clientSecret = body.clientSecret?.trim() ?? "";
  if (id === "google" && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) return c.json({ error: "That doesn't look like a Google Client ID (it ends in .apps.googleusercontent.com)." }, 400);
  if (!clientSecret) return c.json({ error: "Paste the Client secret too." }, 400);
  const before = c.get("store").oauthClients.get(id);
  c.get("store").oauthClients.set(id, clientId, clientSecret);
  // A different Client ID (or secret) can't use sign-ins made with the old one: start them fresh.
  const changed = !!before && (before.clientId !== clientId || before.clientSecret !== clientSecret);
  await c.get("runtime").connectors.reconnectOAuthApp(id, changed);
  return c.json({ ok: true });
});

connectorRoutes.delete("/oauth-apps/:id", async (c) => {
  c.get("store").oauthClients.delete(c.req.param("id"));
  await c.get("runtime").connectors.reconnectOAuthApp(c.req.param("id"));
  return c.body(null, 204);
});

/** One click: create the catalog app (or reuse it) and connect. The reply carries authUrl to open. */
connectorRoutes.post("/templates/:name/connect", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: string; via?: "fallback" };
  const picked = CONNECTOR_TEMPLATES.find((x) => x.name === c.req.param("name"));
  const standIn = picked?.connectAs ?? (body.via === "fallback" ? picked?.fallback : undefined);
  const t = standIn ? CONNECTOR_TEMPLATES.find((x) => x.name === standIn) : picked;
  if (!t) return c.json({ error: "Unknown app" }, 404);
  const store = c.get("store");
  const runtime = c.get("runtime");
  if (t.oauthApp && !store.oauthClients.get(t.oauthApp)) {
    return c.json({ error: `Set up ${OAUTH_APPS[t.oauthApp]?.label ?? t.oauthApp} sign-in first (one time).`, needsSetup: t.oauthApp }, 409);
  }
  const token = typeof body.token === "string" && body.token.trim() ? body.token.trim() : undefined;
  if (t.signIn === "token" && !token && !store.connectors.getByName(t.name)?.bearerToken) return c.json({ error: `${t.label} needs a token` }, 400);
  const existing = store.connectors.getByName(t.name);
  if (existing) {
    store.connectors.update(existing.id, { enabled: true, ...(token ? { bearerToken: token } : {}) });
    if (t.oauthApp) runtime.connectors.useOAuthApp(existing.id, t.oauthApp, t.scopes ?? []);
    return c.json(await runtime.connectors.connect(existing.id));
  }
  const row = store.connectors.create({
    name: t.name,
    label: t.label,
    transport: t.transport,
    url: t.url,
    command: t.command,
    args: t.args ?? [],
    env: {},
    bearerToken: token,
    enabled: true,
  });
  if (t.oauthApp) runtime.connectors.useOAuthApp(row.id, t.oauthApp, t.scopes ?? []);
  return c.json(await runtime.connectors.connect(row.id), 201);
});

connectorRoutes.post("/:id/signout", async (c) => {
  const d = await c.get("runtime").connectors.signOut(c.req.param("id"));
  return d ? c.json(d) : c.json({ error: "Not found" }, 404);
});

connectorRoutes.delete("/:id", async (c) => {
  await c.get("runtime").connectors.disconnect(c.req.param("id"));
  c.get("store").connectors.delete(c.req.param("id"));
  c.get("emit")({ type: "connector.deleted", connectorId: c.req.param("id") });
  return c.body(null, 204);
});
