import { create } from "zustand";
import type {
  Space,
  ProfileFact,
  AccessInfo,
  AppConnector,
  AvatarShape,
  AppSettings,
  Approval,
  ApprovalDecision,
  Bot,
  BotStatus,
  ClientMessage,
  Conversation,
  Message,
  Routine,
  RoutineRun,
  ScreenState,
  SecureFormRequest,
  ServerEvent,
  Skill,
  Task,
  TemplateCatalog,
  VaultItem,
} from "@grokbot/shared";
import { DEFAULT_SETTINGS, ROUTINE_RUN_HISTORY } from "@grokbot/shared";
import { api, type CreateSquadInput } from "./api";
import type { CreateFromTemplateInput } from "@grokbot/shared";

export interface AppNotification {
  id: string;
  botId: string;
  conversationId: string;
  title: string;
  body: string;
  kind: "reply" | "needs-attention";
  at: string;
}

const MAX_NOTIFICATIONS = 20;

interface State {
  connected: boolean;
  bots: Bot[];
  /** Work, Personal, …: each has its own Bots, lead Bot and default model. */
  spaces: Space[];
  /** The space being viewed; the roster, task board and new Bots follow it. */
  spaceId: string | null;
  setSpace(id: string): Promise<void>;
  moveBotToSpace(botId: string, spaceId: string): Promise<void>;
  saveSpace(id: string, patch: Partial<Pick<Space, "name" | "emoji" | "defaultModelRef">>): Promise<void>;
  addSpace(name: string, emoji: string): Promise<void>;
  removeSpace(id: string): Promise<void>;
  botStatus: Record<string, BotStatus>;
  unread: Record<string, boolean>;
  /** The Bot of the open 1:1 chat; null while a group chat is open. */
  selectedBotId: string | null;
  /** The open conversation (direct or group). */
  selectedConversationId: string | null;
  conversation: Conversation | null;
  /** Group conversations, loaded on bootstrap. */
  groups: Conversation[];
  messages: Message[];
  settings: AppSettings;
  /** Latest known state of each Bot's screen, by botId. Frames are NOT stored here (see lib/frames.ts). */
  screens: Record<string, ScreenState>;
  /** Pending and recently resolved approvals, by id. */
  approvals: Record<string, Approval>;
  /** Routines per botId; loaded when a Bot is selected. */
  routines: Record<string, Routine[]>;
  /** Run history per routineId; loaded on demand and kept fresh by routine.run events. */
  routineRuns: Record<string, RoutineRun[]>;
  /** Shared skills (used with "/" in the composer). */
  skills: Skill[];
  /** Vault items (metadata only; secrets never reach the renderer). */
  vault: VaultItem[];
  /** Secure Form requests, pending + recently resolved, by id. */
  secureForms: Record<string, SecureFormRequest>;
  /** Connect apps (MCP servers). */
  connectors: AppConnector[];
  connectAppsOpen: boolean;
  /** Recent "notify" events for conversations that were not open at the time (newest first). */
  notifications: AppNotification[];
  settingsOpen: boolean;
  /** Pane to show when Settings opens (e.g. "about" from the "learned about you" chip). */
  settingsPane: string | null;
  /** About you: what Bots know about the user (loaded by the About you pane). */
  profile: ProfileFact[];
  /** Facts the Bots just learned, shown briefly as a chip. */
  justLearned: string[];
  loadProfile(): Promise<void>;
  dismissLearned(): void;
  createOpen: boolean;
  /** Template to pre-select when the create dialog opens (e.g. "chief-of-staff" from Welcome). */
  createTemplateId: string | null;
  newChatOpen: boolean;
  /** Bot / squad templates; loaded the first time the create dialog opens. */
  templates: TemplateCatalog | null;
  /** Settings → Phone: the LAN link + QR, only available from the Mac running Cadre. */
  access: AccessInfo | null;
  accessError: string | null;
  /** Phone layout (<768px): the sidebar is a drawer and the computer a full-screen overlay. */
  mobileSidebarOpen: boolean;
  mobileComputerOpen: boolean;
  /** Team task board (open work; closed tasks are dropped from the panel). */
  tasks: Task[];
  /** Right-hand panel on desktop: the Team panel, the full computer, or nothing. Remembered per device. */
  rightPanel: "team" | "computer" | null;
  /** Phone: the Team panel as a full-screen overlay. */
  mobileTeamOpen: boolean;
  error: string | null;

