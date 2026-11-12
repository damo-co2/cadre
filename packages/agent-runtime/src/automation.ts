import { Cron } from "croner";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Store } from "@grokbot/db";
import type { ToolCallResult } from "@grokbot/sandbox";
import type { Bot, Routine, RoutineRun, RoutineTrigger, ServerEvent, Skill } from "@grokbot/shared";
import {
  MAX_ACCOUNT_RUNS_PER_HOUR,
  MAX_ROUTINES_PER_BOT,
  MAX_ROUTINE_RUNS_PER_HOUR,
  MIN_ROUTINE_SPACING_MIN,
  skillNameSchema,
} from "@grokbot/shared";

/**
 * Skills and routines, the way Grok Bot defines them:
 *   Skill   = "a reusable set of instructions for how to do a task", shared by every Bot.
 *   Routine = "tells one Bot when to run a workflow: on a schedule, or when something happens".
 * Bots create both by calling tools from chat ("Save the process we just used as a skill called…",
 * "Every weekday at 8am, …"). The scheduler fires routines into the Bot's own conversation.
 */

export interface RuntimeToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  zodShape: Record<string, z.ZodTypeAny>;
}

const text = (t: string): ToolCallResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): ToolCallResult => ({ isError: true, content: [{ type: "text", text: t }] });

// ---------- cron helpers ----------

export function validateCron(cron: string, timezone?: string | null): { ok: true; next: Date | null } | { ok: false; error: string } {
  let job: Cron;
  try {
    job = new Cron(cron, { timezone: timezone ?? undefined, paused: true });
  } catch (err) {
    return { ok: false, error: `Invalid schedule "${cron}": ${(err as Error).message}. Use 5-field cron, e.g. "0 8 * * 1-5" (weekdays 08:00).` };
  }
  const runs = job.nextRuns(3);
  job.stop();
  for (let i = 1; i < runs.length; i++) {
    const gapMin = (runs[i].getTime() - runs[i - 1].getTime()) / 60_000;
    if (gapMin < MIN_ROUTINE_SPACING_MIN) {
      return { ok: false, error: `Runs must be at least ${MIN_ROUTINE_SPACING_MIN} minutes apart (this schedule runs every ${Math.round(gapMin)} min).` };
    }
  }
  return { ok: true, next: runs[0] ?? null };
}

function describeTrigger(t: RoutineTrigger, tz: string | null): string {
  if (t.kind === "schedule") return `on schedule "${t.cron}"${tz ? ` (${tz})` : ""}`;
  if (t.kind === "webhook") return "when its webhook is called";
  return "only when run manually";
}

// ---------- scheduler ----------

export class RoutineScheduler {
  private jobs = new Map<string, Cron>();

  constructor(
    private store: Store,
    private emit: (e: ServerEvent) => void,
    private runRoutine: (routine: Routine, run: RoutineRun, payload?: string) => Promise<void>,
  ) {}

  start(): void {
    for (const r of this.store.routines.list()) this.schedule(r);
  }

  stop(): void {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
  }

  /** (Re)arms the cron job for a routine and refreshes nextRunAt. */
  schedule(routine: Routine): Routine {
    this.unschedule(routine.id);
    let nextRunAt: string | null = null;
    if (routine.enabled && routine.trigger.kind === "schedule") {
      const settings = this.store.settings.get();
      const tz = routine.timezone ?? settings.timezone ?? undefined;
      try {
        const job = new Cron(routine.trigger.cron, { timezone: tz, protect: true }, () => void this.fire(routine.id, "schedule"));
        this.jobs.set(routine.id, job);
        nextRunAt = job.nextRun()?.toISOString() ?? null;
      } catch (err) {
        console.warn(`[routines] cannot schedule ${routine.name}: ${(err as Error).message}`);
      }
    }
    const updated = this.store.routines.update(routine.id, { nextRunAt }) ?? routine;
    this.emit({ type: "routine.updated", routine: updated });
    return updated;
  }

  unschedule(id: string): void {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
  }

