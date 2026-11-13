import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const bots = sqliteTable("bots", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  label: text("label"),
  avatarShape: text("avatar_shape").notNull().default("circle"),
  avatarColor: text("avatar_color").notNull().default("#7c5cff"),
  avatarImage: text("avatar_image"),
  modelRef: text("model_ref"),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  section: text("section"),
  sortOrder: integer("sort_order").notNull().default(0),
  /** Role brief (from a template or written by the user/Chief of Staff); part of the system prompt. */
  brief: text("brief"),
  /** Bot id of the Chief of Staff that hired this Bot (null = created by the user). */
  hiredBy: text("hired_by"),
  /** The space (Work, Personal, …) this Bot belongs to. */
  spaceId: text("space_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Spaces split the team (e.g. Work and Personal); each has its own default model and lead Bot. */
export const spaces = sqliteTable("spaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  emoji: text("emoji").notNull().default("•"),
  defaultModelRef: text("default_model_ref"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull().default("direct"),
  title: text("title"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const conversationMembers = sqliteTable("conversation_members", {
  conversationId: text("conversation_id").notNull(),
  botId: text("bot_id").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  role: text("role").notNull(),
  botId: text("bot_id"),
  content: text("content").notNull().default(""),
  parts: text("parts").notNull().default("[]"), // JSON
  attachments: text("attachments").notNull().default("[]"), // JSON Attachment[]
  status: text("status").notNull().default("done"),
  error: text("error"),
  modelRef: text("model_ref"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Driver-side session handles (e.g. Claude Code --resume id) per conversation+bot+provider. */
export const driverSessions = sqliteTable("driver_sessions", {
  conversationId: text("conversation_id").notNull(),
  botId: text("bot_id").notNull(),
  provider: text("provider").notNull(),
  sessionId: text("session_id").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  botId: text("bot_id").notNull(),
  messageId: text("message_id").notNull(),
  toolName: text("tool_name").notNull(),
  input: text("input").notNull(), // JSON
  summary: text("summary").notNull(),
  warnings: text("warnings").notNull().default("[]"), // JSON
  status: text("status").notNull().default("pending"),
  rule: text("rule"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const customRules = sqliteTable("custom_rules", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  tool: text("tool").notNull().default("*"),
  match: text("match").notNull().default(""),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Long-term memory. bot_id NULL = facts about the user shared by every Bot (name, timezone…). */
export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  botId: text("bot_id"),
  text: text("text").notNull(),
  /** User facts only: profile section, the space it belongs to (null = every space), who added it. */
  category: text("category"),
  spaceId: text("space_id"),
  source: text("source").notNull().default("learned"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  content: text("content").notNull(),
  source: text("source").notNull().default("written"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Plugins and skills folders from any agent harness (skills, apps and agents read from `path`). */
export const plugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sourceKind: text("source_kind").notNull(), // folder | git
  path: text("path").notNull(),
  url: text("url"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** JSON { serverKey: connectorId } for the apps this plugin added. */
  servers: text("servers").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** A chat's older history condensed by a model, used in place of those messages when the history gets long. */
export const conversationSummaries = sqliteTable("conversation_summaries", {
  conversationId: text("conversation_id").primaryKey(),
  /** The last message the summary covers. */
  throughId: text("through_id").notNull(),
  throughAt: text("through_at").notNull(),
  text: text("text").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Messages the user pinned to come back to (shown on Team pulse). */
export const pins = sqliteTable("pins", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  messageId: text("message_id").notNull().unique(),
  botId: text("bot_id"),
  role: text("role").notNull(),
  text: text("text").notNull(),
  messageAt: text("message_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const routines = sqliteTable("routines", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull(),
  name: text("name").notNull(),
  instruction: text("instruction").notNull(),
  trigger: text("trigger").notNull(), // JSON RoutineTrigger
  timezone: text("timezone"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  webhookKey: text("webhook_key"),
  lastRunAt: text("last_run_at"),
  nextRunAt: text("next_run_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const routineRuns = sqliteTable("routine_runs", {
  id: text("id").primaryKey(),
  routineId: text("routine_id").notNull(),
  status: text("status").notNull(),
  source: text("source").notNull(),
  conversationId: text("conversation_id"),
  messageId: text("message_id"),
  error: text("error"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});

/** Vault: public columns plus one encrypted JSON blob holding every secret field. */
export const vaultItems = sqliteTable("vault_items", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  website: text("website"),
  username: text("username"),
  nameOnCard: text("name_on_card"),
  last4: text("last4"),
  expiry: text("expiry"),
  contact: text("contact"), // JSON
  hints: text("hints"),
  secretEnc: text("secret_enc"), // AES-256-GCM JSON: { password?, number?, securityCode?, billingAddress?, value? }
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const secureForms = sqliteTable("secure_forms", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  botId: text("bot_id").notNull(),
  messageId: text("message_id").notNull(),
  label: text("label").notNull(),
  fields: text("fields").notNull(), // JSON SecureFormField[]
  saveAs: text("save_as").notNull(),
  status: text("status").notNull().default("pending"),
  vaultItemId: text("vault_item_id"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const connectors = sqliteTable("connectors", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  label: text("label").notNull(),
  transport: text("transport").notNull(),
  url: text("url"),
  command: text("command"),
  args: text("args").notNull().default("[]"), // JSON
  envEnc: text("env_enc"), // AES-256-GCM JSON record
  bearerEnc: text("bearer_enc"),
  /** Browser sign-in state for remote apps (OAuth client, tokens, PKCE verifier), encrypted JSON. */
  authEnc: text("auth_enc"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** OAuth apps the owner registered with a vendor (e.g. Google) so its apps can sign in. */
export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(), // "google"
  clientId: text("client_id").notNull(),
  secretEnc: text("secret_enc"),
  updatedAt: text("updated_at").notNull(),
});

export const providerConfigs = sqliteTable("provider_configs", {
  provider: text("provider").primaryKey(),
  apiKeyEnc: text("api_key_enc"), // AES-256-GCM, base64
  baseUrl: text("base_url"),
  /** 1 = turned off in Settings → Models: hidden from pickers and refused at turn time. */
  disabled: integer("disabled").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

/** Additive migrations for databases created before a column existed (ignored when present). */
export const MIGRATIONS_SQL: string[] = [
  "ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE bots ADD COLUMN brief TEXT",
  "ALTER TABLE bots ADD COLUMN hired_by TEXT",
  "ALTER TABLE provider_configs ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE connectors ADD COLUMN auth_enc TEXT",
  "ALTER TABLE bots ADD COLUMN space_id TEXT",
  "ALTER TABLE memories ADD COLUMN category TEXT",
  "ALTER TABLE memories ADD COLUMN space_id TEXT",
  "ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'learned'",
];

/** The team task board: work the user or the Chief of Staff hands to Bots, tracked to done. */
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  detail: text("detail").notNull().default(""),
  ownerBotId: text("owner_bot_id"),
  createdBy: text("created_by"),
  status: text("status").notNull().default("open"),
  priority: text("priority").notNull().default("normal"),
  dueAt: text("due_at"),
  result: text("result"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const uploads = sqliteTable("uploads", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  createdAt: text("created_at").notNull(),
});

export const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  label TEXT,
  avatar_shape TEXT NOT NULL DEFAULT 'circle',
  avatar_color TEXT NOT NULL DEFAULT '#7c5cff',
  avatar_image TEXT,
  model_ref TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  section TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '•',
  default_model_ref TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'direct',
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, bot_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  bot_id TEXT,
  content TEXT NOT NULL DEFAULT '',
  parts TEXT NOT NULL DEFAULT '[]',
  attachments TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'done',
  error TEXT,
  model_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS driver_sessions (
  conversation_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, bot_id, provider)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  summary TEXT NOT NULL,
  warnings TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  rule TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, created_at);
CREATE TABLE IF NOT EXISTS custom_rules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  tool TEXT NOT NULL DEFAULT '*',
  match TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  bot_id TEXT,
  text TEXT NOT NULL,
  category TEXT,
  space_id TEXT,
  source TEXT NOT NULL DEFAULT 'learned',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_bot_idx ON memories(bot_id);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'written',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  path TEXT NOT NULL,
  url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  servers TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id TEXT PRIMARY KEY,
  through_id TEXT NOT NULL,
  through_at TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pins (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  bot_id TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  message_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  instruction TEXT NOT NULL,
  trigger TEXT NOT NULL,
  timezone TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  webhook_key TEXT,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS routines_bot_idx ON routines(bot_id);
CREATE TABLE IF NOT EXISTS routine_runs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  conversation_id TEXT,
  message_id TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS routine_runs_routine_idx ON routine_runs(routine_id, started_at);
CREATE TABLE IF NOT EXISTS vault_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  website TEXT,
  username TEXT,
  name_on_card TEXT,
  last4 TEXT,
  expiry TEXT,
  contact TEXT,
  hints TEXT,
  secret_enc TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS secure_forms (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  label TEXT NOT NULL,
  fields TEXT NOT NULL,
  save_as TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  vault_item_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  transport TEXT NOT NULL,
  url TEXT,
  command TEXT,
  args TEXT NOT NULL DEFAULT '[]',
  env_enc TEXT,
  bearer_enc TEXT,
  auth_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  owner_bot_id TEXT,
  created_by TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  due_at TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  secret_enc TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_configs (
  provider TEXT PRIMARY KEY,
  api_key_enc TEXT,
  base_url TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;
