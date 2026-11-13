import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AtSign, FileText, Image as ImageIcon, Mic, Paperclip, Reply, Slash, Square, X } from "lucide-react";
import type { Skill } from "@grokbot/shared";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES } from "@grokbot/shared";
import { formatBytes, isImageFile } from "../lib/files";

interface Mention {
  id: string;
  name: string;
  label?: string;
}

interface PickerItem {
  key: string;
  title: string;
  subtitle: string;
  insert: string;
}

export function Composer({
  botName,
  placeholder,
  streaming,
  skills = [],
  mentions = [],
  onSend,
  onStop,
  replyTo = null,
  onCancelReply,
}: {
  botName: string;
  placeholder?: string;
  streaming: boolean;
  skills?: Skill[];
  mentions?: Mention[];
  /** Resolves once the message (and any uploads) are accepted; rejects to keep the draft and show the error. */
  onSend: (text: string, files: File[]) => Promise<void> | void;
  onStop: () => void;
  /** Shown above the box while replying to a message; × or Escape cancels. */
  replyTo?: { author: string; text: string } | null;
  onCancelReply?: () => void;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [pickerClosed, setPickerClosed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Reset to a single row, then grow to fit content (capped). "auto" + rows=1 gives a true content measure.
    el.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const padding = el.offsetHeight - el.clientHeight;
    const wanted = Math.min(Math.max(el.scrollHeight, lineHeight + padding), 220);
    el.style.height = `${wanted}px`;
  }, [text]);

  useEffect(() => ref.current?.focus(), [botName, replyTo]);

  // "/" or "@" typed at the very start of an otherwise empty composer opens the picker; it closes on space, Escape or insert.
  const picker = useMemo(() => {
    const trigger = text[0];
    if ((trigger !== "/" && trigger !== "@") || pickerClosed || /\s/.test(text)) return null;
    const q = text.slice(1).toLowerCase();
    const items: PickerItem[] =
      trigger === "/"
        ? skills
            .filter((k) => k.name.toLowerCase().includes(q) || k.description.toLowerCase().includes(q))
            .map((k) => ({ key: k.id, title: `/${k.name}`, subtitle: k.description, insert: `Use the skill ${k.name}: ` }))
        : mentions
            .filter((m) => m.name.toLowerCase().includes(q))
            .map((m) => ({ key: m.id, title: `@${m.name}`, subtitle: m.label ?? "Bot", insert: `@${m.name} ` }));
    return { kind: trigger, items };
  }, [text, skills, mentions, pickerClosed]);

  useEffect(() => setCursor(0), [picker?.items.length, picker?.kind]);
  useEffect(() => {
    if (!text) setPickerClosed(false);
  }, [text]);

  const choose = (item: PickerItem) => {
    setText(item.insert);
    setPickerClosed(true);
    requestAnimationFrame(() => ref.current?.focus());
  };

  const addFiles = (incoming: Iterable<File>) => {
    const next = [...files];
    for (const f of incoming) {
      if (next.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) continue;
      if (next.length >= MAX_ATTACHMENTS_PER_MESSAGE) return setError(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`);
      const image = isImageFile(f.name, f.type);
      const max = image ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
      if (f.size > max) return setError(`${f.name} is larger than ${formatBytes(max)} (${image ? "images" : "files"}).`);
      next.push(f);
    }
    setError(null);
    setFiles(next);
  };

  const submit = async () => {
    const t = text.trim();
    if ((!t && files.length === 0) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(t, files);
      setText("");
      setFiles([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      // Only if nothing else took focus meanwhile (the user clicked elsewhere on purpose).
      requestAnimationFrame(() => {
        if (document.activeElement === document.body || document.activeElement === ref.current) ref.current?.focus();
      });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (picker && picker.items.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => (c + 1) % picker.items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => (c - 1 + picker.items.length) % picker.items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = picker.items[Math.min(cursor, picker.items.length - 1)];
        if (item) choose(item);
        return;
      }
    }
    if (picker && e.key === "Escape") {
      e.preventDefault();
      setPickerClosed(true);
      return;
    }
    if (replyTo && e.key === "Escape") {
      e.preventDefault();
      onCancelReply?.();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.items].filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter((f): f is File => Boolean(f));
    if (!pasted.length) return;
    e.preventDefault();
    addFiles(pasted);
  };

  const canSend = !busy && (text.trim().length > 0 || files.length > 0);

  return (
    <div className="no-drag shrink-0 px-3 pb-3 pt-1 md:px-5 md:pb-4">
      <div
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={`relative mx-auto w-full max-w-[780px] rounded-[14px] border bg-sunken p-2 shadow-tide focus-within:border-accent/60 ${dragging ? "border-accent bg-accent/5" : "border-line"}`}
      >
        {picker && (
          <div className="absolute bottom-full left-2 right-2 z-20 mb-1.5 max-h-60 overflow-y-auto rounded-xl border border-line bg-elev p-1 shadow-xl">
            <div className="flex items-center gap-1 px-2 py-1 label-mono">
              {picker.kind === "/" ? <Slash size={10} /> : <AtSign size={10} />}
              {picker.kind === "/" ? "Skills" : "Bots"}
            </div>
            {picker.items.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted">{picker.kind === "/" ? "No matching skills. Add some in Settings → Skills." : "No other Bots."}</div>
            ) : (
              picker.items.map((item, i) => (
                <button
                  key={item.key}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => choose(item)}
                  className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left ${i === cursor ? "bg-sunken" : "hover:bg-sunken/60"}`}
                >
                  <span className="shrink-0 font-mono text-[14px] font-medium">{item.title}</span>
                  <span className="truncate text-xs text-muted">— {item.subtitle}</span>
                </button>
              ))
            )}
          </div>
        )}
        {replyTo && (
          <div className="mx-1 mb-1.5 mt-0.5 flex items-start gap-2 rounded-[10px] border-l-2 border-accent bg-elev px-2.5 py-1.5">
            <Reply size={13} className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium">Replying to {replyTo.author}</div>
              <div className="line-clamp-2 break-words text-[13px] text-muted">{replyTo.text}</div>
            </div>
            <button onClick={onCancelReply} className="rounded-full p-0.5 text-muted hover:bg-sunken hover:text-fg" title="Cancel reply (Esc)" aria-label="Cancel reply">
              <X size={13} />
            </button>
          </div>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1 pb-1.5 pt-1">
            {files.map((f) => (
              <span key={`${f.name}:${f.size}:${f.lastModified}`} className="flex max-w-[260px] items-center gap-1.5 rounded-full border border-line bg-sunken py-0.5 pl-2 pr-1 text-xs">
                {isImageFile(f.name, f.type) ? <ImageIcon size={12} className="shrink-0 text-muted" /> : <FileText size={12} className="shrink-0 text-muted" />}
                <span className="truncate" title={f.name}>
                  {f.name}
                </span>
                <span className="shrink-0 text-muted">{formatBytes(f.size)}</span>
                <button onClick={() => setFiles((l) => l.filter((x) => x !== f))} className="rounded-full p-0.5 text-muted hover:bg-elev hover:text-fg" title="Remove">
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={dragging ? "Drop files to attach" : (placeholder ?? `Message ${botName}…  (@ to mention, / for skills)`)}
          rows={1}
          // readOnly, not disabled, while sending: a disabled box drops the cursor, and putting it back
          // afterwards is unreliable while replies are streaming in.
          readOnly={busy}
          aria-busy={busy}
          className={`block w-full min-w-0 resize-none bg-transparent px-2 py-1.5 text-[16px] outline-none placeholder:text-muted md:text-[15px] ${busy ? "opacity-60" : ""}`}
        />
        {error && <div className="px-2 pb-1 text-xs text-danger">{error}</div>}
        <div className="flex items-center justify-between px-1 pt-1">
          <div className="flex items-center gap-1 text-muted">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <IconButton title="Attach files" onClick={() => fileInput.current?.click()}>
              <Paperclip size={15} />
            </IconButton>
            <IconButton title="Start voice input ⌘D (phase 9)">
              <Mic size={15} />
            </IconButton>
          </div>
          {/* While Bots are replying you can still send: Stop sits next to Send, and replaces it only when there's nothing to send. */}
          <div className="flex items-center gap-1.5">
            {streaming && (
              <button
                onClick={onStop}
                className={`flex h-8 w-8 items-center justify-center rounded-full ${canSend ? "border border-line text-muted hover:text-fg" : "bg-fg text-bg"}`}
                title="Stop now"
              >
                <Square size={12} fill="currentColor" />
              </button>
            )}
            {(!streaming || canSend) && (
              <button
                onClick={() => void submit()}
                disabled={!canSend}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity disabled:opacity-30"
                title={busy ? "Uploading…" : "Send"}
              >
                <ArrowUp size={15} className={busy ? "animate-pulse" : ""} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function IconButton({ title, children, onClick }: { title: string; children: React.ReactNode; onClick?: () => void }) {
  return (
    <button title={title} onClick={onClick} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-sunken hover:text-fg">
      {children}
    </button>
  );
}
