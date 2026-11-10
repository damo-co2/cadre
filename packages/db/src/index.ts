import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, asc, desc, eq, gt, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Task,
  TaskPriority,
  TaskStatus,
  AppConnector,
  AppSettings,
  Approval,
  ApprovalStatus,
  Attachment,
  Bot,
  CreateVaultItemInput,
  SecureFormField,
  SecureFormRequest,
  VaultItem,
  VaultKind,
  Conversation,
  CreateBotInput,
  CustomRule,
  Message,
  MessagePart,
  ProviderId,
  Routine,
  RoutineRun,
  RoutineTrigger,
  Skill,
  Space,
  UpdateBotInput,
  ProfileCategory,
  ProfileFact,
} from "@grokbot/shared";
import { DEFAULT_SETTINGS, PROFILE_CATEGORIES, ROUTINE_RUN_HISTORY } from "@grokbot/shared";
import * as schema from "./schema.js";
import { Secrets } from "./secrets.js";

export * as schema from "./schema.js";
export { Secrets } from "./secrets.js";

export type Db = BetterSQLite3Database<typeof schema>;

export const nowIso = () => new Date().toISOString();
export const newId = () => randomUUID();

export interface Store {
  db: Db;
  secrets: Secrets;
  bots: BotRepo;
  spaces: SpaceRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  settings: SettingsRepo;
  providers: ProviderRepo;
  driverSessions: DriverSessionRepo;
  approvals: ApprovalRepo;
  rules: RuleRepo;
  memories: MemoryRepo;
  skills: SkillRepo;
  routines: RoutineRepo;
  vault: VaultRepo;
  secureForms: SecureFormRepo;
  connectors: ConnectorRepo;
  oauthClients: OAuthClientRepo;
  uploads: UploadRepo;
  tasks: TaskRepo;
  close(): void;
}

