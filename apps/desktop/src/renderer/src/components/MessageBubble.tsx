import { memo, useState } from "react";
import { ArrowRightLeft, ChevronRight, ClipboardList, Download, ExternalLink, FileText, GraduationCap, Hand, Loader2, Pin, Repeat, Reply, UserMinus, UserPlus, Wrench } from "lucide-react";
import type { Attachment, Bot, Message, MessagePart, ReplyQuote } from "@grokbot/shared";
import { messageText, parseReply, plainPreview } from "@grokbot/shared";
import { fileUrl, workspaceUrl } from "../lib/api";
import { formatBytes, isImageFile } from "../lib/files";
import { useStore } from "../lib/store";
import { BotAvatar } from "./BotAvatar";
import { ApprovalCard } from "./ApprovalCard";
import { SecureFormCard } from "./SecureFormCard";
import { Collapsible, pretty } from "./Collapsible";
import { Markdown } from "./Markdown";

/**
 * One transcript entry. `bot` is the fallback sender for 1:1 chats; in groups the sender is looked up by message.botId.
 * Memoized: a streaming reply updates one message object, so only that bubble re-renders.
 */
export const MessageBubble = memo(function MessageBubble({ message, bot }: { message: Message; bot?: Bot }) {
  const sender = useStore((s) => (message.botId ? s.bots.find((b) => b.id === message.botId) : undefined)) ?? bot;
  if (message.role === "user") {
    const { reply, body } = parseReply(message.content);
    return (
      <div className="group flex flex-col items-end gap-1.5">
        {message.content && (
          <div className="flex max-w-full items-start justify-end gap-1.5">
            <div className="mt-2 flex">
              <ReplyButton message={message} author="You" />
              <PinButton message={message} />
            </div>
            <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[16px] rounded-br-[4px] bg-bubble px-3.5 py-2.5 font-medium text-bubble-fg md:max-w-[72%]">
              {reply && <QuoteCard reply={reply} />}
              {body}
            </div>
          </div>
        )}
        <Attachments items={message.attachments} align="end" />
      </div>
    );
  }
  if (message.role === "system") {
    const text = message.content.trim().replace(/\s+/g, " ");
    // Handoffs between Bots arrive as "Message from <Bot>: …" and answers as "Reply from <Bot>: …";
    // routine triggers are everything else.
    const handoff = /^(message|reply) from\s+/i.exec(text);
    const isReply = !!handoff && handoff[1]!.toLowerCase() === "reply";
    const taught = /^teach a task:\s*/i.exec(text);
    const setup = /^setup:\s*/i.exec(text);
    const task = /^(new task from the user|the user assigned you task)\s*/i.exec(text);
    const wrapUp = /^wrap up:\s*/i.exec(text);
    const member = /^(added|removed):\s*/i.exec(text);
    const left = !!member && member[1]!.toLowerCase() === "removed";
    const match = handoff ?? taught ?? setup ?? task ?? wrapUp ?? member;
    const body = match ? text.slice(match[0].length) : text;
    // Tidewater event card: a mono kind label, the gist, and the full text on hover.
    const kind = handoff ? (isReply ? "Reply" : "Handoff") : taught ? "Teach" : setup ? "Joined" : task ? "Task" : wrapUp ? "Wrap-up" : member ? (left ? "Left" : "Joined") : "Routine";
    const Icon = handoff ? ArrowRightLeft : taught ? GraduationCap : setup ? UserPlus : task ? ClipboardList : wrapUp ? Hand : left ? UserMinus : member ? UserPlus : Repeat;
    const gist = setup
      ? body.replace(/^you were just\s*/i, "").replace(/\.\s.*$/, "")
      : wrapUp
        ? body.replace(/\s*\([^()]*\)$/, "")
        : body.replace(/\s*\(Answer (in your reply: it is sent back to .*|here in the group\.)\)$/, "");
    const clipped = gist.length > 140 ? `${gist.slice(0, 140)}…` : gist;
    const from = (handoff || wrapUp || member) && sender ? sender : null;
    return (
      <div className="flex justify-center">
        <div
          className="flex w-full max-w-[92%] items-center gap-3 rounded-[12px] border border-line bg-gradient-to-b from-elev to-sunken px-3.5 py-2.5 md:max-w-[80%]"
          title={message.content}
        >
          {from ? (
            <BotAvatar name={from.name} color={from.avatarColor} shape={from.avatarShape} image={from.avatarImage} size={22} />
          ) : (
            <Icon size={15} className="shrink-0 text-accent" />
          )}
          <span className="label-mono shrink-0 !text-accent">{kind}</span>
          <span className="min-w-0 flex-1 truncate text-[14px] text-muted">{clipped}</span>
        </div>
      </div>
    );
  }
  const isEmpty = message.parts.length === 0;
  const name = sender?.name ?? "Bot";
  return (
    <div className="group flex gap-3">
      {sender ? (
        <BotAvatar name={sender.name} color={sender.avatarColor} shape={sender.avatarShape} image={sender.avatarImage} size={28} className="mt-0.5" />
      ) : (
        <BotAvatar name="?" color="#6b6b76" shape="circle" size={28} className="mt-0.5" />
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline gap-1.5 text-[13.5px] text-muted">
          <span className="font-semibold text-fg">{name}</span>
          <span>·</span>
          <span className="font-mono text-[12.5px]">{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
          {message.modelRef && <span className="hidden font-mono text-[12px] opacity-70 sm:inline">· {message.modelRef}</span>}
          {message.status !== "streaming" && !isEmpty && (
            <span className="flex self-center">
              <ReplyButton message={message} author={name} />
              <PinButton message={message} />
            </span>
          )}
        </div>
        <div className="space-y-2">
          {isEmpty && message.status === "streaming" && (
            <div className="flex gap-1 py-1 text-muted">
              <span className="dot">●</span>
              <span className="dot">●</span>
              <span className="dot">●</span>
            </div>
          )}
          {segments(message.parts).map((seg, i, all) =>
            seg.kind === "activity" ? (
              <Activity key={i} parts={seg.parts} active={message.status === "streaming" && i === all.length - 1} />
            ) : (
              <Part key={i} part={seg.part} />
            ),
          )}
          <Attachments items={message.attachments} />
          {message.status === "error" && (
            <div className="rounded-app border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{message.error ?? "Failed"}</div>
          )}
          {message.status === "stopped" && <div className="text-xs text-muted">Stopped.</div>}
        </div>
      </div>
    </div>
  );
});

/** Reply to this message: the composer shows it, and the sent message carries a short quote of it. */
function ReplyButton({ message, author }: { message: Message; author: string }) {
  const setReplyTo = useStore((s) => s.setReplyTo);
  const replying = useStore((s) => s.replyTo?.messageId === message.id);
  return (
    <button
      onClick={() => setReplyTo(replying ? null : { messageId: message.id, author, text: plainPreview(messageText(message, 600)) })}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-elev ${replying ? "text-accent" : "text-muted opacity-0 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"}`}
      title={replying ? "Cancel reply" : "Reply to this message"}
      aria-label="Reply"
    >
      <Reply size={13} />
    </button>
  );
}

/** The quoted message at the top of a reply. Click to jump to it. */
function QuoteCard({ reply }: { reply: ReplyQuote }) {
  // The chat view finds it, loading older messages if needed.
  const jump = () => useStore.setState({ focusMessageId: reply.messageId });
  return (
    <button onClick={jump} className="mb-1.5 block w-full rounded-[8px] border-l-2 border-accent bg-black/10 px-2.5 py-1 text-left text-[13px] font-normal opacity-80 hover:opacity-100" title="Go to the original message">
      <span className="font-semibold">{reply.author}</span>
      <span className="line-clamp-2">{reply.quote}</span>
    </button>
  );
}

/** Pin a message to Team pulse to come back to later. Shows on hover; stays visible once pinned. */
function PinButton({ message, className = "" }: { message: Message; className?: string }) {
  const pinned = useStore((s) => s.pins.some((p) => p.messageId === message.id));
  const togglePin = useStore((s) => s.togglePin);
  return (
    <button
      onClick={() => void togglePin(message)}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-elev ${pinned ? "text-accent" : "text-muted opacity-0 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"} ${className}`}
      title={pinned ? "Unpin" : "Pin to Team pulse to come back to later"}
      aria-label={pinned ? "Unpin message" : "Pin message"}
    >
      <Pin size={13} className={pinned ? "fill-current" : ""} />
    </button>
  );
}

type Segment = { kind: "activity"; parts: MessagePart[] } | { kind: "part"; part: MessagePart };
const BEHIND_THE_SCENES = new Set<MessagePart["type"]>(["tool-call", "tool-result", "reasoning", "status"]);

/** Consecutive tool calls, results, thinking and status lines fold into one "activity" row. */
function segments(parts: MessagePart[]): Segment[] {
  const out: Segment[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (BEHIND_THE_SCENES.has(part.type)) {
      if (last?.kind === "activity") last.parts.push(part);
      else out.push({ kind: "activity", parts: [part] });
    } else out.push({ kind: "part", part });
  }
  return out;
}

/**
 * One quiet row for the Bot's behind-the-scenes steps: "Thinking…" / "Working…" while it runs,
 * a short summary when done. Click to see every step.
 */
function Activity({ parts, active }: { parts: MessagePart[]; active: boolean }) {
  const [open, setOpen] = useState(false);
  const calls = parts.filter((p): p is Extract<MessagePart, { type: "tool-call" }> => p.type === "tool-call");
  const onlyThinking = calls.length === 0;
  const failed = calls.filter((c) => c.status === "error").length;
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  const tools = [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(", ");
  const label = active
    ? parts.at(-1)?.type === "reasoning" || onlyThinking
      ? "Thinking…"
      : "Working…"
    : onlyThinking
      ? "Thought"
      : `Worked · ${calls.length} step${calls.length === 1 ? "" : "s"}`;
  return (
    <div>
      <button onClick={() => setOpen((v) => !v)} className="flex max-w-full items-center gap-1.5 py-0.5 text-[13px] text-muted hover:text-fg" title={open ? "Hide steps" : "Show steps"}>
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        {active && <Loader2 size={12} className="shrink-0 animate-spin" />}
        <span className="shrink-0 whitespace-nowrap">{label}</span>
        {!active && tools && <span className="min-w-0 truncate font-mono text-[12px] opacity-70">{tools}</span>}
        {failed > 0 && <span className="shrink-0 text-[12px] text-danger">· {failed} failed</span>}
      </button>
      {open && (
        <div className="mt-1 space-y-1.5 border-l border-line pl-3">
          {parts.map((p, i) => (
            <Part key={i} part={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function Part({ part }: { part: MessagePart }) {
  switch (part.type) {
    case "text":
      return <Markdown text={part.text} />;
    case "reasoning":
      return <Collapsible label="Thinking" muted>{part.text}</Collapsible>;
    case "tool-call":
      return (
        <Collapsible
          label={
            <span className="flex items-center gap-1.5">
              <Wrench size={12} />
              {part.name}
              <span
                className={`text-[11.5px] ${
                  part.status === "error" ? "text-danger" : part.status === "awaiting-approval" ? "text-signal" : "text-muted"
                }`}
              >
                {part.status === "awaiting-approval" ? "Waiting for approval" : part.status}
              </span>
            </span>
          }
        >
          {pretty(part.input)}
        </Collapsible>
      );
    case "tool-result":
      return (
        <Collapsible label={`${part.name} result`} muted>
          {pretty(part.output)}
        </Collapsible>
      );
    case "file":
      return <FileCard part={part} />;
    case "approval":
      return <ApprovalCard approvalId={part.approvalId} />;
    case "secure-form":
      return <SecureFormCard requestId={part.requestId} />;
    case "status":
      return <div className="text-xs text-muted">{part.text}</div>;
  }
}

/** Attachment cards under a message: images inline, everything else as a chip with a download link. */
function Attachments({ items, align = "start" }: { items: Attachment[] | undefined; align?: "start" | "end" }) {
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  if (!items?.length) return null;
  return (
    <div className={`flex max-w-[85%] flex-wrap gap-1.5 md:max-w-[80%] ${align === "end" ? "justify-end" : ""}`}>
      {items.map((a) =>
        isImageFile(a.name, a.mimeType) && !failed[a.id] ? (
          <button key={a.id} onClick={() => window.open(fileUrl(a.id), "_blank")} title={`${a.name} · ${formatBytes(a.size)}`} className="block overflow-hidden rounded-lg border border-line bg-sunken">
            <img
              src={fileUrl(a.id)}
              alt={a.name}
              className="block max-h-[240px] max-w-full object-contain"
              loading="lazy"
              // Never show a broken-image icon: fall back to the file chip (open/download still work).
              onError={() => setFailed((f) => ({ ...f, [a.id]: true }))}
            />
          </button>
        ) : (
          <div key={a.id} className="flex items-center gap-2 rounded-app border border-line bg-elev px-2.5 py-1.5 text-xs">
            <FileText size={13} className="shrink-0 text-muted" />
            <span className="max-w-[220px] truncate font-medium" title={a.name}>
              {a.name}
            </span>
            <span className="text-muted">{formatBytes(a.size)}</span>
            <a href={fileUrl(a.id, true)} download={a.name} className="flex items-center gap-0.5 text-muted hover:text-fg" title="Download">
              <Download size={12} />
            </a>
          </div>
        ),
      )}
    </div>
  );
}

/** Result card for a file the Bot produced in its workspace. */
function FileCard({ part }: { part: Extract<MessagePart, { type: "file" }> }) {
  const image = isImageFile(part.name, part.mimeType);
  return (
    <div className="max-w-[420px] overflow-hidden rounded-app border border-line bg-elev">
      {image && (
        <button onClick={() => window.open(workspaceUrl(part.path), "_blank")} className="block w-full border-b border-line bg-sunken">
          <img src={workspaceUrl(part.path)} alt={part.name} className="block max-h-[240px] w-full object-contain" loading="lazy" />
        </button>
      )}
      <div className="flex items-center gap-2.5 px-3 py-2">
        <FileText size={16} className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium">{part.name}</div>
          <div className="truncate font-mono text-[12.5px] text-muted" title={part.path}>
            {part.path}
            {part.size !== undefined ? ` · ${formatBytes(part.size)}` : ""}
          </div>
        </div>
        <button onClick={() => window.open(workspaceUrl(part.path), "_blank")} className="flex items-center gap-1 rounded-app border border-line px-2 py-1 text-[13px] hover:bg-sunken" title="Open in a new tab">
          <ExternalLink size={11} /> Open
        </button>
        <a href={workspaceUrl(part.path, true)} download={part.name} className="flex items-center gap-1 rounded-app border border-line px-2 py-1 text-[13px] hover:bg-sunken" title="Download">
          <Download size={11} /> Download
        </a>
      </div>
    </div>
  );
}
