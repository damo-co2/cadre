import { z } from "zod";

// ---------- Providers / models ----------

export const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "openrouter",
  "ollama",
  "claude-code",
  "codex",
  "gemini-cli",
  "opencode",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderKind = "api" | "cli";

export interface ProviderInfo {
  id: ProviderId;
  kind: ProviderKind;
  label: string;
  /** Short line shown under the label in Settings → Models. */
  blurb: string;
  /** api: has a stored key; cli: binary found + logged in. */
  status: "ready" | "needs-key" | "needs-signin" | "not-installed" | "error" | "off";
  statusDetail?: string;
  /** Turned off in Settings → Models. Cadre won't use it even when it is signed in. */
  disabled?: boolean;
  hasKey?: boolean;
  baseUrl?: string;
  /** Suggested default model id for this provider. */
  defaultModel: string;
}

/** "provider:model" string used everywhere a model is referenced. */
export type ModelRef = `${ProviderId}:${string}`;

export function parseModelRef(ref: string): { provider: ProviderId; model: string } {
  const i = ref.indexOf(":");
  if (i < 0) throw new Error(`Invalid model ref: ${ref}`);
  const provider = ref.slice(0, i) as ProviderId;
  if (!PROVIDER_IDS.includes(provider)) throw new Error(`Unknown provider in model ref: ${ref}`);
  return { provider, model: ref.slice(i + 1) };
}

export function makeModelRef(provider: ProviderId, model: string): ModelRef {
  return `${provider}:${model}`;
}

// ---------- Bots ----------

export const AVATAR_SHAPES = ["circle", "square", "squircle", "hexagon"] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export const AVATAR_COLORS = [
  "#7c5cff",
  "#ff5c8a",
  "#ff9f43",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#eab308",
  "#f43f5e",
] as const;

export interface Bot {
  id: string;
  name: string;
  label: string | null;
  avatarShape: AvatarShape;
  avatarColor: string;
  avatarImage: string | null; // data URL or file path
  modelRef: string | null; // null = use default model from settings
  isPrimary: boolean;
  pinned: boolean;
  hidden: boolean;
  section: string | null;
  sortOrder: number;
  /** Role brief: the Bot's standing job description, injected into its system prompt. */
  brief: string | null;
  /** Id of the Chief of Staff that hired this Bot; null when the user created it. */
  hiredBy: string | null;
  /** The space this Bot belongs to (Work, Personal, …). */
  spaceId: string;
  createdAt: string;
  updatedAt: string;
}

/** A separate area of the team (e.g. Work, Personal) with its own default model and lead Bot. */
export interface Space {
  id: string;
  name: string;
  emoji: string;
  /** Model for this space's Bots that have no model of their own; null = the app default. */
  defaultModelRef: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const createSpaceSchema = z.object({
  name: z.string().trim().min(1).max(40),
  emoji: z.string().trim().min(1).max(8).default("•"),
  defaultModelRef: z.string().nullable().optional(),
});
export const updateSpaceSchema = createSpaceSchema.partial().extend({ sortOrder: z.number().int().optional() });

export const MAX_BRIEF_LENGTH = 6000;

export const createBotSchema = z.object({
  name: z.string().trim().min(1).max(60),
  avatarShape: z.enum(AVATAR_SHAPES).default("circle"),
  avatarColor: z.string().default(AVATAR_COLORS[0]),
  label: z.string().trim().max(60).optional(),
  modelRef: z.string().optional(),
  brief: z.string().trim().max(MAX_BRIEF_LENGTH).optional(),
  spaceId: z.string().optional(),
});
export type CreateBotInput = z.infer<typeof createBotSchema>;

export const updateBotSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  label: z.string().trim().max(60).nullable().optional(),
  avatarShape: z.enum(AVATAR_SHAPES).optional(),
  avatarColor: z.string().optional(),
  avatarImage: z.string().nullable().optional(),
  modelRef: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
  pinned: z.boolean().optional(),
  hidden: z.boolean().optional(),
  section: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  brief: z.string().trim().max(MAX_BRIEF_LENGTH).nullable().optional(),
  spaceId: z.string().optional(),
});
export type UpdateBotInput = z.infer<typeof updateBotSchema>;