export function openStore(dataDir: string): Store {
  mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(join(dataDir, "cadre.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(schema.BOOTSTRAP_SQL);
  for (const sql of schema.MIGRATIONS_SQL) {
    try {
      sqlite.exec(sql);
    } catch {
      /* column already exists */
    }
  }
  const db = drizzle(sqlite, { schema });
  const secrets = new Secrets(join(dataDir, ".keyfile"));
  const store: Store = {
    db,
    secrets,
    bots: new BotRepo(db),
    spaces: new SpaceRepo(db),
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    settings: new SettingsRepo(db),
    providers: new ProviderRepo(db, secrets),
    driverSessions: new DriverSessionRepo(db),
    approvals: new ApprovalRepo(db),
    rules: new RuleRepo(db),
    memories: new MemoryRepo(db),
    skills: new SkillRepo(db),
    routines: new RoutineRepo(db),
    vault: new VaultRepo(db, secrets),
    secureForms: new SecureFormRepo(db),
    connectors: new ConnectorRepo(db, secrets),
    oauthClients: new OAuthClientRepo(db, secrets),
    uploads: new UploadRepo(db),
    tasks: new TaskRepo(db),
    close: () => sqlite.close(),
  };
  store.spaces.ensureDefaults();
  return store;
}

// ---------- Uploads (attachment metadata; bytes live in <dataDir>/files/<id>) ----------

export class UploadRepo {
  constructor(private db: Db) {}

  create(input: { name: string; mimeType: string; size: number }): Attachment {
    const id = newId();
    this.db.insert(schema.uploads).values({ id, ...input, createdAt: nowIso() }).run();
    return { id, name: input.name, mimeType: input.mimeType, size: input.size };
  }

  get(id: string): Attachment | undefined {
    const r = this.db.select().from(schema.uploads).where(eq(schema.uploads.id, id)).get();
    return r ? { id: r.id, name: r.name, mimeType: r.mimeType, size: r.size } : undefined;
  }
}

// ---------- Vault ----------

/** Secret fields, only ever decrypted server-side for filling. */
export interface VaultSecrets {
  password?: string;
  number?: string;
  securityCode?: string;
  billingAddress?: string;
  value?: string;
}

function rowToVaultItem(r: typeof schema.vaultItems.$inferSelect): VaultItem {
  return {
    id: r.id,
    kind: r.kind as VaultKind,
    title: r.title,
    website: r.website,
    username: r.username,
    nameOnCard: r.nameOnCard,
    last4: r.last4,
    expiry: r.expiry,
    contact: r.contact ? (JSON.parse(r.contact) as VaultItem["contact"]) : null,
    hints: r.hints,
    hasSecret: !!r.secretEnc,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class VaultRepo {
  constructor(
    private db: Db,
    private secrets: Secrets,
  ) {}

  list(): VaultItem[] {
    return this.db.select().from(schema.vaultItems).orderBy(asc(schema.vaultItems.kind), asc(schema.vaultItems.title)).all().map(rowToVaultItem);
  }

  get(id: string): VaultItem | undefined {
    const r = this.db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, id)).get();
    return r ? rowToVaultItem(r) : undefined;
  }

  /** Server-side only: decrypted secret fields for filling into a page or a shell env. */
  secretsOf(id: string): VaultSecrets {
    const r = this.db.select({ enc: schema.vaultItems.secretEnc }).from(schema.vaultItems).where(eq(schema.vaultItems.id, id)).get();
    return r?.enc ? (JSON.parse(this.secrets.decrypt(r.enc)) as VaultSecrets) : {};
  }

  create(input: CreateVaultItemInput): VaultItem {
    const ts = nowIso();
    const id = newId();
    const sec = this.packSecrets(input);
    this.db
      .insert(schema.vaultItems)
      .values({
        id,
        kind: input.kind,
        title: input.title,
        website: input.website ?? null,
        username: input.username ?? null,
        nameOnCard: input.nameOnCard ?? null,
        last4: input.number ? input.number.replace(/\D/g, "").slice(-4) || null : null,
        expiry: input.expiry ?? null,
        contact: input.contact ? JSON.stringify(input.contact) : null,
        hints: input.hints ?? null,
        secretEnc: Object.keys(sec).length ? this.secrets.encrypt(JSON.stringify(sec)) : null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return this.get(id)!;
  }

  update(id: string, patch: Partial<CreateVaultItemInput>): VaultItem | undefined {
    const current = this.db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, id)).get();
    if (!current) return undefined;
    const merged: VaultSecrets = { ...(current.secretEnc ? (JSON.parse(this.secrets.decrypt(current.secretEnc)) as VaultSecrets) : {}), ...this.packSecrets(patch) };
    const set: Partial<typeof schema.vaultItems.$inferInsert> = { updatedAt: nowIso() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.website !== undefined) set.website = patch.website;
    if (patch.username !== undefined) set.username = patch.username;
    if (patch.nameOnCard !== undefined) set.nameOnCard = patch.nameOnCard;
    if (patch.expiry !== undefined) set.expiry = patch.expiry;
    if (patch.hints !== undefined) set.hints = patch.hints;
    if (patch.contact !== undefined) set.contact = JSON.stringify(patch.contact);
    if (patch.number !== undefined) set.last4 = patch.number.replace(/\D/g, "").slice(-4) || null;
    set.secretEnc = Object.keys(merged).length ? this.secrets.encrypt(JSON.stringify(merged)) : null;
    this.db.update(schema.vaultItems).set(set).where(eq(schema.vaultItems.id, id)).run();
    return this.get(id);
  }

  delete(id: string): void {
    this.db.delete(schema.vaultItems).where(eq(schema.vaultItems.id, id)).run();
  }

  private packSecrets(input: Partial<CreateVaultItemInput>): VaultSecrets {
    const s: VaultSecrets = {};
    if (input.password) s.password = input.password;
    if (input.number) s.number = input.number;
    if (input.securityCode) s.securityCode = input.securityCode;
    if (input.billingAddress) s.billingAddress = input.billingAddress;
    if (input.value) s.value = input.value;
    return s;
  }
}

// ---------- Secure Form requests ----------

function rowToSecureForm(r: typeof schema.secureForms.$inferSelect): SecureFormRequest {
  return {
    id: r.id,
    conversationId: r.conversationId,
    botId: r.botId,
    messageId: r.messageId,
    label: r.label,
    fields: JSON.parse(r.fields) as SecureFormField[],
    saveAs: r.saveAs as VaultKind,
    status: r.status as SecureFormRequest["status"],
    vaultItemId: r.vaultItemId,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
}

export class SecureFormRepo {
  constructor(private db: Db) {}

  create(input: Omit<SecureFormRequest, "id" | "status" | "vaultItemId" | "createdAt">): SecureFormRequest {
    const id = newId();
    this.db
      .insert(schema.secureForms)
      .values({
        id,
        conversationId: input.conversationId,
        botId: input.botId,
        messageId: input.messageId,
        label: input.label,
        fields: JSON.stringify(input.fields),
        saveAs: input.saveAs,
        status: "pending",
        vaultItemId: null,
        createdAt: nowIso(),
        expiresAt: input.expiresAt,
      })
      .run();
    return this.get(id)!;
  }

  get(id: string): SecureFormRequest | undefined {
    const r = this.db.select().from(schema.secureForms).where(eq(schema.secureForms.id, id)).get();
    return r ? rowToSecureForm(r) : undefined;
  }

  list(status?: SecureFormRequest["status"]): SecureFormRequest[] {
    const q = this.db.select().from(schema.secureForms);
    return (status ? q.where(eq(schema.secureForms.status, status)) : q).orderBy(desc(schema.secureForms.createdAt)).limit(100).all().map(rowToSecureForm);
  }

  resolve(id: string, status: Exclude<SecureFormRequest["status"], "pending">, vaultItemId: string | null = null): SecureFormRequest | undefined {
    this.db
      .update(schema.secureForms)
      .set({ status, vaultItemId })
      .where(and(eq(schema.secureForms.id, id), eq(schema.secureForms.status, "pending")))
      .run();
    return this.get(id);
  }
}

// ---------- Connectors (user-added MCP servers) ----------

export interface ConnectorRow {
  id: string;
  name: string;
  label: string;
  transport: AppConnector["transport"];
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  bearerToken: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export class ConnectorRepo {
  constructor(
    private db: Db,
    private secrets: Secrets,
  ) {}

  private rowToConnector(r: typeof schema.connectors.$inferSelect): ConnectorRow {
    return {
      id: r.id,
      name: r.name,
      label: r.label,
      transport: r.transport as AppConnector["transport"],
      url: r.url,
      command: r.command,
      args: JSON.parse(r.args) as string[],
      env: r.envEnc ? (JSON.parse(this.secrets.decrypt(r.envEnc)) as Record<string, string>) : {},
      bearerToken: r.bearerEnc ? this.secrets.decrypt(r.bearerEnc) : null,
      enabled: r.enabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  list(): ConnectorRow[] {
    return this.db.select().from(schema.connectors).orderBy(asc(schema.connectors.createdAt)).all().map((r) => this.rowToConnector(r));
  }

  get(id: string): ConnectorRow | undefined {
    const r = this.db.select().from(schema.connectors).where(eq(schema.connectors.id, id)).get();
    return r ? this.rowToConnector(r) : undefined;
  }

  getByName(name: string): ConnectorRow | undefined {
    const r = this.db.select().from(schema.connectors).where(eq(schema.connectors.name, name)).get();
    return r ? this.rowToConnector(r) : undefined;
  }

  create(input: {
    name: string;
    label: string;
    transport: AppConnector["transport"];
    url?: string;
    command?: string;
    args: string[];
    env: Record<string, string>;
    bearerToken?: string;
    enabled: boolean;
  }): ConnectorRow {
    const ts = nowIso();
    const id = newId();
    this.db
      .insert(schema.connectors)
      .values({
        id,
        name: input.name,
        label: input.label,
        transport: input.transport,
        url: input.url ?? null,
        command: input.command ?? null,
        args: JSON.stringify(input.args),
        envEnc: Object.keys(input.env).length ? this.secrets.encrypt(JSON.stringify(input.env)) : null,
        bearerEnc: input.bearerToken ? this.secrets.encrypt(input.bearerToken) : null,
        enabled: input.enabled,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return this.get(id)!;
  }

  update(
    id: string,
    patch: Partial<{ label: string; url: string; command: string; args: string[]; env: Record<string, string>; bearerToken: string; enabled: boolean }>,
  ): ConnectorRow | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const set: Partial<typeof schema.connectors.$inferInsert> = { updatedAt: nowIso() };
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.url !== undefined) set.url = patch.url;
    if (patch.command !== undefined) set.command = patch.command;
    if (patch.args !== undefined) set.args = JSON.stringify(patch.args);
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.env !== undefined) {
      const merged = { ...current.env, ...patch.env };
      set.envEnc = Object.keys(merged).length ? this.secrets.encrypt(JSON.stringify(merged)) : null;
    }
    if (patch.bearerToken !== undefined) set.bearerEnc = patch.bearerToken ? this.secrets.encrypt(patch.bearerToken) : null;
    this.db.update(schema.connectors).set(set).where(eq(schema.connectors.id, id)).run();
    return this.get(id);
  }

  delete(id: string): void {
    this.db.delete(schema.connectors).where(eq(schema.connectors.id, id)).run();
  }

  /** Browser sign-in state (OAuth) for a remote app; null when never signed in. */
  getAuth(id: string): Record<string, unknown> | null {
    const r = this.db.select({ authEnc: schema.connectors.authEnc }).from(schema.connectors).where(eq(schema.connectors.id, id)).get();
    if (!r?.authEnc) return null;
    try {
      return JSON.parse(this.secrets.decrypt(r.authEnc)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  setAuth(id: string, data: Record<string, unknown> | null): void {
    const authEnc = data && Object.keys(data).length ? this.secrets.encrypt(JSON.stringify(data)) : null;
    this.db.update(schema.connectors).set({ authEnc, updatedAt: nowIso() }).where(eq(schema.connectors.id, id)).run();
  }
}

// ---------- OAuth apps the owner registered (Google, …) ----------

export class OAuthClientRepo {
  constructor(
    private db: Db,
    private secrets: Secrets,
  ) {}

  get(id: string): { clientId: string; clientSecret: string | null } | null {
    const r = this.db.select().from(schema.oauthClients).where(eq(schema.oauthClients.id, id)).get();
    return r ? { clientId: r.clientId, clientSecret: r.secretEnc ? this.secrets.decrypt(r.secretEnc) : null } : null;
  }

  set(id: string, clientId: string, clientSecret: string | null): void {
    const secretEnc = clientSecret ? this.secrets.encrypt(clientSecret) : null;
    this.db
      .insert(schema.oauthClients)
      .values({ id, clientId, secretEnc, updatedAt: nowIso() })
      .onConflictDoUpdate({ target: schema.oauthClients.id, set: { clientId, secretEnc, updatedAt: nowIso() } })
      .run();
  }

  delete(id: string): void {
    this.db.delete(schema.oauthClients).where(eq(schema.oauthClients.id, id)).run();
  }
}

// ---------- Skills ----------

export class SkillRepo {
  constructor(private db: Db) {}

  list(): Skill[] {
    return this.db
      .select()
      .from(schema.skills)
      .orderBy(asc(schema.skills.name))
      .all()
      .map((r) => ({ ...r, source: r.source as Skill["source"] }));
  }

  get(id: string): Skill | undefined {
    const r = this.db.select().from(schema.skills).where(eq(schema.skills.id, id)).get();
    return r ? { ...r, source: r.source as Skill["source"] } : undefined;
  }

  getByName(name: string): Skill | undefined {
    const r = this.db.select().from(schema.skills).where(eq(schema.skills.name, name)).get();
    return r ? { ...r, source: r.source as Skill["source"] } : undefined;
  }

  upsert(input: { name: string; description: string; content: string; source: Skill["source"] }): Skill {
    const ts = nowIso();
    const existing = this.getByName(input.name);
    if (existing) {
      this.db
        .update(schema.skills)
        .set({ description: input.description, content: input.content, source: input.source, updatedAt: ts })
        .where(eq(schema.skills.id, existing.id))
        .run();
      return this.get(existing.id)!;
    }
    const id = newId();
    this.db.insert(schema.skills).values({ id, ...input, createdAt: ts, updatedAt: ts }).run();
    return this.get(id)!;
  }

  delete(id: string): void {
    this.db.delete(schema.skills).where(eq(schema.skills.id, id)).run();
  }
}

// ---------- Routines ----------

function rowToRoutine(r: typeof schema.routines.$inferSelect): Routine {
  return {
    id: r.id,
    botId: r.botId,
    name: r.name,
    instruction: r.instruction,
    trigger: JSON.parse(r.trigger) as RoutineTrigger,
    timezone: r.timezone,
    enabled: r.enabled,
    webhookKey: r.webhookKey,
    lastRunAt: r.lastRunAt,
    nextRunAt: r.nextRunAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class RoutineRepo {
  constructor(private db: Db) {}

  list(botId?: string): Routine[] {
    const q = this.db.select().from(schema.routines);
    return (botId ? q.where(eq(schema.routines.botId, botId)) : q).orderBy(asc(schema.routines.createdAt)).all().map(rowToRoutine);
  }

  get(id: string): Routine | undefined {
    const r = this.db.select().from(schema.routines).where(eq(schema.routines.id, id)).get();
    return r ? rowToRoutine(r) : undefined;
  }

  countForBot(botId: string): number {
    return this.db.select({ c: sql<number>`count(*)` }).from(schema.routines).where(eq(schema.routines.botId, botId)).get()?.c ?? 0;
  }

  create(input: {
    botId: string;
    name: string;
    instruction: string;
    trigger: RoutineTrigger;
    timezone: string | null;
    enabled: boolean;
    webhookKey: string | null;
    nextRunAt: string | null;
  }): Routine {
    const ts = nowIso();
    const id = newId();
    this.db
      .insert(schema.routines)
      .values({ id, ...input, trigger: JSON.stringify(input.trigger), createdAt: ts, updatedAt: ts })
      .run();
    return this.get(id)!;
  }

  update(
    id: string,
    patch: Partial<Pick<Routine, "name" | "instruction" | "trigger" | "timezone" | "enabled" | "webhookKey" | "lastRunAt" | "nextRunAt">>,
  ): Routine | undefined {
    const set: Partial<typeof schema.routines.$inferInsert> = { updatedAt: nowIso() };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      (set as Record<string, unknown>)[k] = k === "trigger" ? JSON.stringify(v) : v;
    }
    this.db.update(schema.routines).set(set).where(eq(schema.routines.id, id)).run();
    return this.get(id);
  }

  delete(id: string): void {
    this.db.delete(schema.routines).where(eq(schema.routines.id, id)).run();
    this.db.delete(schema.routineRuns).where(eq(schema.routineRuns.routineId, id)).run();
  }

  deleteForBot(botId: string): void {
    for (const r of this.list(botId)) this.delete(r.id);
  }

  // ---- runs ----

  startRun(routineId: string, source: RoutineRun["source"], conversationId: string | null): RoutineRun {
    const id = newId();
    this.db
      .insert(schema.routineRuns)
      .values({ id, routineId, status: "running", source, conversationId, messageId: null, error: null, startedAt: nowIso(), finishedAt: null })
      .run();
    this.trimRuns(routineId);
    return this.getRun(id)!;
  }

  finishRun(id: string, patch: { status: RoutineRun["status"]; messageId?: string | null; error?: string | null }): RoutineRun | undefined {
    this.db
      .update(schema.routineRuns)
      .set({ status: patch.status, messageId: patch.messageId ?? null, error: patch.error ?? null, finishedAt: nowIso() })
      .where(eq(schema.routineRuns.id, id))
      .run();
    return this.getRun(id);
  }

  getRun(id: string): RoutineRun | undefined {
    const r = this.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, id)).get();
    return r ? ({ ...r, status: r.status as RoutineRun["status"], source: r.source as RoutineRun["source"] } as RoutineRun) : undefined;
  }

  runs(routineId: string, limit = ROUTINE_RUN_HISTORY): RoutineRun[] {
    return this.db
      .select()
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.routineId, routineId))
      .orderBy(desc(schema.routineRuns.startedAt))
      .limit(limit)
      .all()
      .map((r) => ({ ...r, status: r.status as RoutineRun["status"], source: r.source as RoutineRun["source"] }) as RoutineRun);
  }

  /** Runs started in the last hour, for rate limits. */
  runsSince(sinceIso: string, routineId?: string): number {
    const q = this.db.select({ c: sql<number>`count(*)` }).from(schema.routineRuns);
    const cond = routineId
      ? and(gt(schema.routineRuns.startedAt, sinceIso), eq(schema.routineRuns.routineId, routineId))
      : gt(schema.routineRuns.startedAt, sinceIso);
    return q.where(cond).get()?.c ?? 0;
  }

  private trimRuns(routineId: string): void {
    const keep = this.runs(routineId, ROUTINE_RUN_HISTORY).map((r) => r.id);
    if (!keep.length) return;
    this.db
      .delete(schema.routineRuns)
      .where(and(eq(schema.routineRuns.routineId, routineId), notInArray(schema.routineRuns.id, keep)))
      .run();
  }
}

// ---------- Memory ----------

export interface MemoryFact {
  id: string;
  botId: string | null;
  text: string;
  category: string | null;
  spaceId: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

function toProfileFact(r: MemoryFact): ProfileFact {
  const category = (PROFILE_CATEGORIES as readonly string[]).includes(r.category ?? "") ? (r.category as ProfileCategory) : "about";
  return { id: r.id, text: r.text, category, spaceId: r.spaceId, source: r.source === "you" ? "you" : "learned", createdAt: r.createdAt, updatedAt: r.updatedAt };
}

export class MemoryRepo {
  constructor(private db: Db) {}

  /** Facts for one Bot (botId) or the shared user facts (null). */
  list(botId: string | null): MemoryFact[] {
    return this.db
      .select()
      .from(schema.memories)
      .where(botId === null ? isNull(schema.memories.botId) : eq(schema.memories.botId, botId))
      .orderBy(asc(schema.memories.createdAt))
      .all();
  }

  /** Replace the whole fact set for a scope (the background rewrite pass owns the list). */
  replace(botId: string | null, facts: string[]): MemoryFact[] {
    const existing = this.list(botId);
    const keep = new Map(existing.map((f) => [f.text, f]));
    const ts = nowIso();
    this.db.delete(schema.memories).where(botId === null ? isNull(schema.memories.botId) : eq(schema.memories.botId, botId)).run();
    for (const text of facts) {
      const prev = keep.get(text);
      this.db
        .insert(schema.memories)
        .values({ id: prev?.id ?? newId(), botId, text, createdAt: prev?.createdAt ?? ts, updatedAt: ts })
        .run();
    }
    return this.list(botId);
  }

  append(botId: string | null, facts: string[]): MemoryFact[] {
    const current = this.list(botId).map((f) => f.text);
    return this.replace(botId, [...current, ...facts.filter((f) => !current.includes(f))]);
  }

  deleteForBot(botId: string): void {
    this.db.delete(schema.memories).where(eq(schema.memories.botId, botId)).run();
  }

  // ----- About you: the user's profile, shared by Bots (rows with bot_id NULL) -----

  /** Everything, or what a Bot in `spaceId` may see: facts for every space plus that space's own. */
  profile(spaceId?: string | null): ProfileFact[] {
    return this.list(null)
      .filter((f) => spaceId === undefined || f.spaceId === null || f.spaceId === spaceId)
      .map(toProfileFact);
  }

  getProfileFact(id: string): ProfileFact | undefined {
    const r = this.db.select().from(schema.memories).where(and(eq(schema.memories.id, id), isNull(schema.memories.botId))).get();
    return r ? toProfileFact(r) : undefined;
  }

  addProfileFact(input: { text: string; category: ProfileCategory; spaceId?: string | null; source: "learned" | "you" }): ProfileFact {
    const text = input.text.trim();
    const spaceId = input.spaceId ?? null;
    // Same words in the same place: refresh the existing fact instead of duplicating it.
    const same = this.list(null).find((f) => f.text.toLowerCase() === text.toLowerCase() && f.spaceId === spaceId);
    if (same) return this.updateProfileFact(same.id, { category: input.category, ...(input.source === "you" ? { source: "you" as const } : {}) })!;
    const ts = nowIso();
    const id = newId();
    this.db.insert(schema.memories).values({ id, botId: null, text, category: input.category, spaceId, source: input.source, createdAt: ts, updatedAt: ts }).run();
    return this.getProfileFact(id)!;
  }

  updateProfileFact(id: string, patch: { text?: string; category?: ProfileCategory; spaceId?: string | null; source?: "learned" | "you" }): ProfileFact | undefined {
    const set: Partial<typeof schema.memories.$inferInsert> = { updatedAt: nowIso() };
    if (patch.text !== undefined) set.text = patch.text.trim();
    if (patch.category !== undefined) set.category = patch.category;
    if (patch.spaceId !== undefined) set.spaceId = patch.spaceId;
    if (patch.source !== undefined) set.source = patch.source;
    this.db.update(schema.memories).set(set).where(and(eq(schema.memories.id, id), isNull(schema.memories.botId))).run();
    return this.getProfileFact(id);
  }

  deleteProfileFact(id: string): boolean {
    return this.db.delete(schema.memories).where(and(eq(schema.memories.id, id), isNull(schema.memories.botId))).run().changes > 0;
  }

  /** A space is going away: its facts become facts for every space rather than being lost. */
  releaseSpace(spaceId: string): void {
    this.db.update(schema.memories).set({ spaceId: null }).where(eq(schema.memories.spaceId, spaceId)).run();
  }
}

// ---------- Approvals ----------

function rowToApproval(r: typeof schema.approvals.$inferSelect): Approval {
  return {
    id: r.id,
    conversationId: r.conversationId,
    botId: r.botId,
    messageId: r.messageId,
    toolName: r.toolName,
    input: JSON.parse(r.input),
    summary: r.summary,
    warnings: JSON.parse(r.warnings) as string[],
    status: r.status as ApprovalStatus,
    rule: r.rule,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    resolvedAt: r.resolvedAt,
  };
}

export class ApprovalRepo {
  constructor(private db: Db) {}

  create(input: Omit<Approval, "id" | "createdAt" | "resolvedAt" | "status"> & { status?: ApprovalStatus }): Approval {
    const id = newId();
    this.db
      .insert(schema.approvals)
      .values({
        id,
        conversationId: input.conversationId,
        botId: input.botId,
        messageId: input.messageId,
        toolName: input.toolName,
        input: JSON.stringify(input.input ?? null),
        summary: input.summary,
        warnings: JSON.stringify(input.warnings),
        status: input.status ?? "pending",
        rule: input.rule,
        createdAt: nowIso(),
        expiresAt: input.expiresAt,
        resolvedAt: null,
      })
      .run();
    return this.get(id)!;
  }

  get(id: string): Approval | undefined {
    const r = this.db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
    return r ? rowToApproval(r) : undefined;
  }

  list(status?: ApprovalStatus, limit = 100): Approval[] {
    const q = this.db.select().from(schema.approvals);
    const rows = (status ? q.where(eq(schema.approvals.status, status)) : q)
      .orderBy(desc(schema.approvals.createdAt))
      .limit(limit)
      .all();
    return rows.map(rowToApproval);
  }

  resolve(id: string, status: Exclude<ApprovalStatus, "pending">, rule: string | null = null): Approval | undefined {
    this.db
      .update(schema.approvals)
      .set({ status, rule, resolvedAt: nowIso() })
      .where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, "pending")))
      .run();
    return this.get(id);
  }

  /** Mark every pending approval past its expiry as expired; returns the ones that changed. */
  expireStale(): Approval[] {
    const now = nowIso();
    const stale = this.db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.status, "pending"), lt(schema.approvals.expiresAt, now)))
      .all();
    for (const r of stale) {
      this.db.update(schema.approvals).set({ status: "expired", resolvedAt: now }).where(eq(schema.approvals.id, r.id)).run();
    }
    return stale.map((r) => ({ ...rowToApproval(r), status: "expired" as const, resolvedAt: now }));
  }
}