  bootstrap(): Promise<void>;
  selectBot(id: string | null): Promise<void>;
  /** Open any conversation by id (a group, or a Bot's direct chat). */
  selectConversation(id: string): Promise<void>;
  createGroup(botIds: string[], title?: string): Promise<void>;
  deleteGroup(id: string): Promise<void>;
  renameGroup(id: string, title: string): Promise<void>;
  /** Replace a group's members (add or remove Bots); the chat shows who joined or left. */
  setGroupMembers(id: string, botIds: string[]): Promise<void>;
  /** Open whatever chat a notification came from: the group if it's a group, else that Bot's chat. */
  openChat(conversationId: string | undefined, botId: string | undefined): Promise<void>;
  createBot(input: Parameters<typeof api.bots.create>[0]): Promise<void>;
  loadTemplates(): Promise<void>;
  /** Create a Bot from a template (its routines, skills, rules and memory come with it) and open its chat. */
  createBotFromTemplate(
    templateId: string,
    input: CreateFromTemplateInput,
    /** The template endpoint has no avatar fields; a picture the user changed is patched on right after. */
    avatar?: { avatarShape: AvatarShape; avatarColor: string },
  ): Promise<void>;
  /** Create every Bot of a squad plus their group chat, and open the group. */
  createSquad(squadId: string, input: CreateSquadInput): Promise<void>;
  loadAccess(): Promise<void>;
  /** New phone link; every phone signed in with the old one is signed out. */
  rotateAccess(): Promise<void>;
  setMobileSidebarOpen(v: boolean): void;
  setMobileComputerOpen(v: boolean): void;
  setMobileTeamOpen(v: boolean): void;
  setRightPanel(v: "team" | "computer" | null): void;
  loadTasks(): Promise<void>;
  loadAllRoutines(): Promise<void>;
  createTask(input: { title: string; detail?: string; ownerBotId?: string | null }): Promise<void>;
  updateTask(id: string, patch: Partial<Pick<Task, "status" | "ownerBotId" | "result" | "title">>): Promise<void>;
  /** Flip between the Tidewater night and day themes (leaves "system" when used). */
  toggleTheme(): Promise<void>;
  updateBot(id: string, patch: Parameters<typeof api.bots.update>[1]): Promise<void>;
  deleteBot(id: string): Promise<void>;
  send(content: string, attachmentIds?: string[]): Promise<void>;
  clearNotifications(): void;
  stop(): Promise<void>;
  resetConversation(): Promise<void>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  /** Auto mode = Auto Review off: Bots act without asking (can't-undo actions still ask). Turning it on also clears waiting cards that it covers. */
  setAutoMode(on: boolean): Promise<void>;
  decideApproval(id: string, decision: ApprovalDecision): Promise<void>;
  loadRoutines(botId: string): Promise<void>;
  loadRoutineRuns(routineId: string): Promise<void>;
  loadSkills(): Promise<void>;
  loadVault(): Promise<void>;
  loadConnectors(): Promise<void>;
  fillSecureForm(id: string, values: Record<string, string>, title?: string): Promise<void>;
  cancelSecureForm(id: string): Promise<void>;
  setConnectAppsOpen(v: boolean): void;
  /** Send a ClientMessage over the events WebSocket. Set by App from connectEvents. */
  wsSend(msg: ClientMessage): void;
  setWsSend(fn: (msg: ClientMessage) => void): void;
  setSettingsOpen(v: boolean, pane?: string): void;
  setCreateOpen(v: boolean, templateId?: string | null): void;
  setNewChatOpen(v: boolean): void;
  setConnected(v: boolean): void;
  onEvent(e: ServerEvent): void;
}

const RIGHT_PANEL_KEY = "cadre.rightPanel";
const savedRightPanel = (): State["rightPanel"] => {
  try {
    const v = localStorage.getItem(RIGHT_PANEL_KEY);
    return v === "computer" || v === "none" ? (v === "none" ? null : "computer") : "team";
  } catch {
    return "team";
  }
};
const isOpenTask = (t: Task) => t.status !== "done" && t.status !== "dropped";
const SPACE_KEY = "cadre.space";
const savedSpace = (): string | null => {
  try {
    return localStorage.getItem(SPACE_KEY);
  } catch {
    return null;
  }
};

/** Bots in the space being viewed (the whole roster when spaces haven't loaded). */
export function botsInSpace(bots: Bot[], spaceId: string | null): Bot[] {
  return spaceId ? bots.filter((b) => b.spaceId === spaceId) : bots;
}

