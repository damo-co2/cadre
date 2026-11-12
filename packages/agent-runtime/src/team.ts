import { z } from "zod";
import type { Store } from "@grokbot/db";
import type { ToolCallResult } from "@grokbot/sandbox";
import type { Bot, Routine, ServerEvent, Task } from "@grokbot/shared";
import { MAX_BRIEF_LENGTH, MAX_ROUTINES_PER_BOT, TASK_PRIORITIES, TASK_STATUSES, makeModelRef, parseModelRef } from "@grokbot/shared";
import { type RoutineScheduler, type RuntimeToolSpec, validateCron } from "./automation.js";
import { allTemplates, findTemplate, instantiateTemplate, introductionMessage } from "./templates.js";

/** Most Bots on a team, and most hires the Chief of Staff can make in 24 hours. */

const text = (t: string): ToolCallResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): ToolCallResult => ({ isError: true, content: [{ type: "text", text: t }] });
const spec = (name: string, description: string, shape: Record<string, z.ZodTypeAny>): RuntimeToolSpec => ({
  name,
  description,
  zodShape: shape,
  inputSchema: z.toJSONSchema(z.object(shape)) as Record<string, unknown>,
});
const ago = (iso: string | null | undefined): string => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};
const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export interface TeamDeps {
  store: Store;
  emit: (e: ServerEvent) => void;
  scheduler: RoutineScheduler;
  /** Post into a Bot's 1:1 conversation as a message from another Bot and wake it (chain-guarded). */
  sendToBot: (fromBotId: string, toBotName: string, message: string) => Promise<ToolCallResult>;
  /** Post a system message into a Bot's own conversation and wake it. */
  wakeWith: (botId: string, content: string, fromBotId?: string) => void;
  isBusy: (conversationId: string) => boolean;
  /** Where a Bot's updates belong now: the group chat it is working in, else its own chat. */
  conversationFor: (botId: string) => string;
}

const TEAM_TOOLS = new Set(["team_overview", "bot_read", "bot_hire", "bot_update", "bot_retire", "routine_assign"]);
const TASK_TOOLS = new Set(["task_create", "task_update", "task_list"]);

/**
 * The Chief of Staff's powers (primary Bot only): see the whole team, read any Bot's chat, hire,
 * re-brief and retire Bots, and give routines to others. The task board is for every Bot.
 */
export class TeamTools {
  constructor(private deps: TeamDeps) {}

  isTeamTool(name: string): boolean {
    return TEAM_TOOLS.has(name) || TASK_TOOLS.has(name);
  }

