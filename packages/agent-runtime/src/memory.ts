import { z } from "zod";
import type { Store } from "@grokbot/db";
import type { DriverRegistry } from "@grokbot/model-drivers";
import type { ToolCallResult } from "@grokbot/sandbox";
import type { Bot, ProfileCategory, ProfileFact } from "@grokbot/shared";
import { PROFILE_CATEGORIES, PROFILE_CATEGORY_LABELS, parseModelRef } from "@grokbot/shared";
import type { RuntimeToolSpec } from "./automation.js";

/**
 * Memory, Grok Bot style: no memory screen. A background pass after a turn rewrites
 * the Bot's facts (role, preferences, summaries of prior work; ≤100 facts / ≤4000 chars)
 * and the few user facts every Bot shares (name, timezone, how they like to work).
 * "What do you remember about me?" and "Forget that…" are handled by the model reading
 * these facts and by the rewrite dropping what the user asked to forget.
 */

export const MAX_BOT_FACTS = 150;
export const MAX_BOT_FACT_CHARS = 8000;
/**
 * The profile (About you) has no size limit. Each turn sends a Bot the facts that matter for it, up to this
 * many characters: the user's own words, who they are and how they like things done, then whatever the chat
 * is about. The rest are a recall_about_user search away.
 */
export const PROFILE_PROMPT_CHARS = 6000;

const STOP_WORDS = new Set(
  "the and for with from that this these those are was were has have had his her their they them she its into than then about over under not does did will would should can could just also very more most less only per via any all who what when where which how want wants likes prefers user damien".split(" "),
);
/** The meaningful words of a text (3+ letters, no filler), for matching facts to a chat. */
export function factWords(t: string): Set<string> {
  const stem = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w); // songs → song
  const out = new Set<string>();
  for (const token of t.toLowerCase().match(/[a-z0-9][a-z0-9+#-]{2,}/g) ?? []) {
    // "car-insurance" and "70-song" match "insurance" and "song"; "cr-v" still matches as a whole.
    for (const w of [token, ...(token.includes("-") ? token.split("-") : [])]) if (w.length >= 3 && !STOP_WORDS.has(w)) out.add(stem(w));
  }
  return out;
}
const overlap = (a: Set<string>, b: Set<string>) => {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
};
/** 0–1: how much two facts say the same thing (shared words over all words). */
export function factSimilarity(a: string, b: string): number {
  const A = factWords(a);
  const B = factWords(b);
  if (!A.size || !B.size) return 0;
  const n = overlap(A, B);
  return n / (A.size + B.size - n);
}
/** Facts this close are the same fact said again: merged instead of added. */
const SAME_FACT = 0.55;

/** Share of the budget for who the user is, and for general how-they-work rules that don't match this chat. */
const IDENTITY_CHARS = 2000;
const GENERAL_STYLE_CHARS = 1500;

/**
 * The facts worth sending this turn, within the budget:
 *   1. who the user is (About, for every space): always;
 *   2. facts that match this chat (the Bot's role and the latest messages), best match first;
 *   3. short general rules on how they like things done, if there's room.
 */
export function pickProfileFacts(facts: ProfileFact[], context: string, budget = PROFILE_PROMPT_CHARS): { shown: ProfileFact[]; hidden: number } {
  const ctx = factWords(context);
  const shown = new Set<ProfileFact>();
  let used = 0;
  const take = (list: ProfileFact[], cap: number) => {
    let spent = 0;
    for (const f of list) {
      const cost = f.text.length + 3;
      if (shown.has(f) || spent + cost > cap || used + cost > budget) continue;
      shown.add(f);
      spent += cost;
      used += cost;
    }
  };
  const byLength = (a: ProfileFact, b: ProfileFact) => a.text.length - b.text.length;
  take(facts.filter((f) => f.category === "about" && !f.spaceId).sort(byLength), IDENTITY_CHARS);
  // Rare shared words count for more than common ones: one word only this fact uses is a match, two common
  // words like "data" and "check" aren't.
  const factSets = facts.map((f) => factWords(f.text));
  const used_by = new Map<string, number>();
  for (const ws of factSets) for (const w of ws) used_by.set(w, (used_by.get(w) ?? 0) + 1);
  const matched = facts
    .map((f, i) => {
      let hits = 0;
      for (const w of factSets[i]!) if (ctx.has(w)) hits += Math.log2(Math.max(facts.length, 8) / (used_by.get(w) ?? 1));
      return { f, hits };
    })
    .filter((m) => m.hits >= 6)
    .sort((a, b) => b.hits - a.hits || (b.f.source === "you" ? 1 : 0) - (a.f.source === "you" ? 1 : 0) || a.f.text.length - b.f.text.length)
    .map((m) => m.f);
  take(matched, budget);
  take(facts.filter((f) => f.category === "style").sort(byLength), GENERAL_STYLE_CHARS);
  // Keep them in the order they were learned, so the prompt reads the same way turn to turn.
  const ordered = facts.filter((f) => shown.has(f));
  return { shown: ordered, hidden: facts.length - ordered.length };
}

const text = (t: string): ToolCallResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): ToolCallResult => ({ isError: true, content: [{ type: "text", text: t }] });