export const useStore = create<State>((set, get) => ({
  tasks: [],
  rightPanel: savedRightPanel(),
  mobileTeamOpen: false,
  connected: false,
  bots: [],
  spaces: [],
  spaceId: savedSpace(),
  botStatus: {},
  unread: {},
  selectedBotId: null,
  selectedConversationId: null,
  conversation: null,
  groups: [],
  messages: [],
  settings: DEFAULT_SETTINGS,
  screens: {},
  approvals: {},
  routines: {},
  routineRuns: {},
  skills: [],
  vault: [],
  secureForms: {},
  connectors: [],
  connectAppsOpen: false,
  notifications: [],
  settingsOpen: false,
  settingsPane: null,
  profile: [],
  justLearned: [],
  createOpen: false,
  createTemplateId: null,
  newChatOpen: false,
  templates: null,
  access: null,
  accessError: null,
  mobileSidebarOpen: false,
  mobileComputerOpen: false,
  error: null,

  setMobileTeamOpen(v) {
    set({ mobileTeamOpen: v, ...(v ? { mobileComputerOpen: false, mobileSidebarOpen: false } : {}) });
  },

  setRightPanel(v) {
    try {
      localStorage.setItem(RIGHT_PANEL_KEY, v ?? "none");
    } catch {
      /* private mode: just don't remember */
    }
    set({ rightPanel: v });
  },

  async loadTasks() {
    try {
      set({ tasks: (await api.tasks.list()).filter(isOpenTask) });
    } catch {
      /* older server: no task board */
    }
  },

  async loadAllRoutines() {
    try {
      const all = await api.routines.all();
      const byBot: Record<string, Routine[]> = {};
      for (const r of all) (byBot[r.botId] ??= []).push(r);
      set({ routines: { ...get().routines, ...byBot } });
    } catch {
      /* older server */
    }
  },

  async createTask(input) {
    const task = await api.tasks.create(input);
    set({ tasks: upsert(get().tasks, task) });
  },

  async updateTask(id, patch) {
    const task = await api.tasks.update(id, patch);
    set({ tasks: isOpenTask(task) ? upsert(get().tasks, task) : get().tasks.filter((t) => t.id !== id) });
  },

  async setSpace(id) {
    if (!get().spaces.some((x) => x.id === id)) return;
    try {
      localStorage.setItem(SPACE_KEY, id);
    } catch {
      /* per-viewer convenience only */
    }
    set({ spaceId: id });
    await get().selectBot(primaryBotId(botsInSpace(get().bots, id)));
  },

  async moveBotToSpace(botId, spaceId) {
    const bot = await api.bots.update(botId, { spaceId });
    set({ bots: upsert(get().bots, bot) });
    if (get().selectedBotId === botId && spaceId !== get().spaceId) await get().selectBot(primaryBotId(botsInSpace(get().bots, get().spaceId)));
  },

  async saveSpace(id, patch) {
    const space = await api.spaces.update(id, patch);
    set({ spaces: upsert(get().spaces, space) });
  },

  async addSpace(name, emoji) {
    const space = await api.spaces.create({ name, emoji });
    set({ spaces: upsert(get().spaces, space) });
  },

  async removeSpace(id) {
    await api.spaces.delete(id);
    const spaces = get().spaces.filter((x) => x.id !== id);
    set({ spaces });
    if (get().spaceId === id && spaces[0]) await get().setSpace(spaces[0].id);
  },

  async toggleTheme() {
    const dark = document.documentElement.dataset.theme === "dark";
    await get().updateSettings({ appearance: dark ? "light" : "dark" });
  },

  async bootstrap() {
    try {
      const [spaces, bots, settings, pending, skills, groups, vault, connectors, pendingForms] = await Promise.all([
        api.spaces.list().catch(() => [] as Space[]),
        api.bots.list(),
        api.settings.get(),
        api.approvals.list().catch(() => [] as Approval[]),
        api.skills.list().catch(() => get().skills),
        api.conversations.list().catch(() => get().groups),
        api.vault.list().catch(() => get().vault),
        api.connectors.list().catch(() => get().connectors),
        api.secureForms.list().catch(() => [] as SecureFormRequest[]),
      ]);
      const approvals: Record<string, Approval> = { ...get().approvals };
      const botStatus = { ...get().botStatus };
      for (const a of pending) {
        approvals[a.id] = a;
        if (a.status === "pending") botStatus[a.botId] = "needs-attention";
      }
      const secureForms: Record<string, SecureFormRequest> = { ...get().secureForms };
      for (const f of pendingForms) {
        secureForms[f.id] = f;
        if (f.status === "pending") botStatus[f.botId] = "needs-attention";
      }
      const spaceId = spaces.some((x) => x.id === get().spaceId) ? get().spaceId : (spaces[0]?.id ?? null);
      set({ spaces, spaceId, bots, settings, approvals, botStatus, skills, vault, connectors, secureForms, groups: groups.filter((c) => c.kind === "group"), error: null });
      void get().loadTasks();
      void get().loadAllRoutines();
      const { selectedBotId, selectedConversationId } = get();
      const here = botsInSpace(bots, spaceId);
      const first = here.find((b) => b.isPrimary) ?? here.find((b) => !b.hidden) ?? here[0];
      if (selectedBotId && here.some((b) => b.id === selectedBotId)) await get().selectBot(selectedBotId);
      else if (selectedConversationId && get().groups.some((g) => g.id === selectedConversationId)) await get().selectConversation(selectedConversationId);
      else if (first) await get().selectBot(first.id);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async selectBot(id) {
    if (!id) return set({ selectedBotId: null, selectedConversationId: null, conversation: null, messages: [] });
    set({ selectedBotId: id, unread: { ...get().unread, [id]: false }, mobileSidebarOpen: false, mobileComputerOpen: false });
    void get().loadRoutines(id);
    const conversation = await api.bots.conversation(id);
    if (get().selectedBotId !== id) return;
    set({ selectedConversationId: conversation.id, conversation });
    const messages = await api.conversations.messages(conversation.id);
    if (get().selectedBotId === id) set({ messages });
  },

  async selectConversation(id) {
    const group = get().groups.find((g) => g.id === id);
    if (!group) {
      // Not a group: it must be a Bot's direct chat.
      const bot = get().bots.find((b) => b.id === id);
      if (bot) return get().selectBot(bot.id);
      return;
    }
    set({
      selectedBotId: null,
      selectedConversationId: id,
      conversation: group,
      messages: get().conversation?.id === id ? get().messages : [],
      unread: { ...get().unread, [id]: false },
      mobileSidebarOpen: false,
      mobileComputerOpen: false,
    });
    const messages = await api.conversations.messages(id);
    if (get().selectedConversationId === id) set({ messages });
  },

  async createGroup(botIds, title) {
    const group = await api.conversations.create(botIds, title?.trim() || undefined);
    set({ groups: upsert(get().groups, group), newChatOpen: false });
    await get().selectConversation(group.id);
  },

  async deleteGroup(id) {
    await api.conversations.delete(id);
    set({ groups: get().groups.filter((g) => g.id !== id) });
    if (get().selectedConversationId === id) await get().selectBot(primaryBotId(get().bots));
  },

  async setGroupMembers(id, botIds) {
    try {
      const group = await api.conversations.update(id, { botIds });
      set({ groups: upsert(get().groups, group), conversation: get().conversation?.id === id ? group : get().conversation });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async openChat(conversationId, botId) {
    const s = get();
    if (conversationId && s.groups.some((g) => g.id === conversationId)) return s.selectConversation(conversationId);
    if (botId && s.bots.some((b) => b.id === botId)) return s.selectBot(botId);
    if (conversationId) return s.selectConversation(conversationId);
  },

  async setAutoMode(on) {
    await get().updateSettings({ autoReview: !on });
    if (!on) return;
    for (const a of Object.values(get().approvals)) {
      if (a.status === "pending" && a.warnings.length === 0) void get().decideApproval(a.id, "allow").catch(() => {});
    }
  },

  async renameGroup(id, title) {
    const group = await api.conversations.update(id, { title: title.trim() || null });
    set({ groups: upsert(get().groups, group), conversation: get().conversation?.id === id ? group : get().conversation });
  },

  async createBot(input) {
    const { bot } = await api.bots.create({ ...input, spaceId: input.spaceId ?? get().spaceId ?? undefined });
    set({ bots: upsert(get().bots, bot), createOpen: false, createTemplateId: null });
    await get().selectBot(bot.id);
  },

  async loadTemplates() {
    const templates = await api.templates.list();
    set({ templates });
  },

  async createBotFromTemplate(templateId, input, avatar) {
    const created = await api.templates.create(templateId, { ...input, spaceId: input.spaceId ?? get().spaceId ?? undefined });
    let { bot } = created;
    const { routines } = created;
    if (avatar && (avatar.avatarShape !== bot.avatarShape || avatar.avatarColor !== bot.avatarColor)) {
      bot = await api.bots.update(bot.id, avatar).catch(() => bot);
    }
    let bots = upsert(get().bots, bot);
    if (bot.isPrimary) bots = bots.map((b) => (b.spaceId === bot.spaceId ? { ...b, isPrimary: b.id === bot.id } : b));
    set({
      bots,
      routines: { ...get().routines, [bot.id]: routines },
      createOpen: false,
      createTemplateId: null,
    });
    await get().selectBot(bot.id);
  },

  async createSquad(squadId, input) {
    const { bots: created, conversation } = await api.templates.createSquad(squadId, { ...input, spaceId: input.spaceId ?? get().spaceId ?? undefined });
    let bots = get().bots;
    for (const b of created) bots = upsert(bots, b);
    const primary = created.find((b) => b.isPrimary);
    if (primary) bots = bots.map((b) => (b.spaceId === primary.spaceId ? { ...b, isPrimary: b.id === primary.id } : b));
    set({
      bots,
      groups: conversation.kind === "group" ? upsert(get().groups, conversation) : get().groups,
      createOpen: false,
      createTemplateId: null,
    });
    await get().selectConversation(conversation.id);
  },

  async loadAccess() {
    try {
      const access = await api.access.get();
      set({ access, accessError: null });
    } catch (err) {
      set({ access: null, accessError: (err as Error).message });
    }
  },

  async rotateAccess() {
    const access = await api.access.rotate();
    set({ access, accessError: null });
  },

  setMobileSidebarOpen: (v) => set({ mobileSidebarOpen: v }),
  setMobileComputerOpen: (v) => set({ mobileComputerOpen: v }),

  async updateBot(id, patch) {
    const bot = await api.bots.update(id, patch);
    set({ bots: upsert(get().bots, bot) });
    if (patch.isPrimary) set({ bots: get().bots.map((b) => (b.spaceId === bot.spaceId ? { ...b, isPrimary: b.id === id } : b)) });
  },

  async deleteBot(id) {
    await api.bots.delete(id);
    const bots = get().bots.filter((b) => b.id !== id);
    set({ bots });
    if (get().selectedBotId === id) await get().selectBot(botsInSpace(bots, get().spaceId).find((b) => !b.hidden)?.id ?? null);
  },

  async send(content, attachmentIds = []) {
    const conv = get().conversation;
    if (!conv) return;
    await api.conversations.send(conv.id, { content, attachmentIds });
  },

  clearNotifications: () => set({ notifications: [] }),

  async stop() {
    const conv = get().conversation;
    if (conv) await api.conversations.stop(conv.id);
  },

  async resetConversation() {
    const conv = get().conversation;
    if (!conv) return;
    await api.conversations.reset(conv.id);
    set({ messages: [] });
  },

  async updateSettings(patch) {
    const settings = await api.settings.update(patch);
    set({ settings });
  },

  async decideApproval(id, decision) {
    const approval = await api.approvals.decide(id, decision);
    set({ approvals: { ...get().approvals, [approval.id]: approval } });
  },

  async loadRoutines(botId) {
    try {
      const list = await api.routines.list(botId);
      set({ routines: { ...get().routines, [botId]: list } });
    } catch {
      /* routines are optional UI; the error is shown in BotDetails on retry */
    }
  },

  async loadRoutineRuns(routineId) {
    const runs = await api.routines.runs(routineId);
    set({ routineRuns: { ...get().routineRuns, [routineId]: runs } });
  },

  async loadSkills() {
    const skills = await api.skills.list();
    set({ skills });
  },

  async loadVault() {
    const vault = await api.vault.list();
    set({ vault });
  },

  async loadConnectors() {
    const connectors = await api.connectors.list();
    set({ connectors });
  },

  async fillSecureForm(id, values, title) {
    const request = await api.secureForms.fill(id, values, title);
    set({ secureForms: { ...get().secureForms, [request.id]: request } });
  },

  async cancelSecureForm(id) {
    const request = await api.secureForms.cancel(id);
    set({ secureForms: { ...get().secureForms, [request.id]: request } });
  },

  setConnectAppsOpen: (v) => set({ connectAppsOpen: v, ...(v ? { mobileSidebarOpen: false } : {}) }),

  wsSend: () => {
    /* replaced by App once the events socket exists */
  },
  setWsSend: (fn) => set({ wsSend: fn }),

  // Opening any dialog also closes the phone drawer so it never sits under the dialog.
  setSettingsOpen: (v, pane) => set({ settingsOpen: v, settingsPane: v ? (pane ?? null) : null, ...(v ? { mobileSidebarOpen: false } : {}) }),
  loadProfile: async () => set({ profile: await api.profile.list() }),
  dismissLearned: () => set({ justLearned: [] }),
  setCreateOpen: (v, templateId = null) => set({ createOpen: v, createTemplateId: v ? templateId : null, ...(v ? { mobileSidebarOpen: false } : {}) }),
  setNewChatOpen: (v) => set({ newChatOpen: v, ...(v ? { mobileSidebarOpen: false } : {}) }),
  setConnected: (v) => set({ connected: v }),

  onEvent(e) {
    const s = get();
    switch (e.type) {
      case "bot.updated":
        set({ bots: upsert(s.bots, e.bot) });
        break;
      case "bot.deleted":
        set({ bots: s.bots.filter((b) => b.id !== e.botId) });
        break;
      case "bot.status":
        set({ botStatus: { ...s.botStatus, [e.botId]: e.status } });
        break;
      case "message.created":
        if (e.message.conversationId === s.conversation?.id) {
          set({ messages: upsert(s.messages, e.message) });
        }
        break;
      case "message.delta":
        if (e.conversationId === s.conversation?.id) {
          set({
            messages: s.messages.map((m) => {
              if (m.id !== e.messageId) return m;
              const parts = [...m.parts];
              const last = parts.at(-1);
              if (last?.type === "text") parts[parts.length - 1] = { ...last, text: last.text + e.text };
              else parts.push({ type: "text", text: e.text });
              return { ...m, content: m.content + e.text, parts };
            }),
          });
        }
        break;
      case "message.part": {
        const part = e.part;
        if (e.conversationId === s.conversation?.id) {
          set({
            messages: s.messages.map((m) => {
              if (m.id !== e.messageId) return m;
              const parts = [...m.parts];
              if (part.type === "tool-result") {
                const i = parts.findIndex((p) => p.type === "tool-call" && p.id === part.id);
                const call = parts[i];
                if (call && call.type === "tool-call") parts[i] = { ...call, status: part.isError ? "error" : "done" };
              }
              if (part.type === "reasoning") {
                const last = parts.at(-1);
                if (last?.type === "reasoning") {
                  parts[parts.length - 1] = { ...last, text: last.text + part.text };
                  return { ...m, parts };
                }
              }
              parts.push(part);
              return { ...m, parts };
            }),
          });
        }
        break;
      }
      case "message.done":
        if (e.message.conversationId === s.conversation?.id) {
          set({ messages: upsert(s.messages, e.message) });
        } else {
          // Flag the sender's 1:1 chat or the group it was posted in.
          const isGroup = s.groups.some((g) => g.id === e.message.conversationId);
          const key = isGroup ? e.message.conversationId : e.message.botId;
          if (key) set({ unread: { ...s.unread, [key]: true } });
        }
        break;
      case "message.deleted":
        if (e.conversationId === s.conversation?.id) set({ messages: s.messages.filter((m) => m.id !== e.messageId) });
        break;
      case "conversation.updated": {
        const c = e.conversation;
        const wasKnown = s.groups.some((g) => g.id === c.id) || s.conversation?.id === c.id;
        const patch: Partial<State> = {};
        if (c.kind === "group") patch.groups = upsert(s.groups, c);
        if (s.conversation?.id === c.id) {
          patch.conversation = c;
          // A reset (same id, fresh updatedAt, no title/member change) clears the transcript for 1:1 chats.
          if (c.kind === "direct") patch.messages = [];
        }
        if (Object.keys(patch).length || !wasKnown) set(patch);
        break;
      }
      case "conversation.deleted": {
        const groups = s.groups.filter((g) => g.id !== e.conversationId);
        set({ groups });
        if (s.selectedConversationId === e.conversationId) void get().selectBot(primaryBotId(s.bots));
        break;
      }
      case "screen.state":
        set({ screens: { ...s.screens, [e.state.botId]: e.state } });
        break;
      case "screen.frame":
        // Routed to lib/frames.ts by App before this handler; nothing to store.
        break;
      case "approval.requested":
        set({
          approvals: { ...s.approvals, [e.approval.id]: e.approval },
          botStatus: { ...s.botStatus, [e.approval.botId]: "needs-attention" },
        });
        break;
      case "approval.resolved": {
        const stillPending = Object.values(s.approvals).some(
          (a) => a.id !== e.approval.id && a.botId === e.approval.botId && a.status === "pending",
        );
        set({
          approvals: { ...s.approvals, [e.approval.id]: e.approval },
          botStatus: {
            ...s.botStatus,
            [e.approval.botId]: stillPending ? "needs-attention" : e.approval.status === "allowed" ? "working" : "idle",
          },
        });
        break;
      }
      case "routine.updated": {
        const list = s.routines[e.routine.botId] ?? [];
        set({ routines: { ...s.routines, [e.routine.botId]: upsert(list, e.routine) } });
        break;
      }
      case "routine.deleted": {
        const list = s.routines[e.botId];
        if (list) set({ routines: { ...s.routines, [e.botId]: list.filter((r) => r.id !== e.routineId) } });
        break;
      }
      case "routine.run": {
        const runs = s.routineRuns[e.run.routineId];
        if (!runs) break; // only tracked once the user opened that routine's history
        const next = upsert(runs, e.run).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, ROUTINE_RUN_HISTORY);
        set({ routineRuns: { ...s.routineRuns, [e.run.routineId]: next } });
        break;
      }
      case "skill.updated":
        set({ skills: upsert(s.skills, e.skill) });
        break;
      case "task.updated":
        set({ tasks: isOpenTask(e.task) ? upsert(s.tasks, e.task) : s.tasks.filter((t) => t.id !== e.task.id) });
        break;
      case "task.deleted":
        set({ tasks: s.tasks.filter((t) => t.id !== e.taskId) });
        break;
      case "skill.deleted":
        set({ skills: s.skills.filter((k) => k.id !== e.skillId) });
        break;
      case "secureform.requested":
        set({
          secureForms: { ...s.secureForms, [e.request.id]: e.request },
          botStatus: { ...s.botStatus, [e.request.botId]: "needs-attention" },
        });
        break;
      case "secureform.resolved": {
        const stillPending =
          Object.values(s.approvals).some((a) => a.botId === e.request.botId && a.status === "pending") ||
          Object.values(s.secureForms).some((f) => f.id !== e.request.id && f.botId === e.request.botId && f.status === "pending");
        set({
          secureForms: { ...s.secureForms, [e.request.id]: e.request },
          botStatus: { ...s.botStatus, [e.request.botId]: stillPending ? "needs-attention" : e.request.status === "filled" ? "working" : "idle" },
        });
        break;
      }
      case "vault.updated":
        set({ vault: upsert(s.vault, e.item) });
        break;
      case "vault.deleted":
        set({ vault: s.vault.filter((v) => v.id !== e.itemId) });
        break;
      case "space.updated":
        set({ spaces: upsert(s.spaces, e.space).sort((a, b) => a.sortOrder - b.sortOrder) });
        break;
      case "profile.updated":
        void api.profile.list().then((profile) => set({ profile }));
        if (e.learned?.length) set({ justLearned: e.learned });
        break;
      case "space.deleted":
        set({ spaces: s.spaces.filter((x) => x.id !== e.spaceId) });
        break;
      case "connector.updated":
        set({ connectors: upsert(s.connectors, e.connector) });
        break;
      case "connector.deleted":
        set({ connectors: s.connectors.filter((c) => c.id !== e.connectorId) });
        break;
      case "notify": {
        // Only keep notifications for conversations other than the open one; the OS notification is App's job.
        if (e.conversationId === s.conversation?.id) break;
        const n: AppNotification = {
          id: `${e.conversationId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
          botId: e.botId,
          conversationId: e.conversationId,
          title: e.title,
          body: e.body,
          kind: e.kind,
          at: new Date().toISOString(),
        };
        set({ notifications: [n, ...s.notifications].slice(0, MAX_NOTIFICATIONS) });
        break;
      }
      case "error":
        set({ error: e.message });
        break;
      default:
        break;
    }
  },
}));

function primaryBotId(bots: Bot[]): string | null {
  return (bots.find((b) => b.isPrimary) ?? bots.find((b) => !b.hidden) ?? bots[0])?.id ?? null;
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}