// ---------- Conversations / messages ----------

export type ConversationKind = "direct" | "group";

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string | null;
  botIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type MessageRole = "user" | "bot" | "system";
export type MessageStatus = "streaming" | "done" | "error" | "stopped";

/** A file the user attached to a message, or a file a Bot produced. Served at /api/files/:id. */
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export const MAX_ATTACHMENTS_PER_MESSAGE = 20;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 250 * 1024 * 1024;

/** Structured pieces of a bot message, rendered as cards in the transcript. */
export type MessagePart =
  | { type: "text"; text: string }
  /** A file in the Bot's workspace (created or changed by a tool); served at /api/workspace?path=… */
  | { type: "file"; path: string; name: string; size?: number; mimeType?: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown; status: "running" | "done" | "error" | "awaiting-approval" }
  | { type: "tool-result"; id: string; name: string; output: unknown; isError?: boolean }
  | { type: "approval"; approvalId: string }
  | { type: "secure-form"; requestId: string }
  | { type: "status"; text: string };

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  botId: string | null;
  content: string; // plain text (concatenated text parts) for quick rendering/search
  parts: MessagePart[];
  attachments: Attachment[];
  status: MessageStatus;
  error: string | null;
  modelRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export const sendMessageSchema = z.object({
  content: z.string().max(100_000).default(""),
  /** Ids returned by POST /api/uploads. */
  attachmentIds: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
});

export const MIN_GROUP_BOTS = 2;
export const MAX_GROUP_BOTS = 10;

export const createGroupSchema = z.object({
  botIds: z.array(z.string()).min(MIN_GROUP_BOTS).max(MAX_GROUP_BOTS),
  title: z.string().trim().max(80).optional(),
});

export const updateConversationSchema = z.object({
  title: z.string().trim().max(80).nullable().optional(),
  botIds: z.array(z.string()).min(MIN_GROUP_BOTS).max(MAX_GROUP_BOTS).optional(),
});

/** Parses @Name mentions (case-insensitive; names may contain spaces when quoted) and @everyone. */
export function parseMentions(text: string, names: string[]): { mentioned: string[]; everyone: boolean } {
  const everyone = /(^|\s)@everyone\b/i.test(text);
  const lower = text.toLowerCase();
  const mentioned = names.filter((n) => {
    const needle = `@${n.toLowerCase()}`;
    const i = lower.indexOf(needle);
    if (i < 0) return false;
    const after = lower[i + needle.length];
    return after === undefined || !/[a-z0-9_]/.test(after);
  });
  return { mentioned, everyone };
}

// ---------- Settings ----------

export interface AppSettings {
  defaultModelRef: string | null;
  /** Cheap model used for Auto Review / memory rewrite. null = deterministic rules only. */
  utilityModelRef: string | null;
  appearance: "system" | "light" | "dark";
  accent: "bot" | "black";
  timezone: string | null; // null = auto-detect
  autoReview: boolean;
  /** Commands run without asking when macOS confines their writes to the sandbox folder (~/Cadre). */
  sandboxAutoRun: boolean;
  /** Settings → Computer → Your computer → "Execution on this computer". */
  localExecution: "ask" | "always" | "never";
  /** Show the Bot's browser window on the host instead of headless (debugging aid). */
  headedBrowser: boolean;
  /** Most Bots one Chief of Staff may hire in 24 hours; 0 = no limit. */
  hireLimitPerDay: number;
  /** Most Bots in total (all spaces) before a Chief can't hire more; 0 = no limit. */
  teamSizeLimit: number;
  /** Bots learn about the user (who they are, likes, routines) from chats. Settings → About you. */
  learnAboutMe: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultModelRef: null,
  utilityModelRef: null,
  appearance: "system",
  accent: "bot",
  timezone: null,
  autoReview: true,
  sandboxAutoRun: true,
  localExecution: "ask",
  headedBrowser: false,
  hireLimitPerDay: 0,
  teamSizeLimit: 0,
  learnAboutMe: true,
};