/** What this turn is about, for picking facts: the Bot's role and the latest messages in the chat. */
export function turnContext(store: Store, bot: Bot, conversationId?: string): string {
  const recent = conversationId ? store.messages.list(conversationId, 10).map((m) => m.content.slice(0, 1500)) : [];
  return [bot.name, bot.label ?? "", bot.brief ?? "", ...recent].join("\n");
}

/** The About you section of a Bot's prompt: the facts that matter for this turn (every space plus the Bot's own), by section. */
export function profilePromptSection(store: Store, bot: Bot, conversationId?: string): string {
  const all = store.memories.profile(bot.spaceId);
  const { shown: facts, hidden } = pickProfileFacts(all, turnContext(store, bot, conversationId));
  const lines = ["## About the user", "What Bots have learned about the user over time. The user can see and edit this in Settings → About you."];
  if (!facts.length) lines.push("(Nothing yet.)");
  for (const cat of PROFILE_CATEGORIES) {
    const inCat = facts.filter((f) => f.category === cat);
    if (!inCat.length) continue;
    lines.push(`${PROFILE_CATEGORY_LABELS[cat]}:`, ...inCat.map((f) => `- ${f.text}`));
  }
  lines.push(
    "Use this to work the way they would want: suggest things they like, avoid what they dislike, plan around their routines, use people's names, and match how they like things done. If something here looks out of date, check with them.",
    ...(hidden
      ? [`${hidden} more fact${hidden === 1 ? "" : "s"} about the user aren't shown here (the ones above fit this chat best). Before asking the user something they may have told a Bot already, search them with recall_about_user.`]
      : []),
    "When the user tells you something lasting about themselves (who they are, likes and dislikes, routines, people in their life, how they want things done), save it right away with remember_about_user. When they ask you to forget something, use forget_about_user. Never save passwords, card numbers or other secrets.",
    "If one of their routines is a recurring ask you could take off their hands (a weekly check, a daily summary), offer to set it up as a routine.",
  );
  return lines.join("\n");
}

export function memoryPromptSection(store: Store, bot: Bot, conversationId?: string): string {
  const own = store.memories.list(bot.id).map((f) => `- ${f.text}`);
  const lines = [profilePromptSection(store, bot, conversationId), ""];
  if (own.length) lines.push("What you remember (your role, preferences, past work):", ...own);
  else lines.push("You have no memories of your own yet.");
  lines.push("Memory can be stale: verify current data before relying on it. If the user asks what you remember, answer from these lists. If they ask you to forget something, confirm and do not mention it again.");
  return lines.join("\n");
}

/** remember_about_user / forget_about_user: Bots save what the user tells them, at once. */
export class ProfileTools {
  private static NAMES = new Set(["remember_about_user", "forget_about_user", "recall_about_user"]);

  constructor(
    private store: Store,
    private onChange: (learned?: string[]) => void,
  ) {}

  has(name: string): boolean {
    return ProfileTools.NAMES.has(name);
  }