  async fire(id: string, source: RoutineRun["source"], payload?: string): Promise<RoutineRun | null> {
    const routine = this.store.routines.get(id);
    if (!routine) return null;
    if (!routine.enabled && source !== "test") return null;
    const conversationId = this.store.conversations.directForBot(routine.botId).id;

    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const limitHit =
      this.store.routines.runsSince(hourAgo, routine.id) >= MAX_ROUTINE_RUNS_PER_HOUR ||
      this.store.routines.runsSince(hourAgo) >= MAX_ACCOUNT_RUNS_PER_HOUR;
    const run = this.store.routines.startRun(routine.id, source, conversationId);
    if (limitHit) {
      const skipped = this.store.routines.finishRun(run.id, { status: "skipped", error: "Automation run rate limit exceeded" })!;
      this.emit({ type: "routine.run", run: skipped });
      return skipped;
    }
    this.emit({ type: "routine.run", run });
    const job = this.jobs.get(routine.id);
    const updated = this.store.routines.update(routine.id, {
      lastRunAt: run.startedAt,
      nextRunAt: job?.nextRun()?.toISOString() ?? routine.nextRunAt,
    });
    if (updated) this.emit({ type: "routine.updated", routine: updated });
    void this.runRoutine(routine, run, payload).catch((err) => {
      const failed = this.store.routines.finishRun(run.id, { status: "error", error: String(err) });
      if (failed) this.emit({ type: "routine.run", run: failed });
    });
    return run;
  }
}

// ---------- tools the Bot calls from chat ----------

/** Skills that live outside the database (installed plugins and skills folders). */
export interface ExtraSkillSource {
  list(): { name: string; description: string; plugin: string }[];
  read(name: string): string | null;
}

export class AutomationTools {
  private extra: ExtraSkillSource | null = null;

  constructor(
    private store: Store,
    private emit: (e: ServerEvent) => void,
    private scheduler: RoutineScheduler,
  ) {}

  /** Plugin skills join the saved ones in the index, skill_list and skill_read. */
  useExtraSkills(src: ExtraSkillSource): void {
    this.extra = src;
  }

  private extraSkills(): { name: string; description: string; plugin: string }[] {
    try {
      return this.extra?.list() ?? [];
    } catch {
      return [];
    }
  }

  /** Skill index for the system prompt (names + descriptions only; content is read on demand). */
  skillsPromptSection(bot: Bot): string {
    const skills = this.store.skills.list();
    const pluginSkills = this.extraSkills();
    const routines = this.store.routines.list(bot.id);
    const lines: string[] = [];
    if (skills.length || pluginSkills.length) {
      lines.push("Skills available to you (call skill_read before following one):");
      for (const s of skills) lines.push(`- ${s.name}: ${s.description}`);
      for (const s of pluginSkills) lines.push(`- ${s.name}: ${s.description.length > 220 ? `${s.description.slice(0, 219)}…` : s.description} [${s.plugin}]`);
    } else {
      lines.push("No skills saved yet. When the user asks you to remember a process, save it with skill_save.");
    }
    if (routines.length) {
      lines.push("", `Your routines (${routines.length}/${MAX_ROUTINES_PER_BOT}):`);
      for (const r of routines) lines.push(`- ${r.name} [${r.id.slice(0, 8)}] ${r.enabled ? "active" : "paused"}, ${describeTrigger(r.trigger, r.timezone)}`);
    }
    lines.push(
      "",
      "When the user asks for something on a schedule or when something happens, confirm the schedule, timezone, input source, expected result and approval boundary in one short message, then call routine_create. A new routine waits for its next scheduled time; offer routine_run_now to test it.",
    );
    return lines.join("\n");
  }