export const updateSettingsSchema = z.object({
  defaultModelRef: z.string().nullable().optional(),
  utilityModelRef: z.string().nullable().optional(),
  appearance: z.enum(["system", "light", "dark"]).optional(),
  accent: z.enum(["bot", "black"]).optional(),
  timezone: z.string().nullable().optional(),
  autoReview: z.boolean().optional(),
  sandboxAutoRun: z.boolean().optional(),
  localExecution: z.enum(["ask", "always", "never"]).optional(),
  headedBrowser: z.boolean().optional(),
  hireLimitPerDay: z.number().int().min(0).max(1000).optional(),
  teamSizeLimit: z.number().int().min(0).max(10000).optional(),
  learnAboutMe: z.boolean().optional(),
});

// ---------- About you (the user's profile, shared by Bots) ----------

export const PROFILE_CATEGORIES = ["about", "likes", "routines", "people", "style"] as const;
export type ProfileCategory = (typeof PROFILE_CATEGORIES)[number];
export const PROFILE_CATEGORY_LABELS: Record<ProfileCategory, string> = {
  about: "Who you are",
  likes: "What you like and don't",
  routines: "Your routines",
  people: "People and places",
  style: "How you like things done",
};

/** One thing Bots know about the user. spaceId null = every space; source "you" = the user said or wrote it. */
export interface ProfileFact {
  id: string;
  text: string;
  category: ProfileCategory;
  spaceId: string | null;
  source: "learned" | "you";
  createdAt: string;
  updatedAt: string;
}

export const createProfileFactSchema = z.object({
  text: z.string().trim().min(1).max(500),
  category: z.enum(PROFILE_CATEGORIES).default("about"),
  spaceId: z.string().nullable().optional(),
});
export const updateProfileFactSchema = z.object({
  text: z.string().trim().min(1).max(500).optional(),
  category: z.enum(PROFILE_CATEGORIES).optional(),
  spaceId: z.string().nullable().optional(),
});

export const updateProviderSchema = z.object({
  apiKey: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
  disabled: z.boolean().optional(),
});

// ---------- The Bot's computer (screens) ----------

/** Fixed virtual screen size for every Bot screen; frames and input coordinates use this space. */
export const SCREEN_SIZE = { width: 1280, height: 800 } as const;

export type ScreenStatus = "off" | "starting" | "ready" | "reconnecting" | "error";

export interface ScreenState {
  botId: string;
  status: ScreenStatus;
  url: string | null;
  title: string | null;
  /** A computer-use tool call is running on this screen (one at a time). */
  busy: boolean;
  /** The user has taken control; the Bot's tool calls wait until "I'm done". */
  controlledByUser: boolean;
  width: number;
  height: number;
  error?: string;
  /** Teach a task: a recording of the user's actions is in progress. */
  recording?: { id: string; startedAt: string; events: number; description: string } | null;
}

// ---------- Bot templates & squads ----------

export type TemplateCategory = "leadership" | "work" | "research" | "engineering" | "monitoring" | "life" | "creative";

/** A ready-made Bot: role brief, seed memory, routines (cron/webhook), skills and Auto Review rules. */
export interface BotTemplate {
  id: string;
  name: string;
  /** Role shown under the name, e.g. "Chief of Staff". */
  label: string;
  category: TemplateCategory;
  emoji: string;
  color: string;
  shape: AvatarShape;
  /** One line for the gallery card. */
  tagline: string;
  /** The role brief: seeded into the Bot's memory and used to introduce itself. */
  brief: string;
  /** Extra memory facts seeded at creation. */
  memory: string[];
  routines: {
    name: string;
    /** 5-field cron in the app timezone; omit for a webhook routine. */
    cron?: string;
    webhook?: boolean;
    instruction: string;
    /** Default true. Templates whose routine needs user input first ship it paused. */
    enabled?: boolean;
  }[];
  skills: { name: string; description: string; content: string }[];
  rules: { kind: "allow" | "ask"; tool: string; match: string; text: string }[];
  /** Questions the Bot asks the user right after creation (it needs these to do its job). */
  asks: string[];
  /** Suggested as the primary Bot (Chief of Staff). */
  primary?: boolean;
}

/** Several Bots created together with a group chat; the first template is the lead. */
export interface SquadTemplate {
  id: string;
  name: string;
  emoji: string;
  tagline: string;
  botTemplateIds: string[];
  groupTitle: string;
  /** First message posted into the group as the user; "{lead}" becomes the lead Bot's @name. */
  kickoff: string;
}

