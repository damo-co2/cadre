import { useEffect, useMemo, useState } from "react";
import { Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import type { Approval, Bot, Message, MessagePart, SecureFormRequest } from "@grokbot/shared";
import { BotAvatar } from "./BotAvatar";

/** No visible progress for this long: say so, quietly. */
const QUIET_MS = 2 * 60_000;
/** No visible progress for this long: it may be stuck. */
const STUCK_MS = 10 * 60_000;

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** What a tool call looks like in a short status line. */
export function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (v: unknown, n = 48) => {
    const t = String(v ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  if (name === "shell_run" || name === "shell_run_with_secrets") return `Running ${s(i.command) || "a command"}`;
  if (name === "browser_navigate") {
    try {
      return `Opening ${new URL(String(i.url)).host}`;
    } catch {
      return "Opening a page";
    }
  }
  if (name.startsWith("browser_")) return "Using the browser";
  if (name === "fs_write") return `Writing ${s(String(i.path ?? "").split("/").pop())}`;
  if (name.startsWith("fs_")) return "Reading files";
  if (name === "bot_message") return `Asking ${s(i.to ?? i.bot, 24) || "a teammate"}`;
  if (name.includes("__")) {
    const [app, tool] = name.split("__");
    return `${app![0]!.toUpperCase()}${app!.slice(1)}: ${tool}`;
  }
  return name.replace(/_/g, " ");
}

export interface WorkingRow {
  messageId: string;
  bot: Bot;
  /** What it is doing right now. */
  doing: string;
  kind: "working" | "waiting" | "quiet" | "stuck";
  startedMs: number;
  /** Time since anything new appeared in its reply. */
  idleMs: number;
}

/** One row per reply still being written in this chat: who, what they're doing, and whether it has gone quiet. */
export function workingRows(messages: Message[], bots: Bot[], approvals: Record<string, Approval>, forms: Record<string, SecureFormRequest>, now: number): WorkingRow[] {
  const rows: WorkingRow[] = [];
  for (const m of messages) {
    if (m.status !== "streaming" || m.role === "user" || !m.botId) continue;
    const bot = bots.find((b) => b.id === m.botId);
    if (!bot) continue;
    const waiting = m.parts.some(
      (p) => (p.type === "approval" && approvals[p.approvalId]?.status === "pending") || (p.type === "secure-form" && forms[p.requestId]?.status === "pending"),
    );
    const last = [...m.parts].reverse().find((p) => p.type !== "status") as MessagePart | undefined;
    const runningCall = [...m.parts].reverse().find((p) => p.type === "tool-call" && (p.status === "running" || p.status === "awaiting-approval"));
    const doing = waiting
      ? "Waiting for you"
      : runningCall && runningCall.type === "tool-call"
        ? describeTool(runningCall.name, runningCall.input)
        : last?.type === "text"
          ? "Writing its reply"
          : last?.type === "reasoning"
            ? "Thinking"
            : last?.type === "tool-call" || last?.type === "tool-result"
              ? "Deciding the next step"
              : "Starting";
    const startedMs = now - Date.parse(m.createdAt);
    const idleMs = Math.max(0, now - Date.parse(m.updatedAt));
    const kind = waiting ? "waiting" : idleMs >= STUCK_MS ? "stuck" : idleMs >= QUIET_MS ? "quiet" : "working";
    rows.push({ messageId: m.id, bot, doing, kind, startedMs, idleMs });
  }
  return rows.sort((a, b) => b.startedMs - a.startedMs);
}

/**
 * Above the chat box while Bots are replying: one line each, with what they're doing now and
 * how long since anything changed. Click a line to jump to that reply.
 */
export function WorkingStrip({
  messages,
  bots,
  approvals,
  forms,
  onJump,
}: {
  messages: Message[];
  bots: Bot[];
  approvals: Record<string, Approval>;
  forms: Record<string, SecureFormRequest>;
  onJump: (messageId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const anyStreaming = messages.some((m) => m.status === "streaming");
  useEffect(() => {
    if (!anyStreaming) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [anyStreaming]);
  const rows = useMemo(() => workingRows(messages, bots, approvals, forms, now), [messages, bots, approvals, forms, now]);
  if (!rows.length) return null;

  return (
    <div className="mx-auto w-full max-w-[760px] px-5" aria-live="polite">
      <div className="mb-2 flex flex-col gap-0.5 rounded-app border border-line bg-elev/60 px-2 py-1">
        {rows.map((r) => (
          <button
            key={r.messageId}
            onClick={() => onJump(r.messageId)}
            className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left text-[12.5px] hover:bg-sunken"
            title={`${r.doing}. ${r.kind === "stuck" ? `No progress for ${ago(r.idleMs)}: it may be stuck. ` : r.kind === "quiet" ? `Nothing new for ${ago(r.idleMs)}. ` : ""}Started ${ago(r.startedMs)} ago. Click to jump to this reply.`}
            data-working-row={r.kind}
          >
            <BotAvatar name={r.bot.name} color={r.bot.avatarColor} shape={r.bot.avatarShape} image={r.bot.avatarImage} size={16} />
            <span className="shrink-0 font-medium">{r.bot.name}</span>
            {r.kind === "waiting" ? (
              <ShieldAlert size={12} className="shrink-0 text-signal" />
            ) : r.kind === "stuck" ? (
              <TriangleAlert size={12} className="shrink-0 text-danger" />
            ) : (
              <Loader2 size={12} className={`shrink-0 text-muted ${r.kind === "working" ? "animate-spin" : ""}`} />
            )}
            <span className={`min-w-0 flex-1 truncate ${r.kind === "waiting" ? "text-signal" : "text-muted"}`}>{r.doing}</span>
            <span className={`shrink-0 font-mono text-[11.5px] ${r.kind === "stuck" ? "text-danger" : "text-muted"}`}>
              {r.kind === "stuck"
                ? `stuck? ${ago(r.idleMs)} no progress`
                : r.kind === "quiet"
                  ? `quiet ${ago(r.idleMs)}`
                  : r.kind === "waiting"
                    ? "your turn"
                    : `${ago(r.idleMs)} ago`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