  specs(bot?: Bot): RuntimeToolSpec[] {
    const taskTools = [
      spec(
        "task_create",
        "Put a piece of work on the team task board. With an owner Bot, the owner is messaged with the task and wakes to do it; it reports back by updating the task. Use this instead of bot_message for real work so nothing gets lost.",
        {
          title: z.string().describe("Short, outcome-shaped title, e.g. 'Find 3 venues for the offsite under $5k'"),
          detail: z.string().optional().describe("Everything the owner needs: context, constraints, definition of done. It cannot see your conversation."),
          owner: z.string().optional().describe("Bot name that owns it, or 'me' for yourself, or 'user' when only the user can do it. Default: yourself."),
          priority: z.enum(TASK_PRIORITIES).optional(),
          due: z.string().optional().describe("ISO date/time it is due, if any"),
        },
      ),
      spec(
        "task_update",
        "Update a task (yours, or one you created). Set status done with a result, or blocked with what you need. The task's creator is told automatically.",
        {
          id: z.string().describe("Task id (the 8-character prefix is enough)"),
          status: z.enum(TASK_STATUSES).optional(),
          result: z.string().optional().describe("The outcome itself (numbers, names, file paths), or what is blocking"),
          owner: z.string().optional().describe("Reassign to another Bot by name, or 'user'"),
          priority: z.enum(TASK_PRIORITIES).optional(),
          due: z.string().optional(),
        },
      ),
      spec("task_list", "List tasks on the team board. Default: open work for everyone.", {
        owner: z.string().optional().describe("Bot name, 'me', or 'user'"),
        include_closed: z.boolean().optional(),
      }),
    ];
    if (!bot?.isPrimary) return taskTools;
    return [
      ...taskTools,
      spec("team_overview", "Full picture of the team right now: every Bot (role, model, busy, last activity, last thing it said), routines and next runs, the task board, pending approvals and recent failures.", {}),
      spec("bot_read", "Read a Bot's recent conversation (its 1:1 chat with the user and other Bots) to know exactly what it is doing.", {
        bot: z.string().describe("Bot name"),
        limit: z.number().int().min(1).max(60).optional().describe("Messages to read (default 20)"),
      }),
      spec(
        "bot_hire",
        `Hire a new Bot onto the team: from a template (${allTemplates().filter((t) => !t.primary).map((t) => t.id).join(", ")}) or a custom role with your own brief. It is created with its routines, introduces itself to the user, and (with first_task) starts work at once.${this.limitsText()} Prefer an existing Bot when one fits.`,
        {
          template: z.string().optional().describe("Template id, e.g. 'market-scout'. Omit for a custom role."),
          name: z.string().optional().describe("Name for the Bot (defaults to the template's)"),
          role: z.string().optional().describe("Custom role title, e.g. 'Recruiting Coordinator' (required without a template)"),
          brief: z.string().optional().describe("Custom job description: responsibilities, standards, what to never do (required without a template)"),
          model: z.string().optional().describe("Model ref like 'claude-code:default' or 'openai:gpt-5'; default: the app default"),
          routines: z
            .array(z.object({ name: z.string(), cron: z.string().optional(), instruction: z.string() }))
            .optional()
            .describe("Extra routines for a custom Bot (5-field cron, app timezone)"),
          first_task: z.string().optional().describe("A first task to put on the board for it and start right away"),
          reason: z.string().describe("One line for the user: why the team needs this Bot"),
        },
      ),
      spec("bot_update", "Re-brief a teammate or change its role title or model.", {
        bot: z.string(),
        brief: z.string().optional().describe("New full brief (replaces the old one)"),
        role: z.string().optional(),
        model: z.string().optional(),
      }),
      spec("bot_retire", "Retire a Bot: it is hidden from the sidebar and its routines are paused. Reversible by the user. Use for Bots that are no longer useful.", {
        bot: z.string(),
        reason: z.string(),
      }),
      spec("routine_assign", "Give another Bot a routine (scheduled with cron, or manual).", {
        bot: z.string(),
        name: z.string(),
        cron: z.string().optional().describe("5-field cron in the app timezone; omit for a manual routine"),
        instruction: z.string(),
      }),
    ];
  }

  /** Rendered into the primary Bot's system prompt every turn. */
  promptSection(bot: Bot): string {
    if (!bot.isPrimary) return "";
    return [
      "## You are the Chief of Staff",
      "You are the primary Bot and the brain of this team. You have the team tools: team_overview, bot_read, bot_hire, bot_update, bot_retire, routine_assign, plus the task board (task_create/task_update/task_list). Messages in group chats without an @mention come to you.",
      "When a job needs more than one Bot, run it in a group chat: call group_create with those Bots and a brief that @mentions each with its part. Their work, questions, approvals and task updates then all happen in that group instead of their own chats. Keep single-Bot jobs as tasks or bot_message.",
      "",
      "### How you work (the user's standing rule: you manage, the team does the work)",
      "- Answer yourself only when the answer is already in front of you: this chat, your memory, or the snapshot below, or pure advice that needs no lookup.",
      "- Everything else goes to a Bot: looking anything up, connected apps (Jira, email, calendars…), the web or browser, research, writing, monitoring, buying. You have no browser or app tools on purpose.",
      "- Pick an existing Bot whose role fits and give it the work with task_create (owner = that Bot, with every detail it needs; it cannot see this chat). If none fits, bot_hire one (a template if one fits, else a custom role with a sharp brief), then task_create.",
      "- Reuse before hiring. One Bot per lasting responsibility (e.g. one Jira Bot for all Jira questions), never one per question.",
      "- Tell the user in one line who is on it (\"Asked Ledger to pull your CST and PE tickets\") and end your turn. Do not wait, poll task_list or bot_read for the result: when the owner finishes you get a message, and then you relay the result once, briefly.",
      `- Connected apps every Bot except you can use: ${this.connectedApps()}.`,
      "",
      "Live team snapshot (refreshed every turn):",
      this.snapshot(bot, { compact: true }),
    ].join("\n");
  }