  specs(): RuntimeToolSpec[] {
    const mk = (name: string, description: string, zodShape: Record<string, z.ZodTypeAny>): RuntimeToolSpec => ({
      name,
      description,
      zodShape,
      inputSchema: z.toJSONSchema(z.object(zodShape)) as Record<string, unknown>,
    });
    return [
      mk(
        "remember_about_user",
        "Save something lasting about the user to their profile (About you), shared with the other Bots. Use when they tell you who they are, what they like or dislike, a routine, someone in their life, or how they want things done. One fact per call, written as a short third-person sentence.",
        {
          fact: z.string().describe("e.g. 'Goes to the gym Tue and Thu at 6am' or 'Prefers short answers with a checklist'"),
          section: z.enum(PROFILE_CATEGORIES).describe("about = who they are; likes = likes and dislikes; routines = habits and schedule; people = family, friends, colleagues, places; style = how they like things done"),
          scope: z.enum(["everywhere", "this-space"]).default("everywhere").describe("this-space for things that only matter here (work projects in a Work space, family errands in a Personal space); everywhere for who they are"),
        },
      ),
      mk(
        "recall_about_user",
        "Search everything Bots have learned about the user (About you), including facts not shown in your instructions. Use it before asking the user something they may already have told a Bot.",
        { query: z.string().min(2).describe("What you want to know, e.g. 'car insurance', 'dietary', 'wife', 'Jenkins'") },
      ),
      mk("forget_about_user", "Remove facts from the user's profile when they ask you to forget something. Matches facts containing the given words.", {
        match: z.string().min(3).describe("Words from the fact to forget"),
      }),
    ];
  }

  call(bot: Bot, name: string, input: unknown): ToolCallResult {
    if (name === "remember_about_user") {
      const a = (input ?? {}) as { fact?: string; section?: string; scope?: string };
      const fact = String(a.fact ?? "").trim();
      if (!fact) return fail("Give the fact to remember.");
      if (fact.length > 500) return fail("Keep it under 500 characters: one short sentence per fact.");
      const category = (PROFILE_CATEGORIES as readonly string[]).includes(a.section ?? "") ? (a.section as ProfileCategory) : "about";
      const spaceId = a.scope === "this-space" ? bot.spaceId : null;
      // Said again in other words: the newer wording replaces the old fact instead of sitting next to it.
      const again = this.store.memories.profile(bot.spaceId).find((f) => f.category === category && factSimilarity(f.text, fact) >= SAME_FACT);
      const saved = again
        ? this.store.memories.updateProfileFact(again.id, { text: fact, source: "you" })!
        : this.store.memories.addProfileFact({ text: fact, category, spaceId, source: "you" });
      this.onChange([saved.text]);
      return text(`Saved to About you (${PROFILE_CATEGORY_LABELS[category]}${spaceId ? ", this space only" : ""}): ${saved.text}`);
    }
    if (name === "recall_about_user") {
      const q = String((input as { query?: string })?.query ?? "").trim();
      const qWords = factWords(q);
      const facts = this.store.memories.profile(bot.spaceId);
      const hits = facts
        .map((f) => ({ f, score: overlap(factWords(f.text), qWords) * 2 + (q.length >= 3 && f.text.toLowerCase().includes(q.toLowerCase()) ? 3 : 0) }))
        .filter((h) => h.score > 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, 15);
      if (!hits.length) return text(`Nothing about "${q}" in the user's profile (${facts.length} facts). Ask them if you need it.`);
      return text(hits.map(({ f }) => `- (${PROFILE_CATEGORY_LABELS[f.category]}) ${f.text}`).join("\n"));
    }
    if (name === "forget_about_user") {
      const match = String((input as { match?: string })?.match ?? "").trim().toLowerCase();
      if (match.length < 3) return fail("Give at least a few words from the fact to forget.");
      const hits = this.store.memories.profile(bot.spaceId).filter((f) => f.text.toLowerCase().includes(match));
      if (!hits.length) return text("Nothing in the profile matches that.");
      if (hits.length > 5) return fail(`That matches ${hits.length} facts; use more specific words. Matches: ${hits.slice(0, 8).map((f) => f.text).join(" | ")}`);
      for (const f of hits) this.store.memories.deleteProfileFact(f.id);
      this.onChange();
      return text(`Forgot: ${hits.map((f) => f.text).join(" | ")}`);
    }
    return fail(`Unknown tool ${name}`);
  }
}