export interface TemplateCatalog {
  bots: BotTemplate[];
  squads: SquadTemplate[];
}

export const createFromTemplateSchema = z.object({
  /** Override the template's name. */
  name: z.string().trim().min(1).max(60).optional(),
  modelRef: z.string().optional(),
  /** Create the template's routines (default true). */
  withRoutines: z.boolean().default(true),
  /** Make it the primary Bot (default: template.primary when there is no primary yet). */
  makePrimary: z.boolean().optional(),
  /** Wake it so it introduces itself and asks its setup questions (default true). */
  introduce: z.boolean().default(true),
  /** Space to create it in (default: the first space). */
  spaceId: z.string().optional(),
});
export type CreateFromTemplateInput = z.infer<typeof createFromTemplateSchema>;

export const createSquadSchema = z.object({
  modelRef: z.string().optional(),
  withRoutines: z.boolean().default(true),
  spaceId: z.string().optional(),
});

// ---------- Task board ----------

export const TASK_STATUSES = ["open", "doing", "blocked", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** A GitHub pull request a Bot mentioned (opened, pushed to, or reported on); shown on Team pulse. */
export interface PullRequestLink {
  url: string;
  /** "owner/repo" */
  repo: string;
  number: number;
  /** Bot that mentioned it most recently. */
  botId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  mentions: number;
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;

/** GitHub pull request links in some text, as canonical URLs (…/pull/170/files → …/pull/170). */
export function findPullRequestUrls(text: string): { url: string; repo: string; number: number }[] {
  const out = new Map<string, { url: string; repo: string; number: number }>();
  for (const m of text.matchAll(PR_URL)) {
    const repo = `${m[1]}/${m[2]}`;
    const url = `https://github.com/${repo}/pull/${m[3]}`;
    out.set(url.toLowerCase(), { url, repo, number: Number(m[3]) });
  }
  return [...out.values()];
}

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** A unit of delegated work: who owns it, its state, and what came of it. */
export interface Task {
  id: string;
  title: string;
  detail: string;
  /** Bot that owns it; null = the user. */
  ownerBotId: string | null;
  /** Bot that created it; null = the user. */
  createdBy: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  detail: z.string().max(8000).default(""),
  ownerBotId: z.string().nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).default("normal"),
  dueAt: z.string().nullable().optional(),
});
export const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  detail: z.string().max(8000).optional(),
  ownerBotId: z.string().nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: z.string().nullable().optional(),
  result: z.string().max(8000).nullable().optional(),
});

// ---------- Phone access (Settings → Phone) ----------

/** Returned only to localhost callers. The URL carries the token once; the server then sets a cookie. */
export interface AccessInfo {
  /** Best LAN URL, e.g. http://192.168.1.20:3123/?token=… */
  url: string;
  /** All candidate URLs (one per non-loopback interface). */
  urls: string[];
  /** Inline SVG of the QR code for `url`. */
  qrSvg: string;
  port: number;
  /** When the current token was created. */
  rotatedAt: string;
}

/** Name of the cookie / header that remote (non-loopback) clients authenticate with. */
export const ACCESS_COOKIE = "cadre_access";

// ---------- Teach a task ----------

export const TEACH_MAX_MS = 10 * 60 * 1000;
export const TEACH_MAX_FRAMES = 40;

export type TeachEvent =
  | { t: number; kind: "navigate"; url: string; title: string }
  | { t: number; kind: "click"; x: number; y: number; target: string; url: string }
  | { t: number; kind: "type"; text: string; target: string }
  | { t: number; kind: "key"; key: string }
  | { t: number; kind: "scroll"; deltaY: number }
  | { t: number; kind: "note"; text: string };

export interface TeachRecording {
  id: string;
  botId: string;
  description: string;
  startedAt: string;
  endedAt: string | null;
  events: TeachEvent[];
  /** Workspace-relative paths of the captured frames (jpeg), in order. */
  frames: string[];
}

export const startTeachSchema = z.object({
  description: z.string().trim().min(1).max(500),
});