// ---------- Custom rules ----------

export class RuleRepo {
  constructor(private db: Db) {}

  list(): CustomRule[] {
    return this.db
      .select()
      .from(schema.customRules)
      .orderBy(asc(schema.customRules.createdAt))
      .all()
      .map((r) => ({ ...r, kind: r.kind as CustomRule["kind"] }));
  }

  /** The same kind of rule for the same tool and match, if one is saved already. */
  findSame(kind: CustomRule["kind"], tool: string, match: string): CustomRule | undefined {
    return this.list().find((r) => r.kind === kind && r.tool === tool && r.match.trim().toLowerCase() === match.trim().toLowerCase());
  }

  /** Remove exact repeats (same kind, tool and match), keeping the oldest; returns how many went. */
  removeDuplicates(): number {
    const seen = new Set<string>();
    let removed = 0;
    for (const r of this.list()) {
      const key = `${r.kind}\u0000${r.tool}\u0000${r.match.trim().toLowerCase()}`;
      if (seen.has(key)) {
        this.delete(r.id);
        removed++;
      } else seen.add(key);
    }
    return removed;
  }

  create(input: { kind: CustomRule["kind"]; tool: string; match: string; text: string }): CustomRule {
    const id = newId();
    this.db.insert(schema.customRules).values({ id, ...input, createdAt: nowIso() }).run();
    return this.list().find((r) => r.id === id)!;
  }