/** Changes the learning pass may make to the profile. Facts the user wrote or said are left alone. */
export interface ProfileChanges {
  add?: { text?: unknown; section?: unknown; scope?: unknown }[];
  update?: { id?: unknown; text?: unknown; section?: unknown }[];
  remove?: unknown[];
}

/** Applies the learning pass's changes to the facts this Bot can see; returns the new facts' texts. */
export function applyProfileChanges(store: Store, bot: Bot, changes: ProfileChanges): string[] {
  const visible = new Map(store.memories.profile(bot.spaceId).map((f) => [f.id.slice(0, 8), f] as const));
  const learnedOnly = (id: unknown): ProfileFact | undefined => {
    const f = visible.get(String(id ?? "").replace(/[[\]]/g, "").slice(0, 8));
    return f && f.source === "learned" ? f : undefined;
  };
  const section = (v: unknown): ProfileCategory | undefined => ((PROFILE_CATEGORIES as readonly string[]).includes(String(v)) ? (v as ProfileCategory) : undefined);
  for (const id of Array.isArray(changes.remove) ? changes.remove : []) {
    const f = learnedOnly(id);
    if (f) store.memories.deleteProfileFact(f.id);
  }
  for (const u of Array.isArray(changes.update) ? changes.update : []) {
    const f = learnedOnly(u?.id);
    const t = typeof u?.text === "string" ? u.text.trim() : "";
    if (f && t && t.length <= 500) store.memories.updateProfileFact(f.id, { text: t, category: section(u.section) });
  }
  const learned: string[] = [];
  const existing = new Set(store.memories.profile().map((f) => f.text.toLowerCase()));
  for (const a of Array.isArray(changes.add) ? changes.add : []) {
    const t = typeof a?.text === "string" ? a.text.trim() : "";
    if (!t || t.length > 500 || existing.has(t.toLowerCase())) continue;
    // The same fact in other words: refresh the learned one rather than keep both.
    const again = store.memories.profile(bot.spaceId).find((f) => factSimilarity(f.text, t) >= SAME_FACT);
    if (again) {
      if (again.source === "learned" && t.length >= again.text.length) store.memories.updateProfileFact(again.id, { text: t });
      continue;
    }
    store.memories.addProfileFact({ text: t, category: section(a.section) ?? "about", spaceId: a.scope === "this-space" ? bot.spaceId : null, source: "learned" });
    existing.add(t.toLowerCase());
    learned.push(t);
  }
  return learned;
}

export class MemoryRewriter {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();

  constructor(
    private store: Store,
    private drivers: DriverRegistry,
    private resolveModel: (bot: Bot) => string,
    private onProfileChange: (learned?: string[]) => void = () => {},
  ) {}

  /** Debounced per Bot: fires 15 s after the last completed turn. */
  schedule(botId: string, conversationId: string): void {
    const prev = this.timers.get(botId);
    if (prev) clearTimeout(prev);
    this.timers.set(
      botId,
      setTimeout(() => {
        this.timers.delete(botId);
        void this.run(botId, conversationId).catch((err) => console.warn("[memory] rewrite failed:", (err as Error).message));
      }, 15_000),
    );
  }