  specs(): RuntimeToolSpec[] {
    const mk = (name: string, description: string, zodShape: Record<string, z.ZodTypeAny>): RuntimeToolSpec => ({
      name,
      description,
      zodShape,
      inputSchema: z.toJSONSchema(z.object(zodShape)) as Record<string, unknown>,
    });
    return [
      mk("skill_list", "List the saved skills (name + description). Skills are reusable instructions shared by every Bot.", {}),
      mk("skill_read", "Read a skill's full instructions before following it.", { name: z.string().describe("Skill name, e.g. weekly-digest") }),
      mk(
        "skill_save",
        "Save or update a skill: a reusable set of instructions for how to do a task. Cover when to use it, inputs, the steps, validation, the expected output and where to pause for approval.",
        {
          name: z.string().describe("Short handle: lowercase letters, digits, dashes (e.g. weekly-competitor-digest)"),
          description: z.string().describe("One line: what it does and when to use it"),
          content: z.string().describe("Markdown instructions"),
          taught: z.boolean().optional().describe("true when the skill was learned from a Teach a task recording"),
        },
      ),
      mk("routine_list", "List this Bot's routines with their schedule, state and ids.", {}),
      mk(
        "routine_create",
        `Create a routine: tells this Bot when to run an instruction. trigger "schedule" needs a 5-field cron (runs at least ${MIN_ROUTINE_SPACING_MIN} min apart); "webhook" returns a URL + key the user can call; "manual" runs only via routine_run_now. Max ${MAX_ROUTINES_PER_BOT} per Bot.`,
        {
          name: z.string().describe("Short name shown in the Bot's details"),
          instruction: z.string().describe("What to do on each run, in the user's words, including what to deliver and where to stop for approval"),
          trigger: z.enum(["schedule", "webhook", "manual"]),
          cron: z.string().optional().describe('5-field cron for schedule triggers, e.g. "0 8 * * 1-5"'),
          timezone: z.string().optional().describe("IANA timezone, defaults to the user's"),
        },
      ),
      mk("routine_update", "Pause, resume, rename or edit a routine.", {
        id: z.string().describe("Routine id (full or first 8 chars)"),
        name: z.string().optional(),
        instruction: z.string().optional(),
        cron: z.string().optional(),
        timezone: z.string().optional(),
        enabled: z.boolean().optional(),
      }),
      mk("routine_delete", "Delete a routine and its run history.", { id: z.string() }),
      mk("routine_run_now", "Test a routine immediately instead of waiting for its schedule.", { id: z.string() }),
    ];
  }

  isRuntimeTool(name: string): boolean {
    return this.specs().some((s) => s.name === name);
  }