  private connectedApps(): string {
    const apps = this.deps.store.connectors.list().filter((c) => c.enabled).map((c) => c.label);
    return apps.length ? apps.join(", ") : "none yet (the user adds them in Connect apps)";
  }

  private limitsText(): string {
    const { hireLimitPerDay, teamSizeLimit } = this.deps.store.settings.get();
    const parts = [hireLimitPerDay > 0 ? `${hireLimitPerDay} hires per day` : null, teamSizeLimit > 0 ? `${teamSizeLimit} Bots in total` : null].filter(Boolean);
    return parts.length ? ` The user's limits: ${parts.join(", ")}.` : "";
  }

  /** The team in text: Bots, activity, routines, tasks, approvals, failures. */
  snapshot(viewer: Bot, { compact = false } = {}): string {
    const { store } = this.deps;
    const bots = store.bots.listInSpace(viewer.spaceId);
    const ids = new Set(bots.map((b) => b.id));
    const tasks = store.tasks.list().filter((t) => (t.ownerBotId && ids.has(t.ownerBotId)) || (t.createdBy && ids.has(t.createdBy)));
    const lines: string[] = [];
    const name = (id: string | null) => (id ? (bots.find((b) => b.id === id)?.name ?? "?") : "user");
    for (const b of bots) {
      const conv = store.conversations.directForBot(b.id);
      const msgs = store.messages.list(conv.id, 40);
      const lastBot = [...msgs].reverse().find((m) => m.role === "bot" && m.content.trim());
      const lastAny = msgs.at(-1);
      const routines = store.routines.list(b.id);
      const active = routines.filter((r) => r.enabled);
      const next = active.map((r) => r.nextRunAt).filter((x): x is string => !!x).sort()[0];
      const open = tasks.filter((t) => t.ownerBotId === b.id);
      const flags = [b.id === viewer.id ? "you" : null, b.hidden ? "retired" : null, this.deps.isBusy(conv.id) ? "working now" : null, b.hiredBy ? `hired by ${name(b.hiredBy)}` : null].filter(Boolean);
      lines.push(
        `- ${b.name}${b.label ? ` (${b.label})` : ""}${flags.length ? ` [${flags.join(", ")}]` : ""}: model ${b.modelRef ?? "default"}; last active ${ago(lastAny?.createdAt)}; ${active.length}/${routines.length} routines on${next ? `, next ${next}` : ""}; ${open.length} open tasks${
          lastBot && b.id !== viewer.id ? `\n    last said: "${oneLine(lastBot.content, compact ? 140 : 400)}"` : ""
        }`,
      );
    }
    const openTasks = tasks.slice(0, compact ? 15 : 60);
    const taskLines = openTasks.map(
      (t) => `- [${t.id.slice(0, 8)}] ${t.status}${t.priority !== "normal" ? `/${t.priority}` : ""} · ${t.title} · owner ${name(t.ownerBotId)} · from ${name(t.createdBy)}${t.dueAt ? ` · due ${t.dueAt}` : ""} · updated ${ago(t.updatedAt)}`,
    );
    const pending = store.approvals.list("pending");
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const failures = store.routines
      .list()
      .flatMap((r) => store.routines.runs(r.id, 5).map((run) => ({ ...run, routineName: r.name })))
      .filter((r) => r.status === "error" && r.startedAt >= since)
      .slice(0, 5);
    const groups = store.conversations.listGroups();
    return [
      `Bots (${bots.length}):`,
      ...lines,
      `Task board (${tasks.length} open):`,
      ...(taskLines.length ? taskLines : ["- nothing open"]),
      `Pending approvals: ${pending.length ? pending.map((a) => `${name(a.botId)}: ${oneLine(a.summary, 80)}`).join("; ") : "none"}`,
      `Routine failures (24h): ${failures.length ? failures.map((r) => `${r.routineName}: ${oneLine(r.error ?? "", 80)}`).join("; ") : "none"}`,
      ...(compact ? [] : [`Group chats: ${groups.map((g) => g.title ?? g.botIds.map(name).join(", ")).join(" | ") || "none"}`]),
    ].join("\n");
  }

