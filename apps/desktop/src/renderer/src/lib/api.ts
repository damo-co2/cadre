import type {
  ProfileCategory,
  ProfileFact,
  Space,
  Task,
  PullRequestLink,
  Pin,
  AccessInfo,
  AppConnector,
  AppSettings,
  Approval,
  Attachment,
  ApprovalDecision,
  Bot,
  ClientMessage,
  ConnectorTemplate,
  Conversation,
  CreateBotInput,
  CreateFromTemplateInput,
  CreateVaultItemInput,
  CustomRule,
  Message,
  ModelListing,
  ProviderId,
  ProviderInfo,
  Routine,
  RoutineRun,
  RoutineTrigger,
  ScreenState,
  SecureFormRequest,
  ServerEvent,
  Skill,
  InstalledPlugin,
  PluginPreview,
  PluginSuggestion,
  TemplateCatalog,
  UpdateBotInput,
  VaultItem,
} from "@grokbot/shared";

/**
 * Where the API lives. Electron passes it through the preload bridge; a phone browser served by the
 * server itself talks to the origin that served it; the Vite dev server (517x) falls back to localhost.
 */
export const SERVER_URL =
  window.cadre?.serverUrl ??
  (location.protocol.startsWith("http") && !/^517\d$/.test(location.port) ? location.origin : "http://localhost:3123");

/** Direct URL for an uploaded attachment (inline), or a download link with `download`. */
export function fileUrl(id: string, download = false): string {
  return `${SERVER_URL}/api/files/${encodeURIComponent(id)}${download ? "?download=1" : ""}`;
}

/** Direct URL for a file in the Bot's workspace, by relative path. */
export function workspaceUrl(path: string, download = false): string {
  return `${SERVER_URL}/api/workspace?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${SERVER_URL}${path}`, {
    headers: { "content-type": "application/json" },
    credentials: "include",
    ...init,
  });
  if (r.status === 204) return undefined as T;
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `${r.status} ${r.statusText}`);
  return body as T;
}

export interface OAuthAppInfo {
  id: string;
  label: string;
  docsUrl: string;
  steps: { text: string; url?: string; copy?: "redirect" }[];
  redirectUri: string;
  configured: boolean;
  clientIdHint: string | null;
}

export interface CreateRuleInput {
  kind: CustomRule["kind"];
  tool: string;
  match: string;
  text: string;
}

export interface CreateRoutineInput {
  name: string;
  instruction: string;
  trigger: RoutineTrigger;
  timezone?: string | null;
  enabled?: boolean;
}
export type UpdateRoutineInput = Partial<CreateRoutineInput>;

export type UpdateVaultItemInput = Partial<Omit<CreateVaultItemInput, "kind">>;

export interface CreateConnectorInput {
  name: string;
  label: string;
  transport: AppConnector["transport"];
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  bearerToken?: string;
  enabled?: boolean;
}
export type UpdateConnectorInput = Partial<Omit<CreateConnectorInput, "name" | "transport">>;

export interface CreateSquadInput {
  modelRef?: string;
  withRoutines?: boolean;
  spaceId?: string;
}

export interface UpsertSkillInput {
  name: string;
  description: string;
  content: string;
}