  delete(id: string): void {
    this.db.delete(schema.customRules).where(eq(schema.customRules.id, id)).run();
  }
}

// ---------- Bots ----------

function rowToBot(r: typeof schema.bots.$inferSelect): Bot {
  return {
    id: r.id,
    name: r.name,
    label: r.label,
    avatarShape: r.avatarShape as Bot["avatarShape"],
    avatarColor: r.avatarColor,
    avatarImage: r.avatarImage,
    modelRef: r.modelRef,
    isPrimary: r.isPrimary,
    pinned: r.pinned,
    hidden: r.hidden,
    section: r.section,
    sortOrder: r.sortOrder,
    brief: r.brief ?? null,
    hiredBy: r.hiredBy ?? null,
    spaceId: r.spaceId ?? "",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---------- Spaces ----------

export class SpaceRepo {
  constructor(private db: Db) {}

  list(): Space[] {
    return this.db.select().from(schema.spaces).orderBy(asc(schema.spaces.sortOrder), asc(schema.spaces.createdAt)).all();
  }

  get(id: string): Space | undefined {
    return this.db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
  }

  /** The first space: where Bots without a valid space land. */
  fallback(): Space {
    return this.list()[0] ?? this.create({ name: "Work", emoji: "💼" });
  }

  create(input: { name: string; emoji?: string; defaultModelRef?: string | null }): Space {
    const ts = nowIso();
    const count = this.db.select({ c: sql<number>`count(*)` }).from(schema.spaces).get()?.c ?? 0;
    const row = { id: newId(), name: input.name, emoji: input.emoji ?? "•", defaultModelRef: input.defaultModelRef ?? null, sortOrder: count, createdAt: ts, updatedAt: ts };
    this.db.insert(schema.spaces).values(row).run();
    return row;
  }

  update(id: string, patch: Partial<{ name: string; emoji: string; defaultModelRef: string | null; sortOrder: number }>): Space | undefined {
    this.db.update(schema.spaces).set({ ...patch, updatedAt: nowIso() }).where(eq(schema.spaces.id, id)).run();
    return this.get(id);
  }

  delete(id: string): void {
    this.db.delete(schema.spaces).where(eq(schema.spaces.id, id)).run();
  }

  botCount(id: string): number {
    return this.db.select({ c: sql<number>`count(*)` }).from(schema.bots).where(eq(schema.bots.spaceId, id)).get()?.c ?? 0;
  }

  /** First run: Work and Personal. Bots with no (or a deleted) space go to the first one. */
  ensureDefaults(): void {
    if (!this.list().length) {
      this.create({ name: "Work", emoji: "💼" });
      this.create({ name: "Personal", emoji: "🏡" });
    }
    const ids = this.list().map((s) => s.id);
    const home = ids[0];
    this.db
      .update(schema.bots)
      .set({ spaceId: home })
      .where(or(isNull(schema.bots.spaceId), notInArray(schema.bots.spaceId, ids)))
      .run();
  }
}

export class BotRepo {
  constructor(private db: Db) {}

  list(): Bot[] {
    return this.db
      .select()
      .from(schema.bots)
      .orderBy(asc(schema.bots.sortOrder), asc(schema.bots.createdAt))
      .all()
      .map(rowToBot);
  }

  get(id: string): Bot | undefined {
    const r = this.db.select().from(schema.bots).where(eq(schema.bots.id, id)).get();
    return r ? rowToBot(r) : undefined;
  }

  /** Bots in one space. */
  listInSpace(spaceId: string): Bot[] {
    return this.list().filter((b) => b.spaceId === spaceId);
  }

  /** The space's lead Bot (its Chief of Staff), if any. */
  primaryOf(spaceId: string): Bot | undefined {
    return this.list().find((b) => b.isPrimary && b.spaceId === spaceId);
  }

  create(input: CreateBotInput & { hiredBy?: string | null }): Bot {
    const ts = nowIso();
    const count = this.db.select({ c: sql<number>`count(*)` }).from(schema.bots).get()?.c ?? 0;
    const spaceId =
      (input.spaceId && this.db.select({ id: schema.spaces.id }).from(schema.spaces).where(eq(schema.spaces.id, input.spaceId)).get()?.id) ||
      this.db.select({ id: schema.spaces.id }).from(schema.spaces).orderBy(asc(schema.spaces.sortOrder), asc(schema.spaces.createdAt)).get()?.id ||
      null;

    const row: typeof schema.bots.$inferInsert = {
      id: newId(),
      name: input.name,
      label: input.label ?? null,
      avatarShape: input.avatarShape,
      avatarColor: input.avatarColor,
      modelRef: input.modelRef ?? null,
      brief: input.brief ?? null,
      hiredBy: input.hiredBy ?? null,
      spaceId,
      // Only the very first Bot leads by default. Otherwise a space gets a lead when a Chief of
      // Staff is hired into it or the user picks one: a lead loses the browser and app tools.
      isPrimary: count === 0,
      sortOrder: count,
      createdAt: ts,
      updatedAt: ts,
    };
    this.db.insert(schema.bots).values(row).run();
    return this.get(row.id)!;
  }

  update(id: string, patch: UpdateBotInput): Bot | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const set: UpdateBotInput = { ...patch };
    const target = patch.spaceId ?? current.spaceId;
    if (patch.spaceId && patch.spaceId !== current.spaceId && patch.isPrimary === undefined) {
      // Moving never makes a Bot the lead of its new space, and a moved lead stops leading.
      set.isPrimary = false;
    }
    if (set.isPrimary === true) {
      // One lead per space.
      this.db.update(schema.bots).set({ isPrimary: false }).where(eq(schema.bots.spaceId, target)).run();
    }
    this.db
      .update(schema.bots)
      .set({ ...set, updatedAt: nowIso() })
      .where(eq(schema.bots.id, id))
      .run();
    return this.get(id);
  }

  delete(id: string): void {
    this.db.delete(schema.bots).where(eq(schema.bots.id, id)).run();
    const convs = this.db
      .select({ id: schema.conversationMembers.conversationId })
      .from(schema.conversationMembers)
      .where(eq(schema.conversationMembers.botId, id))
      .all();
    this.db.delete(schema.conversationMembers).where(eq(schema.conversationMembers.botId, id)).run();
    for (const c of convs) {
      const remaining = this.db
        .select({ c: sql<number>`count(*)` })
        .from(schema.conversationMembers)
        .where(eq(schema.conversationMembers.conversationId, c.id))
        .get()?.c;
      if (!remaining) {
        this.db.delete(schema.messages).where(eq(schema.messages.conversationId, c.id)).run();
        this.db.delete(schema.conversations).where(eq(schema.conversations.id, c.id)).run();
      }
    }
    this.db.delete(schema.driverSessions).where(eq(schema.driverSessions.botId, id)).run();
    this.db.delete(schema.memories).where(eq(schema.memories.botId, id)).run();
    for (const r of this.db.select({ id: schema.routines.id }).from(schema.routines).where(eq(schema.routines.botId, id)).all()) {
      this.db.delete(schema.routineRuns).where(eq(schema.routineRuns.routineId, r.id)).run();
    }
    this.db.delete(schema.routines).where(eq(schema.routines.botId, id)).run();
  }
}

// ---------- Conversations ----------

export class ConversationRepo {
  constructor(private db: Db) {}

  private membersOf(conversationId: string): string[] {
    return this.db
      .select({ botId: schema.conversationMembers.botId })
      .from(schema.conversationMembers)
      .where(eq(schema.conversationMembers.conversationId, conversationId))
      .all()
      .map((m) => m.botId);
  }

  private rowToConversation(r: typeof schema.conversations.$inferSelect): Conversation {
    return {
      id: r.id,
      kind: r.kind as Conversation["kind"],
      title: r.title,
      botIds: this.membersOf(r.id),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  get(id: string): Conversation | undefined {
    const r = this.db.select().from(schema.conversations).where(eq(schema.conversations.id, id)).get();
    return r ? this.rowToConversation(r) : undefined;
  }

  list(): Conversation[] {
    return this.db.select().from(schema.conversations).all().map((r) => this.rowToConversation(r));
  }

  /** The single direct conversation for a bot; created on first access. */
  directForBot(botId: string): Conversation {
    const existing = this.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .innerJoin(schema.conversationMembers, eq(schema.conversationMembers.conversationId, schema.conversations.id))
      .where(and(eq(schema.conversations.kind, "direct"), eq(schema.conversationMembers.botId, botId)))
      .get();
    if (existing) return this.get(existing.id)!;
    return this.create("direct", [botId], null);
  }

  create(kind: Conversation["kind"], botIds: string[], title: string | null): Conversation {
    const ts = nowIso();
    const id = newId();
    this.db.insert(schema.conversations).values({ id, kind, title, createdAt: ts, updatedAt: ts }).run();
    for (const botId of botIds) {
      this.db.insert(schema.conversationMembers).values({ conversationId: id, botId }).run();
    }
    return this.get(id)!;
  }

  touch(id: string): void {
    this.db.update(schema.conversations).set({ updatedAt: nowIso() }).where(eq(schema.conversations.id, id)).run();
  }

  listGroups(): Conversation[] {
    return this.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.kind, "group"))
      .orderBy(desc(schema.conversations.updatedAt))
      .all()
      .map((r) => this.rowToConversation(r));
  }

  update(id: string, patch: { title?: string | null; botIds?: string[] }): Conversation | undefined {
    if (patch.title !== undefined) {
      this.db.update(schema.conversations).set({ title: patch.title, updatedAt: nowIso() }).where(eq(schema.conversations.id, id)).run();
    }
    if (patch.botIds) {
      this.db.delete(schema.conversationMembers).where(eq(schema.conversationMembers.conversationId, id)).run();
      for (const botId of patch.botIds) this.db.insert(schema.conversationMembers).values({ conversationId: id, botId }).run();
    }
    return this.get(id);
  }

  delete(id: string): void {
    this.db.delete(schema.messages).where(eq(schema.messages.conversationId, id)).run();
    this.db.delete(schema.conversationMembers).where(eq(schema.conversationMembers.conversationId, id)).run();
    this.db.delete(schema.driverSessions).where(eq(schema.driverSessions.conversationId, id)).run();
    this.db.delete(schema.conversations).where(eq(schema.conversations.id, id)).run();
  }

  /** Reset conversation: delete messages, keep the conversation (memory survives, as in Grok Bot). */
  clearMessages(id: string): void {
    this.db.delete(schema.messages).where(eq(schema.messages.conversationId, id)).run();
    this.db.delete(schema.driverSessions).where(eq(schema.driverSessions.conversationId, id)).run();
  }
}

// ---------- Messages ----------

function rowToMessage(r: typeof schema.messages.$inferSelect): Message {
  return {
    id: r.id,
    conversationId: r.conversationId,
    role: r.role as Message["role"],
    botId: r.botId,
    content: r.content,
    parts: JSON.parse(r.parts) as MessagePart[],
    attachments: JSON.parse(r.attachments ?? "[]") as Attachment[],
    status: r.status as Message["status"],
    error: r.error,
    modelRef: r.modelRef,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class MessageRepo {
  constructor(private db: Db) {}

  /** Replies still "streaming" from before a restart can never finish: mark them stopped. */
  stopOrphans(): number {
    return this.db.update(schema.messages).set({ status: "stopped" }).where(eq(schema.messages.status, "streaming")).run().changes;
  }

  /** Marks a conversation's still-"streaming" replies stopped (nothing is running them) and returns them. */
  stopStreaming(conversationId: string): Message[] {
    const ids = this.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.status, "streaming")))
      .all()
      .map((r) => r.id);
    return ids.map((id) => this.update(id, { status: "stopped" })).filter((m): m is Message => !!m);
  }

  list(conversationId: string, limit = 500): Message[] {
    return this.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(asc(schema.messages.createdAt))
      .limit(limit)
      .all()
      .map(rowToMessage);
  }

  get(id: string): Message | undefined {
    const r = this.db.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
    return r ? rowToMessage(r) : undefined;
  }

  create(input: {
    conversationId: string;
    role: Message["role"];
    botId?: string | null;
    content?: string;
    parts?: MessagePart[];
    attachments?: Attachment[];
    status?: Message["status"];
    modelRef?: string | null;
  }): Message {
    const ts = nowIso();
    const id = newId();
    this.db
      .insert(schema.messages)
      .values({
        id,
        conversationId: input.conversationId,
        role: input.role,
        botId: input.botId ?? null,
        content: input.content ?? "",
        parts: JSON.stringify(input.parts ?? (input.content ? [{ type: "text", text: input.content }] : [])),
        attachments: JSON.stringify(input.attachments ?? []),
        status: input.status ?? "done",
        modelRef: input.modelRef ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return this.get(id)!;
  }

  delete(id: string): void {
    this.db.delete(schema.messages).where(eq(schema.messages.id, id)).run();
  }

  update(
    id: string,
    patch: Partial<Pick<Message, "content" | "parts" | "attachments" | "status" | "error">>,
  ): Message | undefined {
    const set: Partial<typeof schema.messages.$inferInsert> = { updatedAt: nowIso() };
    if (patch.content !== undefined) set.content = patch.content;
    if (patch.parts !== undefined) set.parts = JSON.stringify(patch.parts);
    if (patch.attachments !== undefined) set.attachments = JSON.stringify(patch.attachments);
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.error !== undefined) set.error = patch.error;
    this.db.update(schema.messages).set(set).where(eq(schema.messages.id, id)).run();
    return this.get(id);
  }
}

// ---------- Settings ----------

export class SettingsRepo {
  constructor(private db: Db) {}

  get(): AppSettings {
    const rows = this.db.select().from(schema.settings).all();
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) out[r.key] = JSON.parse(r.value);
    return out as unknown as AppSettings;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      this.db
        .insert(schema.settings)
        .values({ key: k, value: JSON.stringify(v) })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(v) } })
        .run();
    }
    return this.get();
  }
}

