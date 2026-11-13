import type { Bot, Message } from "@grokbot/shared";
import { parseModelRef } from "@grokbot/shared";
import type { Store } from "@grokbot/db";
import type { DriverRegistry } from "@grokbot/model-drivers";

/**
 * Keeps the history a model is sent from growing without bound (Grok Bot's approach: summarise near the
 * limit). Only used when a turn has no model session to lean on: API-key Bots every turn, and CLI Bots
 * starting fresh. Claude Code / Codex sessions keep and compact their own history.
 *
 * One summary per chat stands in for everything up to `throughId`. When the messages after it pass
 * HISTORY_BUDGET_CHARS, the older ones are folded into the summary and the newest KEEP_RECENT_CHARS
 * stay word for word.
 */
export const HISTORY_BUDGET_CHARS = 240_000; // ≈ 60k tokens
export const KEEP_RECENT_CHARS = 100_000; // ≈ 25k tokens
/** "Compact" keeps this many of the newest messages word for word and summarises the rest. */
export const COMPACT_KEEP_MESSAGES = 6;
const MAX_SUMMARY_CHARS = 12_000;
const MAX_SUMMARISE_INPUT_CHARS = 500_000;
const MAX_MESSAGE_CHARS = 6_000;

export interface FittedHistory {
  /** The chat's summary of everything before `messages`, if there is one. */
  summary: string | null;
  messages: Message[];
}

const counts = (m: Message) => m.status !== "error" && (m.content.trim().length > 0 || m.attachments.length > 0);
const size = (list: Message[]) => list.reduce((n, m) => n + (counts(m) ? m.content.length : 0), 0);

export class HistoryCompactor {
  private inflight = new Map<string, Promise<boolean>>();

  constructor(
    private store: Store,
    private drivers: DriverRegistry,
    private resolveModel: (bot: Bot) => string,
  ) {}

  /** The messages after the chat's summary point. */
  after(conversationId: string, history: Message[]): FittedHistory {
    const s = this.store.summaries.get(conversationId);
    if (!s) return { summary: null, messages: history };
    const idx = history.findIndex((m) => m.id === s.throughId);
    const messages = idx >= 0 ? history.slice(idx + 1) : history.filter((m) => m.createdAt > s.throughAt);
    return { summary: s.text, messages };
  }

  /** What a turn without a model session should send: summarises first when the history runs over budget. */
  async fit(conversationId: string, bot: Bot, history: Message[], signal?: AbortSignal): Promise<FittedHistory> {
    let fitted = this.after(conversationId, history);
    if (size(fitted.messages) <= HISTORY_BUDGET_CHARS) return fitted;
    const { older, recent } = split(fitted.messages, KEEP_RECENT_CHARS);
    const ok = await this.summarise(conversationId, bot, fitted.summary, older, signal);
    fitted = this.after(conversationId, history);
    if (ok && size(fitted.messages) <= HISTORY_BUDGET_CHARS) return fitted;
    // The summariser failed: send only the newest messages rather than a history that won't fit.
    return { summary: fitted.summary, messages: recent };
  }

  /** "Compact": summarise all but the newest few messages now. Returns how many were folded in. */
  async compact(conversationId: string, bot: Bot): Promise<number> {
    const { summary, messages } = this.after(conversationId, this.store.messages.list(conversationId));
    const older = messages.slice(0, Math.max(0, messages.length - COMPACT_KEEP_MESSAGES));
    if (!older.some(counts)) return 0;
    const ok = await this.summarise(conversationId, bot, summary, older);
    if (!ok) throw new Error("The summary could not be written. Check the utility model in Settings → Models.");
    return older.length;
  }

  /** Fold `older` into the chat's summary. One summary at a time per chat; resolves false on failure. */
  private summarise(conversationId: string, bot: Bot, previous: string | null, older: Message[], signal?: AbortSignal): Promise<boolean> {
    const running = this.inflight.get(conversationId);
    if (running) return running;
    const job = this.write(conversationId, bot, previous, older, signal)
      .then(() => true)
      .catch((err) => {
        console.warn("[context] summary failed:", (err as Error).message);
        return false;
      })
      .finally(() => this.inflight.delete(conversationId));
    this.inflight.set(conversationId, job);
    return job;
  }

  private async write(conversationId: string, bot: Bot, previous: string | null, older: Message[], signal?: AbortSignal): Promise<void> {
    const through = older.at(-1);
    if (!through) return;
    const nameOf = (m: Message) => (m.role === "user" ? "User" : m.role === "system" ? "Cadre" : (this.store.bots.get(m.botId ?? "")?.name ?? "Bot"));
    let transcript = older
      .filter(counts)
      .map((m) => `${nameOf(m)}: ${m.content.length > MAX_MESSAGE_CHARS ? `${m.content.slice(0, MAX_MESSAGE_CHARS)} […]` : m.content}`)
      .join("\n\n");
    if (transcript.length > MAX_SUMMARISE_INPUT_CHARS) transcript = `[…]\n${transcript.slice(-MAX_SUMMARISE_INPUT_CHARS)}`;

    const settings = this.store.settings.get();
    const { provider, model } = parseModelRef(settings.utilityModelRef ?? this.resolveModel(bot));
    const driver = this.drivers.get(provider);
    const system = [
      "You condense the earlier part of a chat between a user and their AI teammates so the teammates can keep working without the full transcript.",
      "Write a summary that replaces those messages. Keep: what the user asked for and decided, facts and results found, exact identifiers (hostnames, IDs, ticket keys, commands, URLs, file paths, numbers), who is doing what, promises made, and anything still open or waiting on someone.",
      "Drop small talk, repetition and dead ends (but note a dead end briefly if it stops someone retrying it). Use short headed sections and bullet points. Plain text, no preamble.",
      `Stay under ${Math.round(MAX_SUMMARY_CHARS / 6)} words.`,
    ].join("\n");
    const prompt = [
      previous ? `Summary so far (fold it in; keep what is still true):\n${previous}\n` : "",
      "Messages to fold in:",
      transcript,
    ].join("\n");

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 180_000);
    const onAbort = () => ac.abort();
    signal?.addEventListener("abort", onAbort);
    let text = "";
    try {
      for await (const ev of driver.run({ model, system, messages: [{ role: "user", content: prompt }], tools: [], signal: ac.signal })) {
        if (ev.type === "text-delta") text += ev.text;
        if (ev.type === "error") throw new Error(ev.message);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    text = text.trim();
    if (!text) throw new Error("empty summary");
    if (text.length > MAX_SUMMARY_CHARS) text = `${text.slice(0, MAX_SUMMARY_CHARS)} […]`;
    this.store.summaries.set(conversationId, { throughId: through.id, throughAt: through.createdAt, text });
  }
}

/** Newest messages up to `keepChars` stay; the rest are to be summarised. Always keeps at least one. */
export function split(messages: Message[], keepChars: number): { older: Message[]; recent: Message[] } {
  let kept = 0;
  let cut = messages.length;
  while (cut > 0) {
    const m = messages[cut - 1]!;
    const n = counts(m) ? m.content.length : 0;
    if (cut < messages.length && kept + n > keepChars) break;
    kept += n;
    cut--;
  }
  return { older: messages.slice(0, cut), recent: messages.slice(cut) };
}