  /** A Bot by name or id, within the viewer's space (each space's Chief manages only its own team). */
  private findBot(nameOrId: string | undefined, viewer?: Bot): Bot | undefined {
    const q = String(nameOrId ?? "").trim().toLowerCase();
    const pool = viewer ? this.deps.store.bots.listInSpace(viewer.spaceId) : this.deps.store.bots.list();
    return pool.find((b) => b.name.toLowerCase() === q || b.id === nameOrId);
  }

  /** "me" → caller, "user" → null, a Bot name → its id, undefined → fallback. */
  private resolveOwner(caller: Bot, owner: string | undefined, fallback: string | null): { id: string | null } | { error: string } {
    if (owner === undefined || owner === "") return { id: fallback };
    const o = owner.trim().toLowerCase();
    if (o === "me" || o === "self") return { id: caller.id };
    if (o === "user" || o === "you" || o === "human") return { id: null };
    const b = this.findBot(owner, caller);
    return b ? { id: b.id } : { error: `No Bot named "${owner}". Team: ${this.deps.store.bots.listInSpace(caller.spaceId).map((x) => x.name).join(", ")}` };
  }

  private normaliseModel(model: string | undefined): string | undefined {
    if (!model) return undefined;
    try {
      const ref = parseModelRef(model.trim());
      return makeModelRef(ref.provider, ref.model);
    } catch {
      return undefined;
    }
  }

  async call(bot: Bot, name: string, input: unknown): Promise<ToolCallResult> {
    const a = (input ?? {}) as Record<string, unknown>;
    if (TEAM_TOOLS.has(name) && !bot.isPrimary) return fail("Only the Chief of Staff (the primary Bot) can manage the team. Ask it with bot_message.");
    switch (name) {
      case "team_overview":
        return text(this.snapshot(bot));
      case "bot_read":
        return this.read(bot, a);
      case "bot_hire":
        return this.hire(bot, a);
      case "bot_update":
        return this.update(bot, a);
      case "bot_retire":
        return this.retire(bot, a);
      case "routine_assign":
        return this.assignRoutine(bot, a);
      case "task_create":
        return this.taskCreate(bot, a);
      case "task_update":
        return this.taskUpdate(bot, a);
      case "task_list":
        return this.taskList(bot, a);
    }
    return fail(`Unknown team tool ${name}`);
  }

  private read(chief: Bot, a: Record<string, unknown>): ToolCallResult {
    const target = this.findBot(a.bot as string, chief);
    if (!target) return fail(`No Bot named "${a.bot}".`);
    const limit = Math.min(60, Math.max(1, Number(a.limit ?? 20)));
    const conv = this.deps.store.conversations.directForBot(target.id);
    const msgs = this.deps.store.messages.list(conv.id, 500).slice(-limit);
    if (!msgs.length) return text(`${target.name} has no messages yet.`);
    const lines = msgs.map((m) => {
      const who = m.role === "user" ? "User" : m.role === "system" ? "System" : target.name;
      const tools = m.parts.filter((p) => p.type === "tool-call").map((p) => (p as { name: string }).name);
      return `[${m.createdAt.slice(0, 16).replace("T", " ")}] ${who}: ${oneLine(m.content, 600)}${tools.length ? ` (tools: ${[...new Set(tools)].join(", ")})` : ""}`;
    });
    return text(`${target.name} (${target.label ?? "no role"}), last ${msgs.length} messages:\n${lines.join("\n")}`);
  }