export type ScreenInput =
  | { kind: "mouse"; action: "move" | "down" | "up" | "click" | "dblclick"; x: number; y: number; button?: "left" | "right" | "middle"; modifiers?: string[] }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "key"; action: "down" | "up" | "press"; key: string; modifiers?: string[] }
  | { kind: "text"; text: string }
  | { kind: "navigate"; url: string };

/** Tool names the sandbox exposes to every model driver (API tools and MCP share these). */
export const COMPUTER_TOOL_NAMES = [
  "browser_navigate",
  "browser_read_page",
  "browser_find",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_back",
  "browser_get_text",
  "browser_screenshot",
  "shell_run",
  "fs_read",
  "fs_write",
  "fs_list",
] as const;
export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number];

/** Tools that never change anything; Auto Review lets them through without a card. */
export const READ_ONLY_TOOLS: readonly ComputerToolName[] = [
  "browser_read_page",
  "browser_find",
  "browser_get_text",
  "browser_screenshot",
  "browser_scroll",
  "browser_back",
  "fs_read",
  "fs_list",
];

// ---------- Approvals (Auto Review) ----------

export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired";
export type ApprovalDecision = "allow" | "always" | "deny";

export interface Approval {
  id: string;
  conversationId: string;
  botId: string;
  messageId: string;
  toolName: string;
  input: unknown;
  /** One line, in the user's words: what the Bot wants to do. */
  summary: string;
  /** Grok Bot's warning banners, e.g. "This can't be undone". */
  warnings: string[];
  status: ApprovalStatus;
  /** The rule that decided it, when not decided by the user. */
  rule: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
}

export const APPROVAL_TTL_MS = 30 * 60 * 1000;
export const MAX_CUSTOM_RULES_PER_KIND = 20;
export const MAX_RULE_LENGTH = 1000;

export interface CustomRule {
  id: string;
  kind: "allow" | "ask";
  /** Tool name this rule applies to, or "*" for any tool. */
  tool: string;
  /** Case-insensitive substring that must appear in the JSON-serialised input ("" = any). */
  match: string;
  /** Human-readable description shown in Settings → Custom Rules. */
  text: string;
  createdAt: string;
}

export const createRuleSchema = z.object({
  kind: z.enum(["allow", "ask"]),
  tool: z.string().min(1).max(80).default("*"),
  match: z.string().max(MAX_RULE_LENGTH).default(""),
  text: z.string().min(1).max(MAX_RULE_LENGTH),
});

export const decideApprovalSchema = z.object({
  decision: z.enum(["allow", "always", "deny"]),
});

// ---------- Skills ----------

/** "A reusable set of instructions for how to do a task." Shared by every Bot. */
export interface Skill {
  id: string;
  /** Short unique handle, e.g. "weekly-competitor-digest". Used with / in the composer. */
  name: string;
  description: string;
  /** Markdown: when to use it, inputs, steps, validation, output, approval points. */
  content: string;
  source: "written" | "taught";
  createdAt: string;
  updatedAt: string;
}

export const skillNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes only");

export const upsertSkillSchema = z.object({
  name: skillNameSchema,
  description: z.string().trim().min(1).max(300),
  content: z.string().min(1).max(50_000),
  source: z.enum(["written", "taught"]).default("written"),
});

// ---------- Routines ----------

export const MAX_ROUTINES_PER_BOT = 50;
export const MAX_ROUTINE_RUNS_PER_HOUR = 200;
export const MAX_ACCOUNT_RUNS_PER_HOUR = 300;
export const MIN_ROUTINE_SPACING_MIN = 5;
export const ROUTINE_RUN_HISTORY = 20;

export type RoutineTrigger =
  | { kind: "schedule"; cron: string }
  | { kind: "webhook" }
  | { kind: "manual" };

export interface Routine {
  id: string;
  botId: string;
  name: string;
  /** What the Bot should do each run, in the user's words. */
  instruction: string;
  trigger: RoutineTrigger;
  timezone: string | null; // null = app timezone / auto
  enabled: boolean;
  /** Secret for webhook triggers (POST /api/hooks/:id with Authorization: Bearer <key>). */
  webhookKey: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RoutineRunStatus = "running" | "done" | "error" | "skipped";

export interface RoutineRun {
  id: string;
  routineId: string;
  status: RoutineRunStatus;
  source: "schedule" | "webhook" | "test";
  conversationId: string | null;
  messageId: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export const routineTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), cron: z.string().trim().min(9).max(100) }),
  z.object({ kind: z.literal("webhook") }),
  z.object({ kind: z.literal("manual") }),
]);