  async run(botId: string, conversationId: string): Promise<void> {
    if (this.running.has(botId)) return;
    const bot = this.store.bots.get(botId);
    if (!bot) return;
    this.running.add(botId);
    try {
      const settings = this.store.settings.get();
      const ref = settings.utilityModelRef ?? this.resolveModel(bot);
      const { provider, model } = parseModelRef(ref);
      const driver = this.drivers.get(provider);

      const recent = this.store.messages
        .list(conversationId)
        .filter((m) => m.role !== "system" && m.content.trim())
        .slice(-16)
        .map((m) => `${m.role === "user" ? "User" : bot.name}: ${m.content.slice(0, 1200)}`)
        .join("\n\n");
      const botFacts = this.store.memories.list(botId).map((f) => f.text);
      const learnAboutMe = settings.learnAboutMe !== false;
      const userFacts = this.store.memories.profile(bot.spaceId);
      const space = bot.spaceId ? this.store.spaces.get(bot.spaceId) : undefined;

      const system = [
        `You maintain long-term memory for an AI teammate named ${bot.name}. Update it after the latest conversation.`,
        learnAboutMe
          ? 'Output JSON only: {"botFacts": string[], "aboutUser": {"add": [{"text": string, "section": string, "scope": "everywhere"|"this-space"}], "update": [{"id": string, "text": string, "section"?: string}], "remove": [id]}}.'
          : 'Output JSON only: {"botFacts": string[]}.',
        `botFacts: ${bot.name}'s role/job as the user defined it, stable preferences about how to do the work, and one-line summaries of completed work. Max ${MAX_BOT_FACTS} facts, max ${MAX_BOT_FACT_CHARS} characters total. Keep what is still true, merge duplicates, drop what the user asked to forget.`,
        ...(learnAboutMe
          ? [
              "aboutUser: the user's profile, shared by all their Bots. Learn who they are, what they like and dislike, their routines, the people and places in their life, and how they like things done. Only record what the conversation shows; never guess.",
              `Sections: about (who they are: name, job, family, goals), likes (food, brands, styles, budgets, dislikes), routines (habits and schedule, e.g. "Gym Tue and Thu 6am", "Checks deals every Friday": only when the user states it or it clearly repeats), people (names and roles of family, friends, colleagues; places they go), style (how they want answers and work done).`,
              `Scope: this conversation is in the ${space ? `"${space.name}"` : "current"} space. Use "this-space" for things that only matter here (work projects and colleagues in a work space; household and family errands in a personal space) and "everywhere" for who they are.`,
              "Only lasting facts about the person belong here. Work details (ticket numbers, servers, repos, file paths, settings, project status) are not about the user: keep them out of aboutUser (put what still matters in botFacts).",
              "Keep the profile tidy: when two facts say the same thing, merge them (update one, remove the other); remove learned facts about finished one-off jobs.",
              "add: new facts, one short third-person sentence each. update: correct or merge an existing fact by its [id]. remove: [id]s of facts that turned out wrong, are no longer true, or that the user asked to forget. Facts marked (user) were written by the user: never update or remove those.",
              "Return empty lists when nothing new was learned. Most conversations teach nothing new about the user.",
            ]
          : []),
        "Never store secrets, passwords or card numbers. Do not store changing data (prices, counts, dates of one-off events) as facts.",
      ].join("\n");
      const prompt = [
        "Current botFacts:",
        ...(botFacts.length ? botFacts.map((f) => `- ${f}`) : ["(none)"]),
        "",
        ...(learnAboutMe
          ? [
              "Current aboutUser facts:",
              ...(userFacts.length
                ? userFacts.map((f) => `- [${f.id.slice(0, 8)}] (${f.category}, ${f.spaceId ? "this space" : "everywhere"}${f.source === "you" ? ", user" : ""}) ${f.text}`)
                : ["(none)"]),
              "",
            ]
          : []),
        "Latest conversation:",
        recent || "(empty)",
      ].join("\n");

      let text = "";
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 90_000);
      try {
        for await (const ev of driver.run({ model, system, messages: [{ role: "user", content: prompt }], tools: [], signal: ac.signal })) {
          if (ev.type === "text-delta") text += ev.text;
          if (ev.type === "error") throw new Error(ev.message);
        }
      } finally {
        clearTimeout(timer);
      }
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      if (!json) return;
      const parsed = JSON.parse(json) as { botFacts?: unknown; aboutUser?: ProfileChanges };
      const clean = (v: unknown, max: number) =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()).slice(0, max) : null;
      const nextBot = clean(parsed.botFacts, MAX_BOT_FACTS);
      if (nextBot) {
        let total = 0;
        this.store.memories.replace(
          botId,
          nextBot.filter((f) => (total += f.length + 1) <= MAX_BOT_FACT_CHARS),
        );
      }
      if (learnAboutMe && parsed.aboutUser && typeof parsed.aboutUser === "object") {
        const before = this.store.memories.profile().map((f) => `${f.id}:${f.text}`).join("|");
        const learned = applyProfileChanges(this.store, bot, parsed.aboutUser);
        if (learned.length || this.store.memories.profile().map((f) => `${f.id}:${f.text}`).join("|") !== before) this.onProfileChange(learned);
      }
    } finally {
      this.running.delete(botId);
    }
  }
}