// ---------- Provider configs ----------

export interface ProviderConfigRow {
  provider: ProviderId;
  apiKey: string | null;
  baseUrl: string | null;
  disabled: boolean;
}

export class ProviderRepo {
  constructor(
    private db: Db,
    private secrets: Secrets,
  ) {}

  get(provider: ProviderId): ProviderConfigRow {
    const r = this.db.select().from(schema.providerConfigs).where(eq(schema.providerConfigs.provider, provider)).get();
    return {
      provider,
      apiKey: r?.apiKeyEnc ? this.secrets.decrypt(r.apiKeyEnc) : null,
      baseUrl: r?.baseUrl ?? null,
      disabled: !!r?.disabled,
    };
  }

  set(provider: ProviderId, patch: { apiKey?: string | null; baseUrl?: string | null; disabled?: boolean }): ProviderConfigRow {
    const current = this.db
      .select()
      .from(schema.providerConfigs)
      .where(eq(schema.providerConfigs.provider, provider))
      .get();
    const apiKeyEnc =
      patch.apiKey === undefined
        ? (current?.apiKeyEnc ?? null)
        : patch.apiKey
          ? this.secrets.encrypt(patch.apiKey)
          : null;
    const baseUrl = patch.baseUrl === undefined ? (current?.baseUrl ?? null) : patch.baseUrl;
    const disabled = patch.disabled === undefined ? (current?.disabled ?? 0) : patch.disabled ? 1 : 0;
    this.db
      .insert(schema.providerConfigs)
      .values({ provider, apiKeyEnc, baseUrl, disabled, updatedAt: nowIso() })
      .onConflictDoUpdate({
        target: schema.providerConfigs.provider,
        set: { apiKeyEnc, baseUrl, disabled, updatedAt: nowIso() },
      })
      .run();
    return this.get(provider);
  }
}

