import { useEffect, useRef, useState } from "react";
import { Globe, Hand, Loader2, Monitor, RotateCcw, GraduationCap, Square, X } from "lucide-react";
import type { Bot, ScreenInput, ScreenState, ScreenStatus } from "@grokbot/shared";
import { SCREEN_SIZE, TEACH_MAX_MS } from "@grokbot/shared";
import { api } from "../lib/api";
import { frameBus } from "../lib/frames";
import { useStore } from "../lib/store";

const STATUS_LABEL: Record<ScreenStatus, string> = {
  off: "Off",
  starting: "Starting",
  ready: "Ready",
  reconnecting: "Reconnecting",
  error: "Error",
};
const STATUS_CLASS: Record<ScreenStatus, string> = {
  off: "bg-sunken text-muted",
  starting: "bg-signal/15 text-signal",
  ready: "bg-accent/15 text-accent",
  reconnecting: "bg-signal/15 text-signal",
  error: "bg-danger/10 text-danger",
};

const MOVE_INTERVAL_MS = 33; // ~30 mouse moves per second
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "OS", "CapsLock", "NumLock", "ScrollLock", "Fn", "Dead", "Unidentified"]);

/** Right-hand computer view: live screencast of the Bot's screen, with "Take control" for logins, 2FA and CAPTCHAs. */
export function ComputerPanel({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const state = useStore((s) => s.screens[bot.id] as ScreenState | undefined);
  const wsSend = useStore((s) => s.wsSend);
  const connected = useStore((s) => s.connected);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlFocused, setUrlFocused] = useState(false);
  const [teachOpen, setTeachOpen] = useState(false);
  const [teachText, setTeachText] = useState("");
  const [teachBusy, setTeachBusy] = useState(false);
  const [teachSaved, setTeachSaved] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastMove = useRef(0);

  const status: ScreenStatus = state?.status ?? "off";
  const controlled = state?.controlledByUser ?? false;
  const recording = state?.recording ?? null;

  // Tick once a second while a recording runs so the elapsed clock moves.
  useEffect(() => {
    if (!recording) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [recording?.id]);

  useEffect(() => {
    if (!teachSaved) return;
    const t = setTimeout(() => setTeachSaved(false), 4000);
    return () => clearTimeout(t);
  }, [teachSaved]);

  const upsertState = (st: ScreenState) => useStore.setState((s) => ({ screens: { ...s.screens, [bot.id]: st } }));

  const startTeach = async () => {
    const description = teachText.trim();
    if (!description || teachBusy) return;
    setTeachBusy(true);
    try {
      upsertState(await api.computer.teachStart(bot.id, description));
      setTeachOpen(false);
      setTeachText("");
      canvasRef.current?.focus();
    } catch (err) {
      useStore.setState({ error: (err as Error).message });
    } finally {
      setTeachBusy(false);
    }
  };

  const stopTeach = async () => {
    if (teachBusy) return;
    setTeachBusy(true);
    try {
      await api.computer.teachStop(bot.id);
      setTeachSaved(true);
    } catch (err) {
      useStore.setState({ error: (err as Error).message });
    } finally {
      setTeachBusy(false);
    }
  };
  const sendInput = (input: ScreenInput) => wsSend({ type: "screen.input", botId: bot.id, input });

  // Watch this screen while the panel is open (re-sent after every reconnect).
  useEffect(() => {
    wsSend({ type: "screen.watch", botId: bot.id });
    api.computer
      .state(bot.id)
      .then((st) => useStore.setState((s) => ({ screens: { ...s.screens, [bot.id]: st } })))
      .catch(() => {});
    return () => wsSend({ type: "screen.unwatch", botId: bot.id });
  }, [bot.id, wsSend, connected]);

  // Draw frames from the bus. Decode one at a time; if frames arrive faster, keep only the newest.
  useEffect(() => {
    setHasFrame(false);
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let pending: string | null = null;
    let decoding = false;
    let disposed = false;
    const draw = (data: string) => {
      decoding = true;
      const img = new Image();
      img.onload = () => {
        if (disposed) return;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        setHasFrame(true);
        decoding = false;
        if (pending) {
          const next = pending;
          pending = null;
          draw(next);
        }
      };
      img.onerror = () => {
        decoding = false;
      };
      img.src = `data:image/jpeg;base64,${data}`;
    };
    const unsubscribe = frameBus.subscribe(bot.id, (f) => {
      if (decoding) pending = f.data;
      else draw(f.data);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bot.id]);

  // Keep the address bar in sync with the screen unless the user is typing in it.
  useEffect(() => {
    if (!urlFocused) setUrlInput(state?.url ?? "");
  }, [state?.url, urlFocused]);

  // Wheel must be a non-passive native listener so we can preventDefault while controlling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !controlled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = toScreen(canvas, e.clientX, e.clientY);
      sendInput({ kind: "wheel", x, y, deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY) });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [controlled, bot.id, wsSend]);

  const setControl = (enabled: boolean) => {
    wsSend({ type: "screen.control", botId: bot.id, enabled });
    if (enabled) canvasRef.current?.focus();
  };

  const navigate = () => {
    const raw = urlInput.trim();
    if (!raw) return;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    sendInput({ kind: "navigate", url });
  };

  const reset = async () => {
    if (!window.confirm(`Reset ${bot.name}'s computer? Open pages and the browser session are discarded.`)) return;
    try {
      await api.computer.reset(bot.id);
    } catch (err) {
      useStore.setState({ error: (err as Error).message });
    }
  };

  const mouse = (e: React.MouseEvent<HTMLCanvasElement>, action: "move" | "down" | "up" | "click" | "dblclick") => {
    if (!controlled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (action === "move") {
      const now = performance.now();
      if (now - lastMove.current < MOVE_INTERVAL_MS) return;
      lastMove.current = now;
    }
    const { x, y } = toScreen(canvas, e.clientX, e.clientY);
    const modifiers = modifiersOf(e);
    sendInput({
      kind: "mouse",
      action,
      x,
      y,
      button: action === "move" ? undefined : buttonOf(e.button),
      modifiers: modifiers.length ? modifiers : undefined,
    });
  };

  const key = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!controlled) return;
    if (MODIFIER_KEYS.has(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const modifiers = modifiersOf(e);
    const printable = e.key.length === 1;
    if (printable && !e.ctrlKey && !e.metaKey && !e.altKey) {
      sendInput({ kind: "text", text: e.key });
      return;
    }
    sendInput({ kind: "key", action: "press", key: toPlaywrightKey(e.key), modifiers: modifiers.length ? modifiers : undefined });
  };

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-l border-line bg-sunken/40 md:w-[420px]">
      <div className="drag flex h-[52px] items-center justify-between gap-2 border-b border-line px-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-[14px] font-medium">{bot.name}'s screen</div>
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[12px] font-medium ${STATUS_CLASS[status]}`} title={state?.error}>
            {STATUS_LABEL[status]}
          </span>
        </div>
        <button onClick={onClose} className="no-drag rounded-md p-1 text-muted hover:bg-elev hover:text-fg" title="Close">
          <X size={15} />
        </button>
      </div>

      <div className="no-drag flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        <div className="flex items-center gap-1.5 rounded-app border border-line bg-elev px-2 py-1">
          <Globe size={12} className="shrink-0 text-muted" />
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onFocus={() => setUrlFocused(true)}
            onBlur={() => setUrlFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                navigate();
                e.currentTarget.blur();
              }
            }}
            placeholder="Enter a URL and press Enter"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted"
          />
        </div>

        <div className="relative w-full overflow-hidden rounded-lg border border-line bg-black" style={{ aspectRatio: `${SCREEN_SIZE.width} / ${SCREEN_SIZE.height}` }}>
          <canvas
            ref={canvasRef}
            width={SCREEN_SIZE.width}
            height={SCREEN_SIZE.height}
            tabIndex={0}
            onMouseMove={(e) => mouse(e, "move")}
            onMouseDown={(e) => mouse(e, "down")}
            onMouseUp={(e) => mouse(e, "up")}
            onClick={(e) => mouse(e, "click")}
            onDoubleClick={(e) => mouse(e, "dblclick")}
            onKeyDown={key}
            onContextMenu={(e) => controlled && e.preventDefault()}
            className={`block h-full w-full outline-none ${controlled ? "cursor-crosshair ring-2 ring-accent ring-inset" : "cursor-default"}`}
            aria-label={`${bot.name}'s screen`}
          />
          {!hasFrame && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-xs text-white/60">
              {status === "starting" || status === "reconnecting" ? <Loader2 size={22} className="animate-spin opacity-60" /> : <Monitor size={26} className="opacity-40" />}
              <span>
                {status === "off"
                  ? "The screen turns on when the Bot first uses its computer."
                  : status === "error"
                    ? (state?.error ?? "The Bot's computer hit an error.")
                    : status === "ready"
                      ? "Waiting for the first frame…"
                      : `${STATUS_LABEL[status]}…`}
              </span>
            </div>
          )}
        </div>

        <div className="flex min-w-0 items-center gap-2 text-[13px]">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-muted" title={state?.url ?? undefined}>
              {state?.url ?? "—"}
            </div>
            {state?.title && <div className="truncate text-fg">{state.title}</div>}
          </div>
          {state?.busy && (
            <span className="flex shrink-0 items-center gap-1 text-muted">
              <Loader2 size={11} className="animate-spin" /> Working…
            </span>
          )}
        </div>

        {recording ? (
          <div className="rounded-app border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs">
            <div className="flex items-center gap-2 font-medium">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
              </span>
              Recording · {recording.events} action{recording.events === 1 ? "" : "s"} · {clock(now - Date.parse(recording.startedAt))}
              <span className="font-normal text-muted">max {clock(TEACH_MAX_MS)}</span>
            </div>
            <div className="mt-0.5 text-muted">Do the task once on the Bot's screen. No audio is recorded.</div>
          </div>
        ) : teachSaved ? (
          <div className="rounded-app border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-xs">
            Recording saved. {bot.name} is drafting the skill in chat.
          </div>
        ) : controlled ? (
          <div className="rounded-app border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-xs">
            You're in control. Finish the step, then press <b>I'm done</b> and tell the Bot to continue.
          </div>
        ) : null}

        {teachOpen && !recording && (
          <div className="space-y-1.5 rounded-app border border-line bg-elev p-2.5">
            <div className="text-xs font-medium">What should the Bot learn? Describe the result.</div>
            <textarea
              value={teachText}
              onChange={(e) => setTeachText(e.target.value.slice(0, 500))}
              placeholder="e.g. Export last month's invoices from Xero as a CSV"
              rows={2}
              maxLength={500}
              autoFocus
              className="block w-full resize-none rounded-app border border-line bg-sunken px-2 py-1 text-[13.5px] outline-none placeholder:text-muted focus:border-accent"
            />
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-muted">{teachText.length} / 500</span>
              <div className="flex gap-1.5">
                <button onClick={() => setTeachOpen(false)} className="rounded-app px-2.5 py-1 text-xs text-muted hover:bg-sunken">
                  Cancel
                </button>
                <button
                  onClick={() => void startTeach()}
                  disabled={!teachText.trim() || teachBusy}
                  className="rounded-app bg-danger px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
                >
                  Start recording
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {recording ? (
            <button onClick={() => void stopTeach()} disabled={teachBusy} className="flex items-center gap-1.5 rounded-app bg-danger px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
              <Square size={11} fill="currentColor" /> Stop
            </button>
          ) : controlled ? (
            <button onClick={() => setControl(false)} className="flex items-center gap-1.5 rounded-app bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg">
              <Hand size={12} /> I'm done
            </button>
          ) : (
            <button
              onClick={() => setControl(true)}
              disabled={status === "off" || status === "error"}
              className="flex items-center gap-1.5 rounded-app border border-line bg-elev px-3 py-1.5 text-xs hover:bg-sunken disabled:opacity-50"
              title={status === "off" ? "The screen is off" : "Take over the mouse and keyboard"}
            >
              <Hand size={12} /> Take control
            </button>
          )}
          <button onClick={() => void reset()} className="flex items-center gap-1.5 rounded-app border border-line bg-elev px-3 py-1.5 text-xs hover:bg-sunken">
            <RotateCcw size={12} /> Reset
          </button>
          <button
            onClick={() => setTeachOpen((v) => !v)}
            disabled={!!recording || status === "error"}
            className={`flex items-center gap-1.5 rounded-app border px-3 py-1.5 text-xs disabled:opacity-50 ${teachOpen ? "border-accent bg-accent/10" : "border-line bg-elev hover:bg-sunken"}`}
            title="Record yourself doing a task once; the Bot turns it into a skill"
          >
            <GraduationCap size={12} /> Teach a task
          </button>
        </div>
      </div>
    </aside>
  );
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function toScreen(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  const x = Math.round(((clientX - r.left) / r.width) * SCREEN_SIZE.width);
  const y = Math.round(((clientY - r.top) / r.height) * SCREEN_SIZE.height);
  return {
    x: Math.max(0, Math.min(SCREEN_SIZE.width - 1, x)),
    y: Math.max(0, Math.min(SCREEN_SIZE.height - 1, y)),
  };
}

function buttonOf(b: number): "left" | "right" | "middle" {
  return b === 2 ? "right" : b === 1 ? "middle" : "left";
}

function modifiersOf(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): string[] {
  const m: string[] = [];
  if (e.ctrlKey) m.push("Control");
  if (e.metaKey) m.push("Meta");
  if (e.shiftKey) m.push("Shift");
  if (e.altKey) m.push("Alt");
  return m;
}

/** DOM KeyboardEvent.key → Playwright key name. Most names already match (Enter, Backspace, Tab, Escape, ArrowUp…). */
function toPlaywrightKey(key: string): string {
  switch (key) {
    case " ":
      return "Space";
    case "OS":
      return "Meta";
    case "Esc":
      return "Escape";
    case "Del":
      return "Delete";
    case "Spacebar":
      return "Space";
    default:
      return key;
  }
}
