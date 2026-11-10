import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { auth as runOAuth, UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomUUID } from "node:crypto";
import type { ConnectorRow, Store } from "@grokbot/db";
import type { ToolCallResult } from "@grokbot/sandbox";
import type { AppConnector, ConnectorTemplate, ServerEvent } from "@grokbot/shared";
import type { RuntimeToolSpec } from "./automation.js";

/**
 * "Connect apps": every connector is an MCP server the user added (Gmail, Slack, Notion,
 * GitHub, Linear… or a custom one). Its tools join the Bot's tool surface as
 * `<connector>__<tool>` and go through Auto Review like everything else.
 */

export const CONNECTOR_TEMPLATES: ConnectorTemplate[] = [
  {"name": "jira", "label": "Jira & Confluence", "emoji": "🟦", "category": "Work", "signIn": "browser", "blurb": "Issues, sprints and Confluence pages in your Atlassian sites.", "transport": "http", "url": "https://mcp.atlassian.com/v2/mcp"},
  {"name": "trello", "label": "Trello", "emoji": "📋", "category": "Work", "signIn": "browser", "blurb": "Boards, lists and cards.", "transport": "http", "url": "https://mcp.trello.com/v1"},
  {"name": "linear", "label": "Linear", "emoji": "📐", "category": "Work", "signIn": "browser", "blurb": "Issues, projects and cycles.", "transport": "http", "url": "https://mcp.linear.app/mcp"},
  {"name": "todoist", "label": "Todoist", "emoji": "✅", "category": "Work", "signIn": "browser", "blurb": "Tasks and projects.", "transport": "http", "url": "https://ai.todoist.net/mcp"},
  {"name": "calendly", "label": "Calendly", "emoji": "📅", "category": "Work", "signIn": "browser", "blurb": "Event types, bookings and availability.", "transport": "http", "url": "https://mcp.calendly.com"},
  {"name": "fireflies", "label": "Fireflies", "emoji": "🎙️", "category": "Work", "signIn": "browser", "blurb": "Meeting transcripts and summaries.", "transport": "http", "url": "https://api.fireflies.ai/mcp"},
  {"name": "granola", "label": "Granola", "emoji": "🥣", "category": "Work", "signIn": "browser", "blurb": "Your meeting notes.", "transport": "http", "url": "https://mcp.granola.ai/mcp"},
  {"name": "zapier", "label": "Zapier", "emoji": "⚡", "category": "Work", "signIn": "browser", "blurb": "Gmail, Google Calendar, Slack, Outlook and 8,000 more apps through your Zapier account.", "transport": "http", "url": "https://mcp.zapier.com/api/v1/connect"},
  {"name": "gmail", "label": "Gmail", "emoji": "✉️", "category": "Personal", "signIn": "browser", "blurb": "Read, search, label and draft email. Bots ask before sending.", "transport": "http", "url": "https://gmailmcp.googleapis.com/mcp/v1", "oauthApp": "google", "scopes": ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.compose"], "fallback": "zapier", "match": "gmail"},
  {"name": "google-calendar", "label": "Google Calendar", "emoji": "📆", "category": "Personal", "signIn": "browser", "blurb": "Events, free time and invites.", "transport": "http", "url": "https://calendarmcp.googleapis.com/mcp/v1", "oauthApp": "google", "scopes": ["https://www.googleapis.com/auth/calendar"], "fallback": "zapier", "match": "google_calendar|gcal|calendar"},
  {"name": "slack", "label": "Slack", "emoji": "💬", "category": "Work", "signIn": "browser", "blurb": "One click through Zapier: sign in to Zapier, then switch on Slack there.", "transport": "http", "connectAs": "zapier", "match": "slack"},
  {"name": "outlook", "label": "Outlook", "emoji": "📧", "category": "Personal", "signIn": "browser", "blurb": "One click through Zapier: sign in to Zapier, then switch on Microsoft Outlook there.", "transport": "http", "connectAs": "zapier", "match": "outlook|microsoft"},
  {"name": "google-drive", "label": "Google Drive", "emoji": "🗂️", "category": "Docs & files", "signIn": "browser", "blurb": "Search, read and create files.", "transport": "http", "url": "https://drivemcp.googleapis.com/mcp/v1", "oauthApp": "google", "scopes": ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file"], "fallback": "zapier", "match": "google_drive|gdrive|drive"},
  {"name": "notion", "label": "Notion", "emoji": "📝", "category": "Docs & files", "signIn": "browser", "blurb": "Pages, databases and search across your workspace.", "transport": "http", "url": "https://mcp.notion.com/mcp"},
  {"name": "airtable", "label": "Airtable", "emoji": "🗂️", "category": "Docs & files", "signIn": "browser", "blurb": "Bases, tables and records.", "transport": "http", "url": "https://mcp.airtable.com/mcp"},
  {"name": "webflow", "label": "Webflow", "emoji": "🌐", "category": "Docs & files", "signIn": "browser", "blurb": "Sites, pages and CMS collections.", "transport": "http", "url": "https://mcp.webflow.com/sse"},
  {"name": "wix", "label": "Wix", "emoji": "🧱", "category": "Docs & files", "signIn": "browser", "blurb": "Your Wix sites, store and bookings.", "transport": "http", "url": "https://mcp.wix.com/sse"},
  {"name": "sentry", "label": "Sentry", "emoji": "🐞", "category": "Engineering", "signIn": "browser", "blurb": "Errors and performance issues.", "transport": "http", "url": "https://mcp.sentry.dev/mcp"},
  {"name": "vercel", "label": "Vercel", "emoji": "▲", "category": "Engineering", "signIn": "browser", "blurb": "Projects, deployments and logs.", "transport": "http", "url": "https://mcp.vercel.com"},
  {"name": "netlify", "label": "Netlify", "emoji": "🛰️", "category": "Engineering", "signIn": "browser", "blurb": "Sites, deploys and forms.", "transport": "http", "url": "https://netlify-mcp.netlify.app/mcp"},
  {"name": "supabase", "label": "Supabase", "emoji": "🟩", "category": "Engineering", "signIn": "browser", "blurb": "Projects, databases and edge functions.", "transport": "http", "url": "https://mcp.supabase.com/mcp"},
  {"name": "cloudflare", "label": "Cloudflare", "emoji": "☁️", "category": "Engineering", "signIn": "browser", "blurb": "Workers, KV, R2 and D1.", "transport": "http", "url": "https://bindings.mcp.cloudflare.com/mcp"},
  {"name": "posthog", "label": "PostHog", "emoji": "🦔", "category": "Engineering", "signIn": "browser", "blurb": "Product analytics, flags and experiments.", "transport": "http", "url": "https://mcp.posthog.com/mcp"},
  {"name": "huggingface", "label": "Hugging Face", "emoji": "🤗", "category": "Engineering", "signIn": "browser", "blurb": "Search models, datasets and Spaces. No sign-in needed.", "transport": "http", "url": "https://huggingface.co/mcp"},
  {"name": "github", "label": "GitHub", "emoji": "🐙", "category": "Engineering", "signIn": "token", "blurb": "Issues, pull requests and repos.", "transport": "http", "url": "https://api.githubcopilot.com/mcp/", "tokenUrl": "https://github.com/settings/personal-access-tokens/new", "tokenHint": "fine-grained, pick the repos Bots may use"},
  {"name": "stripe", "label": "Stripe", "emoji": "💳", "category": "Sales & support", "signIn": "browser", "blurb": "Customers, payments and invoices. Bots ask before changing anything.", "transport": "http", "url": "https://mcp.stripe.com"},
  {"name": "paypal", "label": "PayPal", "emoji": "🅿️", "category": "Sales & support", "signIn": "browser", "blurb": "Invoices, orders and disputes.", "transport": "http", "url": "https://mcp.paypal.com/mcp"},
  {"name": "square", "label": "Square", "emoji": "⬛", "category": "Sales & support", "signIn": "browser", "blurb": "Payments, orders and catalog.", "transport": "http", "url": "https://mcp.squareup.com/sse"},
  {"name": "intercom", "label": "Intercom", "emoji": "🗨️", "category": "Sales & support", "signIn": "browser", "blurb": "Conversations, contacts and help articles.", "transport": "http", "url": "https://mcp.intercom.com/mcp"},
];

/**
 * Vendors that don't let apps register themselves. The owner registers Cadre once (an "OAuth
 * client") and pastes its ID and secret; after that every app from that vendor is one click.
 */
export const OAUTH_APPS: Record<string, { label: string; docsUrl: string; steps: { text: string; url?: string; copy?: "redirect" }[] }> = {
  google: {
    label: "Google",
    docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    steps: [
      { text: "Create a Google Cloud project (any name, e.g. Cadre).", url: "https://console.cloud.google.com/projectcreate" },
      { text: "Turn on Google's Workspace MCP servers for that project (Gmail, Calendar and Drive MCP APIs). Google's guide lists the switches.", url: "https://developers.google.com/workspace/guides/configure-mcp-servers" },
      { text: "Set up the sign-in screen: choose External, add your own email as a test user, then click Publish app so sign-ins don't expire after 7 days.", url: "https://console.cloud.google.com/auth/overview" },
      { text: "Create an OAuth client: type Web application, and add this as an authorised redirect URI. If Google offers an option for AI agents, tick it.", url: "https://console.cloud.google.com/auth/clients/create", copy: "redirect" },
      { text: "Copy the Client ID and Client secret Google shows you, and paste them below." },
    ],
  },
};


interface Live {
  client: Client;
  tools: { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean }[];
}

const READ_VERBS = /^(get|list|search|read|fetch|find|query|describe|show|lookup|count|view|check)/i;

export class ConnectorManager {
  private live = new Map<string, Live>(); // connector id → session
  private status = new Map<string, { status: AppConnector["status"]; detail: string | null; authUrl?: string | null }>();

  constructor(
    private store: Store,
    private emit: (e: ServerEvent) => void,
    /** Where app sign-in pages send the browser back to (GET /oauth/callback on this server). */
    private redirectUrl: string,
  ) {}

  async start(): Promise<void> {
    for (const c of this.store.connectors.list()) if (c.enabled) void this.connect(c.id).catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.live.keys()]) await this.disconnect(id);
  }

  describe(c: ConnectorRow): AppConnector {
    const st = this.status.get(c.id) ?? { status: c.enabled ? "unknown" : "disabled", detail: null };
    return {
      id: c.id,
      name: c.name,
      label: c.label,
      transport: c.transport,
      url: c.url,
      command: c.command,
      args: c.args,
      envKeys: Object.keys(c.env),
      hasBearerToken: !!c.bearerToken,
      enabled: c.enabled,
      status: c.enabled ? st.status : "disabled",
      statusDetail: st.detail,
      authUrl: c.enabled && st.status === "needs-auth" ? (st.authUrl ?? null) : null,
      signedIn: !!(this.store.connectors.getAuth(c.id)?.tokens),
      tools: (this.live.get(c.id)?.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  describeAll(): AppConnector[] {
    return this.store.connectors.list().map((c) => this.describe(c));
  }

  async connect(id: string): Promise<AppConnector> {
    const c = this.store.connectors.get(id);
    if (!c) throw new Error("Unknown connector");
    await this.disconnect(id);
    this.httpWarnings.delete(id);
    if (!c.enabled) {
      this.status.set(id, { status: "disabled", detail: null });
      return this.announce(c);
    }
    try {
      let client = new Client({ name: "cadre", version: "0.1.0" });
      if (c.transport === "http") {
        if (!c.url) throw new Error("No URL");
        client = await this.connectHttp(c);
      } else {
        if (!c.command) throw new Error("No command");
        await client.connect(
          new StdioClientTransport({ command: c.command, args: c.args, env: { ...(process.env as Record<string, string>), ...c.env }, stderr: "ignore" }),
        );
      }
      const listed = await client.listTools();
      const tools = listed.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
        // Apps mark lookups read-only (MCP tool annotations); those skip the approval prompt.
        readOnly: t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true,
      }));
      this.live.set(id, { client, tools });
      const warn = this.httpWarnings.get(id);
      this.status.set(id, { status: "connected", detail: `${tools.length} tools${warn ? ` · the app answered with ${warn}, so its tools may fail` : ""}` });
    } catch (err) {
      const msg = connectError(err);
      const authUrl = this.authUrls.get(id) ?? null;
      if (err instanceof UnauthorizedError || authUrl) {
        this.status.set(id, { status: "needs-auth", detail: `Sign in to ${c.label} in your browser to finish connecting.`, authUrl });
      } else {
        this.status.set(id, { status: /401|403|unauthori[sz]ed/i.test(msg) ? "needs-auth" : "error", detail: msg.slice(0, 300) });
      }
    }
    return this.announce(c);
  }

  private authUrls = new Map<string, string>();

  /** The address apps send the browser back to; vendor apps (Google) must list it exactly. */
  get callbackUrl(): string {
    return this.redirectUrl;
  }

  /** Reconnect every connector that signs in through this owner-registered vendor app. */
  /** Reconnect every app that signs in through this vendor app. `resetSignIns`: its Client ID changed, so old sign-ins are void. */
  async reconnectOAuthApp(oauthApp: string, resetSignIns = false): Promise<void> {
    for (const c of this.store.connectors.list()) {
      if (this.store.connectors.getAuth(c.id)?.oauthApp !== oauthApp) continue;
      if (resetSignIns) await this.signOut(c.id);
      else await this.connect(c.id);
    }
  }

  /** The last non-2xx reply each app sent that still carried a good answer (Google's MCP servers do this). */
  private httpWarnings = new Map<string, string>();

  /**
   * Some apps (Google's MCP servers) send a good JSON-RPC answer with an error status such as 403.
   * The MCP client drops those, so pass them on as 200 and remember the status to show the user.
   */
  private tolerantFetch(id: string): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(input, init);
      if (res.ok || res.status === 401 || init?.method !== "POST") return res;
      const wwwAuth = res.headers.get("www-authenticate") ?? "";
      if (/insufficient_scope/i.test(wwwAuth)) return res;
      const text = await res.clone().text().catch(() => "");
      let good = false;
      try {
        const j = JSON.parse(text) as { jsonrpc?: string; result?: unknown };
        good = j?.jsonrpc === "2.0" && j.result !== undefined;
      } catch {
        good = false;
      }
      if (!good) return res;
      this.httpWarnings.set(id, `HTTP ${res.status}${wwwAuth ? ` (${wwwAuth.slice(0, 200)})` : ""}`);
      return new Response(text, { status: 200, headers: res.headers });
    }) as typeof fetch;
  }

  /** Streamable HTTP first, then legacy SSE; browser sign-in (OAuth) unless a bearer token is set. */
  private async connectHttp(c: ConnectorRow): Promise<Client> {
    const url = new URL(c.url!);
    const auth = c.bearerToken ? authorizationHeader(c.bearerToken) : null;
    const headers: Record<string, string> = auth ? { Authorization: auth } : {};
    const authProvider = c.bearerToken ? undefined : this.oauthProvider(c);
    this.authUrls.delete(c.id);
    const a = this.store.connectors.getAuth(c.id) ?? {};
    if (typeof a.oauthApp === "string") {
      const app = OAUTH_APPS[a.oauthApp];
      if (!this.store.oauthClients.get(a.oauthApp)) throw new Error(`Set up ${app?.label ?? a.oauthApp} sign-in first (one time).`);
      // These servers list tools without signing in, so ask for sign-in up front instead of mid-task.
      if (!a.tokens && authProvider && (await runOAuth(authProvider, { serverUrl: url })) === "REDIRECT") throw new UnauthorizedError();
    }
    const client = new Client({ name: "cadre", version: "0.1.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { authProvider, requestInit: { headers }, fetch: this.tolerantFetch(c.id) }));
      this.saveAuth(c.id, { transport: "http" });
      return client;
    } catch (err) {
      if (err instanceof UnauthorizedError || this.authUrls.has(c.id)) throw err;
      const msg = (err as Error).message ?? "";
      if (!/404|405|not found|method not allowed|unexpected content type|text\/event-stream/i.test(msg)) throw err;
    }
    const sse = new Client({ name: "cadre", version: "0.1.0" });
    await sse.connect(new SSEClientTransport(url, { authProvider, requestInit: { headers } }));
    this.saveAuth(c.id, { transport: "sse" });
    return sse;
  }

  /**
   * Finishes a browser sign-in: the app redirected to /oauth/callback?code&state. Swaps the code
   * for tokens (stored encrypted on the connector) and reconnects.
   */
  async finishAuth(state: string, code: string): Promise<AppConnector> {
    const c = this.store.connectors.list().find((x) => this.store.connectors.getAuth(x.id)?.state === state);
    if (!c || !c.url) throw new Error("This sign-in link has expired. Click Connect in Cadre again.");
    const authProvider = this.oauthProvider(c);
    const url = new URL(c.url);
    const kind = this.store.connectors.getAuth(c.id)?.transport;
    const transport = kind === "sse" ? new SSEClientTransport(url, { authProvider }) : new StreamableHTTPClientTransport(url, { authProvider });
    await transport.finishAuth(code);
    this.saveAuth(c.id, { state: undefined });
    return this.connect(c.id);
  }

  /** The app's sign-in page sent back an error (cancelled, access denied). Keep the link for a retry. */
  authFailed(state: string | undefined, error: string, description?: string): { label: string; oauthApp: string | null } | null {
    const c = state ? this.store.connectors.list().find((x) => this.store.connectors.getAuth(x.id)?.state === state) : undefined;
    if (!c) return null;
    const oauthApp = (this.store.connectors.getAuth(c.id)?.oauthApp as string | undefined) ?? null;
    const prev = this.status.get(c.id);
    const detail =
      error === "access_denied" && oauthApp === "google"
        ? "Google said access denied. Check that your Google account is a test user on your Google app, then click Open sign-in page and choose Advanced, then Go to Cadre, if Google warns the app is unverified."
        : `${c.label} sign-in stopped: ${description || error}. Click Open sign-in page to try again.`;
    this.status.set(c.id, { status: "needs-auth", detail, authUrl: prev?.authUrl ?? this.authUrls.get(c.id) ?? null });
    this.announce(c);
    return { label: c.label, oauthApp };
  }

  /**
   * Forget the app's sign-in so the next Connect asks again. Keeps which vendor app (Google) and
   * scopes it signs in with, so the fresh sign-in still goes through that app.
   */
  async signOut(id: string): Promise<AppConnector | null> {
    this.resetAuth(id);
    await this.disconnect(id);
    return this.store.connectors.get(id) ? this.connect(id) : null;
  }

  private resetAuth(id: string): void {
    const a = this.store.connectors.getAuth(id) ?? {};
    const keep = typeof a.oauthApp === "string" ? { oauthApp: a.oauthApp, scopes: a.scopes } : {};
    this.authUrls.delete(id);
    this.store.connectors.setAuth(id, keep);
  }

  /** Marks a connector as signing in through an owner-registered vendor app with these scopes. */
  useOAuthApp(id: string, oauthApp: string, scopes: string[]): void {
    this.saveAuth(id, { oauthApp, scopes });
  }

  private saveAuth(id: string, patch: Record<string, unknown>): void {
    const next = { ...(this.store.connectors.getAuth(id) ?? {}), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    this.store.connectors.setAuth(id, next);
  }

  private oauthProvider(c: ConnectorRow): OAuthClientProvider {
    const get = () => this.store.connectors.getAuth(c.id) ?? {};
    const save = (patch: Record<string, unknown>) => this.saveAuth(c.id, patch);
    const redirectUrl = this.redirectUrl;
    const onRedirect = (u: URL): void => {
      this.authUrls.set(c.id, u.toString());
    };
    return {
      get redirectUrl() {
        return redirectUrl;
      },
      get clientMetadata(): OAuthClientMetadata {
        const scopes = get().scopes as string[] | undefined;
        return {
          ...(scopes?.length ? { scope: scopes.join(" ") } : {}),
          client_name: "Cadre",
          redirect_uris: [redirectUrl],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
      },
      state: () => {
        const st = randomUUID();
        save({ state: st });
        return st;
      },
      clientInformation: () => {
        const a = get();
        // Owner-registered vendor app (Google): use its ID and secret instead of self-registering.
        if (typeof a.oauthApp === "string") {
          const oc = this.store.oauthClients.get(a.oauthApp);
          return oc ? ({ client_id: oc.clientId, ...(oc.clientSecret ? { client_secret: oc.clientSecret } : {}) } as OAuthClientInformationMixed) : undefined;
        }
        return a.client as OAuthClientInformationMixed | undefined;
      },
      saveClientInformation: (info: OAuthClientInformationMixed) => save({ client: info }),
      tokens: () => get().tokens as OAuthTokens | undefined,
      saveTokens: (tokens: OAuthTokens) => save({ tokens }),
      redirectToAuthorization: (u: URL) => {
        const a = get();
        const scopes = a.scopes as string[] | undefined;
        if (scopes?.length) u.searchParams.set("scope", scopes.join(" "));
        // Google only returns a refresh token (sign-in that lasts) with offline access + consent.
        if (a.oauthApp === "google") {
          u.searchParams.set("access_type", "offline");
          u.searchParams.set("prompt", "consent");
        }
        onRedirect(u);
      },
      saveCodeVerifier: (v: string) => save({ verifier: v }),
      codeVerifier: () => {
        const v = get().verifier;
        if (typeof v !== "string") throw new Error("No sign-in in progress");
        return v;
      },
      saveDiscoveryState: (d: OAuthDiscoveryState) => save({ discovery: d }),
      discoveryState: () => get().discovery as OAuthDiscoveryState | undefined,
      invalidateCredentials: (scope: "all" | "client" | "tokens" | "verifier" | "discovery") => {
        if (scope === "all") return this.resetAuth(c.id);
        save(scope === "client" ? { client: undefined } : scope === "tokens" ? { tokens: undefined } : scope === "verifier" ? { verifier: undefined } : { discovery: undefined });
      },
    };
  }

  async disconnect(id: string): Promise<void> {
    const l = this.live.get(id);
    this.live.delete(id);
    if (l) await l.client.close().catch(() => undefined);
  }

  private announce(c: ConnectorRow): AppConnector {
    const d = this.describe(c);
    this.emit({ type: "connector.updated", connector: d });
    return d;
  }

  /** Tools from every connected connector, prefixed, for the Bot's tool surface. */
  specs(): RuntimeToolSpec[] {
    const out: RuntimeToolSpec[] = [];
    for (const c of this.store.connectors.list()) {
      const l = this.live.get(c.id);
      if (!l || !c.enabled) continue;
      for (const t of l.tools) {
        out.push({
          name: `${c.name}__${t.name}`,
          description: `[${c.label}] ${t.description}`.slice(0, 1000),
          inputSchema: t.inputSchema,
          zodShape: {}, // MCP route passes raw JSON through for connector tools
        });
      }
    }
    return out;
  }

  isConnectorTool(name: string): boolean {
    const i = name.indexOf("__");
    return i > 0 && !!this.store.connectors.getByName(name.slice(0, i));
  }

  /** Read-looking connector tools pass Auto Review automatically; everything else asks. */
  isReadOnly(name: string): boolean {
    const i = name.indexOf("__");
    const tool = name.slice(i + 2);
    const c = this.store.connectors.getByName(name.slice(0, i));
    const live = c ? this.live.get(c.id) : undefined;
    if (live?.tools.find((t) => t.name === tool)?.readOnly) return true;
    return READ_VERBS.test(tool);
  }

  async call(name: string, input: unknown): Promise<ToolCallResult> {
    const i = name.indexOf("__");
    const c = this.store.connectors.getByName(name.slice(0, i));
    const l = c && this.live.get(c.id);
    if (!c || !l) return { isError: true, content: [{ type: "text", text: `Connector not connected: ${name}` }] };
    try {
      const r = await l.client.callTool({ name: name.slice(i + 2), arguments: (input ?? {}) as Record<string, unknown> });
      const content = Array.isArray(r.content) ? (r.content as { type: string; text?: string; data?: string; mimeType?: string }[]) : [];
      return {
        isError: r.isError === true,
        content: content.map((p) =>
          p.type === "image" && p.data ? { type: "image" as const, data: p.data, mimeType: p.mimeType ?? "image/png" } : { type: "text" as const, text: p.text ?? JSON.stringify(p) },
        ),
      };
    } catch (err) {
      const msg = (err as Error).message;
      this.status.set(c.id, { status: "error", detail: msg.slice(0, 300) });
      this.announce(c);
      return { isError: true, content: [{ type: "text", text: `${c.label} error: ${msg}` }] };
    }
  }
}

/**
 * The Authorization header for a saved connector token:
 * - "Basic …", "Bearer …" or "Token …": sent exactly as typed;
 * - "user:token" (e.g. a Jenkins username and API token): sent as Basic auth;
 * - base64 of "user:token": sent as Basic auth too;
 * - anything else: a Bearer token.
 */
export function authorizationHeader(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^(basic|bearer|token)\s+\S/i.test(v)) return v;
  if (/^[^\s:]+:\S+$/.test(v) && !/^https?:/i.test(v)) return `Basic ${Buffer.from(v, "utf8").toString("base64")}`;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0) {
    const decoded = Buffer.from(v, "base64").toString("utf8");
    if (/^[^\s:]+:[\x21-\x7e]+$/.test(decoded)) return `Basic ${v}`;
  }
  return `Bearer ${v}`;
}

/** A short, readable reason a connect failed: HTTP status first, never a dump of the app's reply. */
export function connectError(err: unknown): string {
  const raw = (err as Error)?.message ?? String(err);
  const code = typeof (err as { code?: unknown })?.code === "number" ? ((err as { code: number }).code as number) : null;
  const m = /^(?:Streamable HTTP error: )?Error POSTing to endpoint: ([\s\S]*)$/.exec(raw);
  if (!m) return raw;
  const body = m[1].trim();
  let reason = "";
  try {
    const j = JSON.parse(body) as { error?: { message?: string; status?: string }; result?: unknown };
    reason = j.error?.message ?? (j.result !== undefined ? "the app answered, but with an error status" : "");
  } catch {
    reason = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160);
  }
  return `The app replied with HTTP ${code ?? "error"}${reason ? `: ${reason.replace(/\.$/, "")}` : ""}.`;
}