// ---------- Driver sessions ----------

export class DriverSessionRepo {
  constructor(private db: Db) {}

  get(conversationId: string, botId: string, provider: string): string | undefined {
    return this.db
      .select({ sessionId: schema.driverSessions.sessionId })
      .from(schema.driverSessions)
      .where(
        and(
          eq(schema.driverSessions.conversationId, conversationId),
          eq(schema.driverSessions.botId, botId),
          eq(schema.driverSessions.provider, provider),
        ),
      )
      .get()?.sessionId;
  }

  set(conversationId: string, botId: string, provider: string, sessionId: string): void {
    this.db
      .insert(schema.driverSessions)
      .values({ conversationId, botId, provider, sessionId, updatedAt: nowIso() })
      .onConflictDoUpdate({
        target: [schema.driverSessions.conversationId, schema.driverSessions.botId, schema.driverSessions.provider],
        set: { sessionId, updatedAt: nowIso() },
      })
      .run();
  }

  clear(conversationId: string, botId: string, provider: string): void {
    this.db
      .delete(schema.driverSessions)
      .where(
        and(
          eq(schema.driverSessions.conversationId, conversationId),
          eq(schema.driverSessions.botId, botId),
          eq(schema.driverSessions.provider, provider),
        ),
      )
      .run();
  }
}