export const createRoutineSchema = z.object({
  name: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(10_000),
  trigger: routineTriggerSchema,
  timezone: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
});

export const updateRoutineSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  instruction: z.string().trim().min(1).max(10_000).optional(),
  trigger: routineTriggerSchema.optional(),
  timezone: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

// ---------- Vault (Settings → Vault) ----------

export type VaultKind = "login" | "card" | "contact" | "secret";

/** What the desktop (and the model) may see: never the secret fields themselves. */
export interface VaultItem {
  id: string;
  kind: VaultKind;
  title: string;
  website: string | null; // login
  username: string | null; // login
  nameOnCard: string | null; // card
  last4: string | null; // card
  expiry: string | null; // card (MM/YY)
  contact: { name?: string; address?: string; phone?: string; email?: string } | null; // contact
  /** Free text telling Bots when to use this entry. */
  hints: string | null;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export const createVaultItemSchema = z.object({
  kind: z.enum(["login", "card", "contact", "secret"]),
  title: z.string().trim().min(1).max(120),
  website: z.string().trim().max(300).optional(),
  username: z.string().trim().max(200).optional(),
  password: z.string().max(2000).optional(),
  number: z.string().trim().max(32).optional(),
  expiry: z.string().trim().max(7).optional(),
  securityCode: z.string().trim().max(8).optional(),
  nameOnCard: z.string().trim().max(120).optional(),
  billingAddress: z.string().trim().max(500).optional(),
  contact: z.object({ name: z.string().optional(), address: z.string().optional(), phone: z.string().optional(), email: z.string().optional() }).optional(),
  /** Generic secret value (API key, token). */
  value: z.string().max(10_000).optional(),
  hints: z.string().trim().max(500).optional(),
});
export type CreateVaultItemInput = z.infer<typeof createVaultItemSchema>;

export const updateVaultItemSchema = createVaultItemSchema.partial().omit({ kind: true });

// ---------- Secure Form: a Bot asks the user for a secret without ever seeing it ----------

export interface SecureFormField {
  key: string;
  label: string;
  secret: boolean; // masked input
}

export interface SecureFormRequest {
  id: string;
  conversationId: string;
  botId: string;
  messageId: string;
  /** Why the Bot needs it, in its words ("Sign in to Acme", "API key for Linear"). */
  label: string;
  fields: SecureFormField[];
  /** Vault kind the answer is saved as. */
  saveAs: VaultKind;
  status: "pending" | "filled" | "cancelled" | "expired";
  /** The Vault item created when filled. */
  vaultItemId: string | null;
  createdAt: string;
  expiresAt: string;
}

export const fillSecureFormSchema = z.object({
  values: z.record(z.string(), z.string().max(10_000)),
  title: z.string().trim().max(120).optional(),
});

// ---------- Connect apps (MCP servers the user adds) ----------

export type ConnectorTransport = "http" | "stdio";

export interface AppConnector {
  id: string;
  /** Slug used as the tool prefix: <name>__<tool>. */
  name: string;
  label: string;
  transport: ConnectorTransport;
  url: string | null;
  command: string | null;
  args: string[];
  /** Env var names stored (values encrypted, never returned). */
  envKeys: string[];
  hasBearerToken: boolean;
  enabled: boolean;
  status: "connected" | "needs-auth" | "error" | "disabled" | "unknown";
  statusDetail: string | null;
  /** When status is needs-auth: the app's sign-in page to open in the browser. */
  authUrl: string | null;
  /** Signed in through the browser (tokens stored). */
  signedIn: boolean;
  tools: { name: string; description: string }[];
  createdAt: string;
  updatedAt: string;
}

export const connectorNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, dashes, underscores");

export const createConnectorSchema = z.object({
  name: connectorNameSchema,
  label: z.string().trim().min(1).max(80),
  transport: z.enum(["http", "stdio"]),
  url: z.string().trim().url().optional(),
  command: z.string().trim().max(300).optional(),
  args: z.array(z.string().max(300)).max(30).default([]),
  env: z.record(z.string(), z.string().max(10_000)).default({}),
  bearerToken: z.string().max(10_000).optional(),
  enabled: z.boolean().default(true),
});

export const updateConnectorSchema = createConnectorSchema.partial().omit({ name: true, transport: true });

/** Connector catalogue shown under Connect apps → Browse (well-known MCP servers; user supplies auth). */
export interface ConnectorTemplate {
  name: string;
  label: string;
  blurb: string;
  emoji: string;
  category: "Work" | "Engineering" | "Docs & files" | "Sales & support" | "Personal";
  /** browser: click Connect, sign in on the app's page. token: paste one token (tokenUrl says where to make it). */
  signIn: "browser" | "token";
  tokenUrl?: string;
  tokenHint?: string;
  /** Connect through another catalog app (e.g. Gmail through Zapier); `match` finds its tools there. */
  connectAs?: string;
  match?: string;
  /** Signs in through an app the owner registered with this vendor (see OAUTH_APPS), with these scopes. */
  oauthApp?: string;
  scopes?: string[];
  /** Another catalog app that can stand in (e.g. Zapier) when the vendor app isn't set up. */
  fallback?: string;
  transport: ConnectorTransport;
  url?: string;
  command?: string;
  args?: string[];
  envKeys?: string[];
}

// ---------- Realtime events (server → desktop over WebSocket) ----------

export type BotStatus = "idle" | "working" | "typing" | "needs-attention";

export type ServerEvent =
  | { type: "task.updated"; task: Task }
  | { type: "task.deleted"; taskId: string }
  | { type: "hello"; serverTime: string }
  | { type: "bot.updated"; bot: Bot }
  | { type: "bot.deleted"; botId: string }
  | { type: "bot.status"; botId: string; status: BotStatus }
  | { type: "conversation.updated"; conversation: Conversation }
  | { type: "message.created"; message: Message }
  | { type: "message.delta"; messageId: string; conversationId: string; text: string }
  | { type: "message.part"; messageId: string; conversationId: string; part: MessagePart }
  | { type: "message.done"; message: Message }
  /** A Bot chose to stay quiet in a group: its empty reply is removed. */
  | { type: "message.deleted"; messageId: string; conversationId: string }
  /** Something the user should notice while away: desktop notification + badge material. */
  | { type: "notify"; botId: string; conversationId: string; title: string; body: string; kind: "reply" | "needs-attention" }
  | { type: "conversation.deleted"; conversationId: string }
  | { type: "screen.state"; state: ScreenState }
  /** JPEG frame, base64. Only sent to clients that are watching that screen. */
  | { type: "screen.frame"; botId: string; data: string; width: number; height: number }
  | { type: "approval.requested"; approval: Approval }
  | { type: "approval.resolved"; approval: Approval }
  | { type: "secureform.requested"; request: SecureFormRequest }
  | { type: "secureform.resolved"; request: SecureFormRequest }
  | { type: "vault.updated"; item: VaultItem }
  | { type: "vault.deleted"; itemId: string }
  | { type: "connector.updated"; connector: AppConnector }
  | { type: "connector.deleted"; connectorId: string }
  | { type: "space.updated"; space: Space }
  | { type: "space.deleted"; spaceId: string }
  | { type: "profile.updated"; learned?: string[] }
  | { type: "routine.updated"; routine: Routine }
  | { type: "routine.deleted"; routineId: string; botId: string }
  | { type: "routine.run"; run: RoutineRun }
  | { type: "skill.updated"; skill: Skill }
  | { type: "skill.deleted"; skillId: string }
  | { type: "error"; message: string; conversationId?: string };

/** Messages the desktop sends to the server over the same WebSocket. */
export type ClientMessage =
  | { type: "screen.watch"; botId: string }
  | { type: "screen.unwatch"; botId: string }
  | { type: "screen.control"; botId: string; enabled: boolean }
  | { type: "screen.input"; botId: string; input: ScreenInput };

export interface ModelListing {
  provider: ProviderId;
  models: { id: string; label?: string }[];
  source: "live" | "curated";
}