  async call(bot: Bot, name: string, input: unknown): Promise<ToolCallResult> {
    const spec = this.specs().find((s) => s.name === name);
    if (!spec) return fail(`Unknown tool ${name}`);
    const parsed = z.object(spec.zodShape).safeParse(input ?? {});
    if (!parsed.success) return fail(`Invalid input for ${name}: ${parsed.error.message}`);
    const a = parsed.data as Record<string, unknown>;
    const resolveRoutine = (id: string) =>
      this.store.routines.list(bot.id).find((r) => r.id === id || r.id.startsWith(String(id)));

    switch (name) {
      case "skill_list": {
        const skills = [
          ...this.store.skills.list().map((s) => `${s.name}: ${s.description}`),
          ...this.extraSkills().map((s) => `${s.name}: ${s.description} [plugin: ${s.plugin}]`),
        ];
        return text(skills.length ? skills.join("\n") : "No skills saved yet.");
      }
      case "skill_read": {
        const wanted = String(a.name).replace(/^\//, "");
        const s = this.store.skills.getByName(wanted);
        if (s) return text(`# ${s.name}\n${s.description}\n\n${s.content}`);
        const fromPlugin = this.extra?.read(wanted) ?? null;
        return fromPlugin ? text(fromPlugin) : fail(`No skill named "${a.name}". Use skill_list.`);
      }
      case "skill_save": {
        const nm = skillNameSchema.safeParse(a.name);
        if (!nm.success) return fail(`Invalid skill name: ${nm.error.issues[0]?.message}`);
        const skill: Skill = this.store.skills.upsert({
          name: nm.data,
          description: String(a.description),
          content: String(a.content),
          source: a.taught === true ? "taught" : "written",
        });
        this.emit({ type: "skill.updated", skill });
        return text(`Saved skill "${skill.name}". Every Bot can use it by name.`);
      }
      case "routine_list": {
        const list = this.store.routines.list(bot.id);
        if (!list.length) return text("No routines yet.");
        return text(
          list
            .map(
              (r) =>
                `${r.name} [${r.id.slice(0, 8)}] ${r.enabled ? "active" : "paused"}; ${describeTrigger(r.trigger, r.timezone)}; next ${r.nextRunAt ?? "—"}; last ${r.lastRunAt ?? "never"}\n  ${r.instruction.slice(0, 200)}`,
            )
            .join("\n"),
        );
      }
      case "routine_create": {
        if (this.store.routines.countForBot(bot.id) >= MAX_ROUTINES_PER_BOT) return fail(`This Bot already has ${MAX_ROUTINES_PER_BOT} routines.`);
        const tz = (a.timezone as string | undefined) ?? null;
        let trigger: RoutineTrigger;
        if (a.trigger === "schedule") {
          if (!a.cron) return fail("A schedule trigger needs a cron expression.");
          const v = validateCron(String(a.cron), tz ?? this.store.settings.get().timezone);
          if (!v.ok) return fail(v.error);
          trigger = { kind: "schedule", cron: String(a.cron) };
        } else if (a.trigger === "webhook") trigger = { kind: "webhook" };
        else trigger = { kind: "manual" };
        const routine = this.store.routines.create({
          botId: bot.id,
          name: String(a.name),
          instruction: String(a.instruction),
          trigger,
          timezone: tz,
          enabled: true,
          webhookKey: trigger.kind === "webhook" ? randomBytes(24).toString("base64url") : null,
          nextRunAt: null,
        });
        const armed = this.scheduler.schedule(routine);
        const extra =
          trigger.kind === "webhook"
            ? `\nWebhook: POST /api/hooks/${routine.id} with header "Authorization: Bearer ${routine.webhookKey}". A 200 means accepted and started, not finished.`
            : trigger.kind === "schedule"
              ? `\nNext run: ${armed.nextRunAt ?? "unknown"}.`
              : "";
        return text(`Created routine "${routine.name}" [${routine.id.slice(0, 8)}], ${describeTrigger(trigger, tz)}.${extra}`);
      }
      case "routine_update": {
        const r = resolveRoutine(String(a.id));
        if (!r) return fail("No such routine for this Bot.");
        const patch: Parameters<Store["routines"]["update"]>[1] = {};
        if (typeof a.name === "string") patch.name = a.name;
        if (typeof a.instruction === "string") patch.instruction = a.instruction;
        if (typeof a.enabled === "boolean") patch.enabled = a.enabled;
        if (typeof a.timezone === "string") patch.timezone = a.timezone;
        if (typeof a.cron === "string") {
          const v = validateCron(a.cron, (a.timezone as string | undefined) ?? r.timezone ?? this.store.settings.get().timezone);
          if (!v.ok) return fail(v.error);
          patch.trigger = { kind: "schedule", cron: a.cron };
        }
        const updated = this.store.routines.update(r.id, patch)!;
        this.scheduler.schedule(updated);
        return text(`Updated routine "${updated.name}": ${updated.enabled ? "active" : "paused"}, ${describeTrigger(updated.trigger, updated.timezone)}.`);
      }
      case "routine_delete": {
        const r = resolveRoutine(String(a.id));
        if (!r) return fail("No such routine for this Bot.");
        this.scheduler.unschedule(r.id);
        this.store.routines.delete(r.id);
        this.emit({ type: "routine.deleted", routineId: r.id, botId: bot.id });
        return text(`Deleted routine "${r.name}".`);
      }
      case "routine_run_now": {
        const r = resolveRoutine(String(a.id));
        if (!r) return fail("No such routine for this Bot.");
        const run = await this.scheduler.fire(r.id, "test");
        return run
          ? run.status === "skipped"
            ? fail(run.error ?? "Skipped")
            : text(`Started a test run of "${r.name}". It runs in this conversation after the current turn finishes.`)
          : fail("Could not start the routine.");
      }
    }
    return fail(`Unhandled tool ${name}`);
  }
}