  private async hire(chief: Bot, a: Record<string, unknown>): Promise<ToolCallResult> {
    const { store } = this.deps;
    const bots = store.bots.list();
    // The user's own limits (Settings → Spaces → Hiring); 0 means no limit.
    const { hireLimitPerDay, teamSizeLimit } = store.settings.get();
    if (teamSizeLimit > 0 && bots.length >= teamSizeLimit)
      return fail(`The team is at the user's limit of ${teamSizeLimit} Bots (Settings → Spaces → Hiring). Retire one, or ask the user to raise the limit.`);
    const dayAgo = Date.now() - 24 * 3600_000;
    const recent = bots.filter((b) => b.hiredBy === chief.id && Date.parse(b.createdAt) > dayAgo).length;
    if (hireLimitPerDay > 0 && recent >= hireLimitPerDay)
      return fail(`You have hired ${recent} Bots in the last 24 hours, the user's limit (Settings → Spaces → Hiring). Ask the user to raise it, or use the team you have.`);
    const templateId = typeof a.template === "string" ? a.template.trim() : "";
    const modelRef = this.normaliseModel(a.model as string | undefined);
    let template = templateId ? findTemplate(templateId) : undefined;
    if (templateId && !template) return fail(`No template "${templateId}". Templates: ${allTemplates().map((t) => t.id).join(", ")}`);
    if (template?.primary) return fail("There is only one Chief of Staff: you.");
    if (!template) {
      const role = String(a.role ?? "").trim();
      const brief = String(a.brief ?? "").trim();
      if (!role || !brief) return fail("A custom hire needs a role and a brief (or pass a template id).");
      const custom = (a.routines as { name: string; cron?: string; instruction: string }[] | undefined) ?? [];
      for (const r of custom) {
        if (r.cron) {
          const v = validateCron(r.cron, store.settings.get().timezone);
          if (!v.ok) return fail(`Routine "${r.name}": ${v.error}`);
        }
      }
      const name = String(a.name ?? "").trim() || role.split(/\s+/)[0]!;
      template = {
        id: "custom",
        name,
        label: role.slice(0, 60),
        category: "work",
        emoji: "🤖",
        color: ["#7c5cff", "#0ea5e9", "#f59e0b", "#22c55e", "#ec4899", "#14b8a6"][bots.length % 6]!,
        shape: "squircle",
        tagline: role,
        brief: brief.slice(0, MAX_BRIEF_LENGTH),
        memory: [],
        routines: custom.slice(0, 10).map((r) => ({ name: r.name, cron: r.cron, instruction: r.instruction })),
        skills: [],
        rules: [],
        asks: [],
      };
    }
    const { bot, routines, skipped } = instantiateTemplate(
      { store, scheduler: this.deps.scheduler, emit: this.deps.emit },
      template,
      { name: typeof a.name === "string" && a.name.trim() ? a.name.trim() : undefined, modelRef, makePrimary: false, hiredBy: chief.id, spaceId: chief.spaceId },
    );
    const reason = oneLine(String(a.reason ?? ""), 200);
    this.deps.emit({ type: "notify", botId: chief.id, conversationId: this.deps.conversationFor(chief.id), title: `${chief.name} hired ${bot.name}`, body: `${bot.label ?? ""}${reason ? ` — ${reason}` : ""}`, kind: "reply" });

    let taskNote = "";
    const first = typeof a.first_task === "string" ? a.first_task.trim() : "";
    if (first) {
      const task = store.tasks.create({ title: oneLine(first, 200), detail: first, ownerBotId: bot.id, createdBy: chief.id });
      this.deps.emit({ type: "task.updated", task });
      this.deps.wakeWith(bot.id, `${introductionMessage(template, routines, chief.name)}\n\nAfter introducing yourself, start on your first task from ${chief.name} [${task.id.slice(0, 8)}]: ${first}\nWhen done, call task_update with status done and the result.`, chief.id);
      taskNote = ` First task [${task.id.slice(0, 8)}] is on the board and ${bot.name} has started.`;
    } else {
      this.deps.wakeWith(bot.id, introductionMessage(template, routines, chief.name), chief.id);
    }
    return text(
      `Hired ${bot.name} (${bot.label}) with ${routines.length} routine(s)${skipped.length ? `; skipped: ${skipped.join("; ")}` : ""}.${taskNote} It is introducing itself to the user in its own chat. Tell the user who you hired and why.`,
    );
  }

  private update(chief: Bot, a: Record<string, unknown>): ToolCallResult {
    const target = this.findBot(a.bot as string, chief);
    if (!target) return fail(`No Bot named "${a.bot}".`);
    const patch: { brief?: string; label?: string; modelRef?: string } = {};
    if (typeof a.brief === "string" && a.brief.trim()) patch.brief = a.brief.trim().slice(0, MAX_BRIEF_LENGTH);
    if (typeof a.role === "string" && a.role.trim()) patch.label = a.role.trim().slice(0, 60);
    const model = this.normaliseModel(a.model as string | undefined);
    if (a.model && !model) return fail(`"${a.model}" is not a model ref (provider:model).`);
    if (model) patch.modelRef = model;
    if (!Object.keys(patch).length) return fail("Nothing to change: pass brief, role or model.");
    const bot = this.deps.store.bots.update(target.id, patch);
    if (bot) this.deps.emit({ type: "bot.updated", bot });
    return text(`Updated ${target.name}: ${Object.keys(patch).join(", ")}.`);
  }