export const api = {
  health: () => req<{ ok: boolean }>("/api/health"),
  bots: {
    list: () => req<Bot[]>("/api/bots"),
    create: (input: CreateBotInput) =>
      req<{ bot: Bot; conversation: Conversation }>("/api/bots", { method: "POST", body: JSON.stringify(input) }),
    update: (id: string, patch: UpdateBotInput) =>
      req<Bot>(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    delete: (id: string) => req<void>(`/api/bots/${id}`, { method: "DELETE" }),
    conversation: (id: string) => req<Conversation>(`/api/bots/${id}/conversation`),
  },
  conversations: {
    /** Group conversations only (1:1 chats live under /api/bots/:id/conversation). */
    list: () => req<Conversation[]>("/api/conversations"),
    create: (botIds: string[], title?: string) =>
      req<Conversation>("/api/conversations", { method: "POST", body: JSON.stringify({ botIds, title }) }),
    update: (id: string, patch: { title?: string | null; botIds?: string[] }) =>
      req<Conversation>(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    delete: (id: string) => req<void>(`/api/conversations/${id}`, { method: "DELETE" }),
    /** The newest `limit` messages, or the `limit` before message `before`; oldest first. */
    messages: (id: string, opts: { limit?: number; before?: string } = {}) =>
      req<Message[]>(
        `/api/conversations/${id}/messages${opts.limit ? `?limit=${opts.limit}${opts.before ? `&before=${encodeURIComponent(opts.before)}` : ""}` : ""}`,
      ),
    send: (id: string, input: { content: string; attachmentIds?: string[] }) =>
      req<Message>(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify(input) }),
    stop: (id: string) => req<{ stopped: boolean }>(`/api/conversations/${id}/stop`, { method: "POST" }),
    reset: (id: string) => req<{ ok: boolean }>(`/api/conversations/${id}/reset`, { method: "POST" }),
    compact: (id: string) => req<{ summarized: number }>(`/api/conversations/${id}/compact`, { method: "POST" }),
  },
  defaultModel: (spaceId?: string | null) =>
    req<{ modelRef: string; source: "space" | "app" | "auto"; spaceName: string | null }>(`/api/settings/default-model${spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : ""}`),
  spaces: {
    list: () => req<Space[]>("/api/spaces"),
    create: (input: { name: string; emoji?: string; defaultModelRef?: string | null }) => req<Space>("/api/spaces", { method: "POST", body: JSON.stringify(input) }),
    update: (id: string, patch: Partial<Pick<Space, "name" | "emoji" | "defaultModelRef">>) => req<Space>(`/api/spaces/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    delete: (id: string) => req<void>(`/api/spaces/${id}`, { method: "DELETE" }),
  },
  profile: {
    list: () => req<ProfileFact[]>("/api/profile"),
    add: (input: { text: string; category: ProfileCategory; spaceId?: string | null }) => req<ProfileFact>("/api/profile", { method: "POST", body: JSON.stringify(input) }),
    update: (id: string, patch: { text?: string; category?: ProfileCategory; spaceId?: string | null }) =>
      req<ProfileFact>(`/api/profile/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    remove: (id: string) => req<void>(`/api/profile/${id}`, { method: "DELETE" }),
  },
  providers: {
    list: () => req<ProviderInfo[]>("/api/providers"),
    update: (id: ProviderId, patch: { apiKey?: string | null; baseUrl?: string | null; disabled?: boolean }) =>
      req<ProviderInfo>(`/api/providers/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
    models: (id: ProviderId) => req<ModelListing>(`/api/providers/${id}/models`),
  },
  settings: {
    get: () => req<AppSettings>("/api/settings"),
    update: (patch: Partial<AppSettings>) => req<AppSettings>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
  },
  computer: {
    state: (botId: string) => req<ScreenState>(`/api/bots/${botId}/computer`),
    reset: (botId: string) => req<ScreenState | void>(`/api/bots/${botId}/computer/reset`, { method: "POST" }),
    teachStart: (botId: string, description: string) =>
      req<ScreenState>(`/api/bots/${botId}/teach/start`, { method: "POST", body: JSON.stringify({ description }) }),
    teachStop: (botId: string) =>
      req<{ recording: { id: string; events: number; frames: number } }>(`/api/bots/${botId}/teach/stop`, { method: "POST" }),
  },
  approvals: {
    list: () => req<Approval[]>("/api/approvals?status=pending"),
    decide: (id: string, decision: ApprovalDecision) =>
      req<Approval>(`/api/approvals/${id}`, { method: "POST", body: JSON.stringify({ decision }) }),
  },
  routines: {
    all: () => req<Routine[]>("/api/routines"),
    list: (botId: string) => req<Routine[]>(`/api/bots/${botId}/routines`),
    create: (botId: string, input: CreateRoutineInput) =>
      req<Routine>(`/api/bots/${botId}/routines`, { method: "POST", body: JSON.stringify(input) }),
    update: (id: string, patch: UpdateRoutineInput) =>
      req<Routine>(`/api/routines/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    delete: (id: string) => req<void>(`/api/routines/${id}`, { method: "DELETE" }),
    test: (id: string) => req<RoutineRun>(`/api/routines/${id}/test`, { method: "POST" }),
    runs: (id: string) => req<RoutineRun[]>(`/api/routines/${id}/runs`),
  },
  pullRequests: {
    list: () => req<PullRequestLink[]>("/api/pull-requests"),
  },
  pins: {
    list: () => req<Pin[]>("/api/pins"),
    create: (messageId: string) => req<Pin>("/api/pins", { method: "POST", body: JSON.stringify({ messageId }) }),
    delete: (id: string) => req<void>(`/api/pins/${id}`, { method: "DELETE" }),
  },
  tasks: {
    list: (all = false) => req<Task[]>(`/api/tasks${all ? "?all=1" : ""}`),
    create: (input: { title: string; detail?: string; ownerBotId?: string | null; priority?: Task["priority"] }) =>
      req<Task>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),
    update: (id: string, patch: Partial<Pick<Task, "title" | "detail" | "ownerBotId" | "status" | "priority" | "result">>) =>
      req<Task>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    delete: (id: string) => req<void>(`/api/tasks/${id}`, { method: "DELETE" }),
  },
  skills: {
    list: () => req<Skill[]>("/api/skills"),
    upsert: (input: UpsertSkillInput) => req<Skill>("/api/skills", { method: "PUT", body: JSON.stringify(input) }),
    delete: (id: string) => req<void>(`/api/skills/${id}`, { method: "DELETE" }),
    /** A plugin skill's instructions, read from its folder. */
    pluginContent: (name: string) => req<{ content: string }>(`/api/skills/plugin/${encodeURIComponent(name)}`),
  },
  plugins: {
    list: () => req<InstalledPlugin[]>("/api/plugins"),
    suggestions: () => req<PluginSuggestion[]>("/api/plugins/suggestions"),
    preview: (source: string) => req<PluginPreview>("/api/plugins/preview", { method: "POST", body: JSON.stringify({ source }) }),
    install: (input: { source: string; secrets: Record<string, string>; servers?: string[] }) =>
      req<InstalledPlugin>("/api/plugins", { method: "POST", body: JSON.stringify(input) }),
    refresh: (id: string) => req<InstalledPlugin>(`/api/plugins/${id}/refresh`, { method: "POST" }),
    update: (id: string) => req<InstalledPlugin>(`/api/plugins/${id}/update`, { method: "POST" }),
    setEnabled: (id: string, enabled: boolean) => req<InstalledPlugin>(`/api/plugins/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    remove: (id: string, keepApps = false) => req<void>(`/api/plugins/${id}${keepApps ? "?keepApps=1" : ""}`, { method: "DELETE" }),
  },
  /** Multipart upload; the browser sets the content-type (with boundary) itself. */
  uploads: async (files: File[]): Promise<Attachment[]> => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f, f.name);
    const r = await fetch(`${SERVER_URL}/api/uploads`, { method: "POST", body: fd, credentials: "include" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((body as { error?: string }).error ?? `${r.status} ${r.statusText}`);
    return body as Attachment[];
  },
  vault: {
    list: () => req<VaultItem[]>("/api/vault"),
    create: (input: CreateVaultItemInput) => req<VaultItem>("/api/vault", { method: "POST", body: JSON.stringify(input) }),
    update: (id: string, patch: UpdateVaultItemInput) =>
      req<VaultItem>(`/api/vault/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    delete: (id: string) => req<void>(`/api/vault/${id}`, { method: "DELETE" }),
    importCsv: (csv: string) => req<{ imported: number }>("/api/vault/import-csv", { method: "POST", body: JSON.stringify({ csv }) }),
  },
  secureForms: {
    list: () => req<SecureFormRequest[]>("/api/secureforms?status=pending"),
    fill: (id: string, values: Record<string, string>, title?: string) =>
      req<SecureFormRequest>(`/api/secureforms/${id}/fill`, { method: "POST", body: JSON.stringify({ values, title }) }),
    cancel: (id: string) => req<SecureFormRequest>(`/api/secureforms/${id}/cancel`, { method: "POST" }),
  },
  connectors: {
    list: () => req<AppConnector[]>("/api/connectors"),
    templates: () => req<ConnectorTemplate[]>("/api/connectors/templates"),
    create: (input: CreateConnectorInput) => req<AppConnector>("/api/connectors", { method: "POST", body: JSON.stringify(input) }),
    update: (id: string, patch: UpdateConnectorInput) =>
      req<AppConnector>(`/api/connectors/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    delete: (id: string) => req<void>(`/api/connectors/${id}`, { method: "DELETE" }),
    test: (id: string) => req<AppConnector>(`/api/connectors/${id}/test`, { method: "POST" }),
    connectTemplate: (name: string, token?: string, via?: "fallback") =>
      req<AppConnector>(`/api/connectors/templates/${encodeURIComponent(name)}/connect`, { method: "POST", body: JSON.stringify({ ...(token ? { token } : {}), ...(via ? { via } : {}) }) }),
    oauthApps: () => req<OAuthAppInfo[]>("/api/connectors/oauth-apps"),
    saveOAuthApp: (id: string, clientId: string, clientSecret: string) =>
      req<{ ok: boolean }>(`/api/connectors/oauth-apps/${id}`, { method: "PUT", body: JSON.stringify({ clientId, clientSecret }) }),
    removeOAuthApp: (id: string) => req<void>(`/api/connectors/oauth-apps/${id}`, { method: "DELETE" }),
    signOut: (id: string) => req<AppConnector>(`/api/connectors/${id}/signout`, { method: "POST" }),
  },
  rules: {
    list: () => req<CustomRule[]>("/api/rules"),
    create: (input: CreateRuleInput) => req<CustomRule>("/api/rules", { method: "POST", body: JSON.stringify(input) }),
    delete: (id: string) => req<void>(`/api/rules/${id}`, { method: "DELETE" }),
  },
  templates: {
    list: () => req<TemplateCatalog>("/api/templates"),
    create: (id: string, input: CreateFromTemplateInput) =>
      req<{ bot: Bot; conversation: Conversation; routines: Routine[] }>(`/api/templates/${encodeURIComponent(id)}/create`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    createSquad: (id: string, input: CreateSquadInput) =>
      req<{ bots: Bot[]; conversation: Conversation }>(`/api/templates/squads/${encodeURIComponent(id)}/create`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
  },
  /** Phone access: only answered for localhost callers (the desktop app). */
  access: {
    get: () => req<AccessInfo>("/api/access"),
    rotate: () => req<AccessInfo>("/api/access/rotate", { method: "POST" }),
  },
};

export interface EventsConnection {
  /** Send a message to the server. Queued until the socket is open; the queue is dropped when it closes. */
  send(msg: ClientMessage): void;
  close(): void;
}

export function connectEvents(onEvent: (e: ServerEvent) => void, onStatus: (connected: boolean) => void): EventsConnection {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 500;
  let queue: string[] = [];
  const open = () => {
    if (closed) return;
    ws = new WebSocket(`${SERVER_URL.replace(/^http/, "ws")}/ws`);
    ws.onopen = () => {
      retry = 500;
      const pending = queue;
      queue = [];
      for (const m of pending) ws?.send(m);
      onStatus(true);
    };
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(String(m.data)) as ServerEvent);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      queue = [];
      onStatus(false);
      if (!closed) {
        setTimeout(open, retry);
        retry = Math.min(retry * 2, 8000);
      }
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return {
    send(msg) {
      if (closed) return;
      const data = JSON.stringify(msg);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
      else queue.push(data);
    },
    close() {
      closed = true;
      queue = [];
      ws?.close();
    },
  };
}