// ---------- tasks ----------

function rowToTask(r: typeof schema.tasks.$inferSelect): Task {
  return {
    id: r.id,
    title: r.title,
    detail: r.detail,
    ownerBotId: r.ownerBotId,
    createdBy: r.createdBy,
    status: r.status as TaskStatus,
    priority: r.priority as TaskPriority,
    dueAt: r.dueAt,
    result: r.result,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class TaskRepo {
  constructor(private db: Db) {}

  /** Newest first; open work before finished work. */
  list(filter: { ownerBotId?: string | null; includeClosed?: boolean } = {}): Task[] {
    const rows = this.db.select().from(schema.tasks).orderBy(desc(schema.tasks.updatedAt)).all().map(rowToTask);
    return rows.filter(
      (t) =>
        (filter.ownerBotId === undefined || t.ownerBotId === filter.ownerBotId) &&
        (filter.includeClosed !== false || (t.status !== "done" && t.status !== "dropped")),
    );
  }

  get(id: string): Task | undefined {
    const r = this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
    return r ? rowToTask(r) : undefined;
  }

  /** Accepts a full id or the 8-char prefix the Bots see. */
  find(idOrPrefix: string): Task | undefined {
    return this.get(idOrPrefix) ?? this.list().find((t) => t.id.startsWith(idOrPrefix));
  }

  create(input: { title: string; detail?: string; ownerBotId?: string | null; createdBy?: string | null; priority?: TaskPriority; dueAt?: string | null }): Task {
    const ts = nowIso();
    const id = newId();
    this.db
      .insert(schema.tasks)
      .values({
        id,
        title: input.title,
        detail: input.detail ?? "",
        ownerBotId: input.ownerBotId ?? null,
        createdBy: input.createdBy ?? null,
        status: "open",
        priority: input.priority ?? "normal",
        dueAt: input.dueAt ?? null,
        result: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return this.get(id)!;
  }

  update(id: string, patch: Partial<Pick<Task, "title" | "detail" | "ownerBotId" | "status" | "priority" | "dueAt" | "result">>): Task | undefined {
    this.db.update(schema.tasks).set({ ...patch, updatedAt: nowIso() }).where(eq(schema.tasks.id, id)).run();
    return this.get(id);
  }

  delete(id: string): void {
    this.db.delete(schema.tasks).where(eq(schema.tasks.id, id)).run();
  }
}