  private retire(chief: Bot, a: Record<string, unknown>): ToolCallResult {
    const { store } = this.deps;
    const target = this.findBot(a.bot as string, chief);
    if (!target) return fail(`No Bot named "${a.bot}".`);
    if (target.id === chief.id) return fail("You cannot retire yourself.");
    for (const r of store.routines.list(target.id)) {
      if (!r.enabled) continue;
      const paused = store.routines.update(r.id, { enabled: false });
      if (paused) this.deps.scheduler.schedule(paused);
    }
    const bot = store.bots.update(target.id, { hidden: true, pinned: false });
    if (bot) this.deps.emit({ type: "bot.updated", bot });
    this.deps.emit({ type: "notify", botId: chief.id, conversationId: this.deps.conversationFor(chief.id), title: `${chief.name} retired ${target.name}`, body: oneLine(String(a.reason ?? ""), 160), kind: "reply" });
    return text(`${target.name} is retired: hidden and its routines paused. The user can bring it back from the sidebar's hidden Bots.`);
  }

  private assignRoutine(chief: Bot, a: Record<string, unknown>): ToolCallResult {
    const { store } = this.deps;
    const target = this.findBot(a.bot as string, chief);
    if (!target) return fail(`No Bot named "${a.bot}".`);
    if (store.routines.countForBot(target.id) >= MAX_ROUTINES_PER_BOT) return fail(`${target.name} already has ${MAX_ROUTINES_PER_BOT} routines.`);
    const cron = typeof a.cron === "string" && a.cron.trim() ? a.cron.trim() : undefined;
    if (cron) {
      const v = validateCron(cron, store.settings.get().timezone);
      if (!v.ok) return fail(v.error);
    }
    const routine: Routine = this.deps.scheduler.schedule(
      store.routines.create({
        botId: target.id,
        name: String(a.name ?? "Routine").slice(0, 80),
        instruction: String(a.instruction ?? "").slice(0, 10_000),
        trigger: cron ? { kind: "schedule", cron } : { kind: "manual" },
        timezone: null,
        enabled: true,
        webhookKey: null,
        nextRunAt: null,
      }),
    );
    return text(`${target.name} now runs "${routine.name}"${routine.nextRunAt ? `; next run ${routine.nextRunAt}` : " (manual)"}.`);
  }

  private async taskCreate(caller: Bot, a: Record<string, unknown>): Promise<ToolCallResult> {
    const { store } = this.deps;
    const title = String(a.title ?? "").trim();
    if (!title) return fail("A task needs a title.");
    const owner = this.resolveOwner(caller, a.owner as string | undefined, caller.id);
    if ("error" in owner) return fail(owner.error);
    const priority = TASK_PRIORITIES.includes(a.priority as never) ? (a.priority as Task["priority"]) : "normal";
    const detail = String(a.detail ?? "").slice(0, 8000);
    const task = store.tasks.create({ title: title.slice(0, 200), detail, ownerBotId: owner.id, createdBy: caller.id, priority, dueAt: (a.due as string) || null });
    this.deps.emit({ type: "task.updated", task });
    const id8 = task.id.slice(0, 8);
    if (owner.id && owner.id !== caller.id) {
      const target = store.bots.get(owner.id)!;
      const r = await this.deps.sendToBot(
        caller.id,
        target.name,
        `New task [${id8}] (${priority}${task.dueAt ? `, due ${task.dueAt}` : ""}): ${title}\n${detail}\nWhen finished call task_update {"id":"${id8}","status":"done","result":"…"} with the actual result; if stuck, status "blocked" with what you need.`,
      );
      if (r.isError) return text(`Task [${id8}] is on the board for ${target.name}, but it could not be woken now: ${r.content.map((p) => (p.type === "text" ? p.text : "")).join(" ")}`);
      return text(`Task [${id8}] assigned to ${target.name}; it has been messaged and is working on it. You will hear back when it updates the task.`);
    }
    if (owner.id === null) {
      this.deps.emit({ type: "notify", botId: caller.id, conversationId: this.deps.conversationFor(caller.id), title: `${caller.name} needs you`, body: title, kind: "needs-attention" });
      return text(`Task [${id8}] is on the board for the user, who was notified. Tell them in your reply too.`);
    }
    return text(`Task [${id8}] is on the board for you.`);
  }

  private async taskUpdate(caller: Bot, a: Record<string, unknown>): Promise<ToolCallResult> {
    const { store } = this.deps;
    const task = store.tasks.find(String(a.id ?? ""));
    if (!task) return fail(`No task "${a.id}". Use task_list.`);
    if (!caller.isPrimary && task.ownerBotId !== caller.id && task.createdBy !== caller.id) return fail("You can only update tasks you own or created.");
    const patch: Parameters<Store["tasks"]["update"]>[1] = {};
    if (a.status && TASK_STATUSES.includes(a.status as never)) patch.status = a.status as Task["status"];
    if (typeof a.result === "string") patch.result = a.result.slice(0, 8000);
    if (a.priority && TASK_PRIORITIES.includes(a.priority as never)) patch.priority = a.priority as Task["priority"];
    if (typeof a.due === "string") patch.dueAt = a.due || null;
    let reassignedTo: Bot | undefined;
    if (typeof a.owner === "string" && a.owner) {
      const owner = this.resolveOwner(caller, a.owner, task.ownerBotId);
      if ("error" in owner) return fail(owner.error);
      patch.ownerBotId = owner.id;
      if (owner.id && owner.id !== task.ownerBotId && owner.id !== caller.id) reassignedTo = store.bots.get(owner.id);
    }
    const updated = store.tasks.update(task.id, patch)!;
    this.deps.emit({ type: "task.updated", task: updated });
    const id8 = task.id.slice(0, 8);
    const notes: string[] = [`Task [${id8}] is now ${updated.status}.`];
    if (reassignedTo) {
      await this.deps.sendToBot(caller.id, reassignedTo.name, `Task [${id8}] is now yours: ${updated.title}\n${updated.detail}\nUpdate it with task_update when done.`);
      notes.push(`${reassignedTo.name} has been told.`);
    }
    // Close the loop: whoever delegated it hears about done / blocked.
    const closedOrBlocked = patch.status === "done" || patch.status === "blocked" || patch.status === "dropped";
    if (closedOrBlocked && task.createdBy && task.createdBy !== caller.id) {
      const creator = store.bots.get(task.createdBy);
      if (creator) {
        await this.deps.sendToBot(caller.id, creator.name, `Task [${id8}] "${updated.title}" is ${updated.status}. ${updated.result ? `Result: ${updated.result}` : ""}`.trim());
        notes.push(`${creator.name} has been told.`);
      }
    } else if (closedOrBlocked && task.createdBy === null) {
      this.deps.emit({ type: "notify", botId: caller.id, conversationId: this.deps.conversationFor(caller.id), title: `${updated.title}: ${updated.status}`, body: oneLine(updated.result ?? "", 160), kind: "reply" });
    }
    return text(notes.join(" "));
  }

  private taskList(caller: Bot, a: Record<string, unknown>): ToolCallResult {
    const { store } = this.deps;
    let ownerFilter: string | null | undefined;
    if (typeof a.owner === "string" && a.owner) {
      const o = this.resolveOwner(caller, a.owner, null);
      if ("error" in o) return fail(o.error);
      ownerFilter = o.id;
    }
    const tasks = store.tasks.list({ ownerBotId: ownerFilter, includeClosed: a.include_closed === true });
    if (!tasks.length) return text("No tasks.");
    const name = (id: string | null) => (id ? (store.bots.get(id)?.name ?? "?") : "user");
    return text(
      tasks
        .slice(0, 80)
        .map((t) => `[${t.id.slice(0, 8)}] ${t.status} ${t.priority} · ${t.title} · owner ${name(t.ownerBotId)} · from ${name(t.createdBy)}${t.dueAt ? ` · due ${t.dueAt}` : ""}${t.result ? `\n    result: ${oneLine(t.result, 300)}` : ""}`)
        .join("\n"),
    );
  }
}

