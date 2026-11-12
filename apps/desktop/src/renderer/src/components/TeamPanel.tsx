import { useEffect, useMemo, useRef, useState } from "react";
import { Check, GitPullRequest, Maximize2, Pin as PinIcon, Plus, X } from "lucide-react";
import type { Bot, Pin, PullRequestLink, Task } from "@grokbot/shared";
import { plainPreview } from "@grokbot/shared";
import { api } from "../lib/api";
import { frameBus } from "../lib/frames";
import { useStore } from "../lib/store";
import { cronToText } from "../lib/time";
import { BotAvatar } from "./BotAvatar";

/**
 * Tidewater's right-hand panel: what the team is doing right now. A live view of a Bot's
 * computer, the shared task board, the pull requests Bots are working on, and the routines that run next.
 */
export function TeamPanel({ bot, onClose, onOpenComputer, fullScreen = false }: { bot: Bot | null; onClose: () => void; onOpenComputer?: () => void; fullScreen?: boolean }) {
  return (
    <aside
      className={`no-drag flex shrink-0 flex-col gap-5 overflow-y-auto bg-sunken p-4 ${fullScreen ? "h-full w-full pt-[max(1rem,env(safe-area-inset-top))]" : "w-[300px] border-l border-line"}`}
    >
      <div className="flex items-center justify-between">
        <span className="font-serif text-[22px] leading-none">Team pulse</span>
        <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-elev hover:text-fg" title="Hide panel">
          <X size={15} />
        </button>
      </div>
      {bot && <LiveScreen bot={bot} onOpen={onOpenComputer} />}
      <Pinned />
      <TaskBoard defaultOwner={bot} />
      <PullRequests />
      <NextUp />
    </aside>
  );
}

function LiveScreen({ bot, onOpen }: { bot: Bot; onOpen?: () => void }) {
  const wsSend = useStore((s) => s.wsSend);
  const screen = useStore((s) => s.screens[bot.id]);
  const status = useStore((s) => s.botStatus[bot.id] ?? "idle");
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hasFrame, setHasFrame] = useState(false);

  useEffect(() => {
    setHasFrame(false);
    wsSend({ type: "screen.watch", botId: bot.id });
    const img = new Image();
    const unsubscribe = frameBus.subscribe(bot.id, (f) => {
      img.onload = () => {
        const c = canvas.current;
        const ctx = c?.getContext("2d");
        if (!c || !ctx) return;
        if (c.width !== f.width || c.height !== f.height) {
          c.width = f.width;
          c.height = f.height;
        }
        ctx.drawImage(img, 0, 0, c.width, c.height);
        setHasFrame(true);
      };
      img.src = `data:image/jpeg;base64,${f.data}`;
    });
    return () => {
      unsubscribe();
      wsSend({ type: "screen.unwatch", botId: bot.id });
    };
  }, [bot.id, wsSend]);

  const live = screen?.status === "ready";
  const host = screen?.url ? safeHost(screen.url) : null;
  // A blank page streams as a white frame: show the hint instead.
  const showFrame = hasFrame && !!host;
  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-elev">
      <button onClick={onOpen} className="flex w-full items-center gap-2 border-b border-line px-2.5 py-1.5 text-left font-mono text-[12.5px] text-muted hover:text-fg" title="Open the full computer">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? "tide-live bg-accent" : "bg-muted/40"}`} />
        <span className="min-w-0 flex-1 truncate">
          {bot.name}
          {host ? ` · ${host}` : live ? " · blank" : " · computer off"}
        </span>
        {status === "working" && <span className="text-accent">working</span>}
        <Maximize2 size={11} />
      </button>
      <div className="relative aspect-[16/10] bg-bg">
        <canvas ref={canvas} className={`h-full w-full object-contain ${showFrame ? "" : "hidden"}`} />
        {!showFrame && (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[13px] text-muted">
            {live && host ? "Waiting for the first frame…" : live ? `${bot.name}'s browser is open on a blank page.` : `${bot.name}'s computer starts when it needs the browser.`}
          </div>
        )}
      </div>
    </div>
  );
}

const STATUS_DOT: Record<Task["status"], string> = {
  open: "bg-muted/50",
  doing: "bg-accent tide-live",
  blocked: "bg-signal",
  done: "bg-accent",
  dropped: "bg-muted/30",
};

function TaskBoard({ defaultOwner }: { defaultOwner: Bot | null }) {
  const allTasks = useStore((s) => s.tasks);
  const bots = useStore((s) => s.bots);
  const spaceId = useStore((s) => s.spaceId);
  // This space's work: tasks owned by or created by its Bots.
  const tasks = useMemo(() => {
    const ids = new Set(bots.filter((b) => !spaceId || b.spaceId === spaceId).map((b) => b.id));
    return allTasks.filter((t) => (t.ownerBotId && ids.has(t.ownerBotId)) || (t.createdBy && ids.has(t.createdBy)) || (!t.ownerBotId && !t.createdBy));
  }, [allTasks, bots, spaceId]);
  const createTask = useStore((s) => s.createTask);
  const updateTask = useStore((s) => s.updateTask);
  const selectBot = useStore((s) => s.selectBot);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  // Waiting on the user first, then blocked, doing, open; newest first within each.
  const ordered = useMemo(() => {
    const rank = (t: Task) => (t.ownerBotId === null ? 0 : t.status === "blocked" ? 1 : t.status === "doing" ? 2 : 3);
    return [...tasks].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  }, [tasks]);
  const name = (id: string | null) => (id ? (bots.find((b) => b.id === id)?.name ?? "?") : "you");

  const add = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await createTask({ title: title.trim(), ownerBotId: defaultOwner?.id ?? null });
      setTitle("");
      setAdding(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="label-mono">Task board{tasks.length ? ` · ${tasks.length}` : ""}</span>
        <button onClick={() => setAdding((v) => !v)} className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-elev hover:text-fg" title="Add a task">
          <Plus size={14} />
        </button>
      </div>
      {adding && (
        <div className="mb-2 rounded-[10px] border border-line bg-elev p-2">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
              if (e.key === "Escape") setAdding(false);
            }}
            placeholder={defaultOwner ? `A task for ${defaultOwner.name}…` : "A task for you…"}
            className="w-full bg-transparent text-[14.5px] outline-none placeholder:text-muted"
          />
          <div className="mt-1.5 flex items-center justify-between font-mono text-[12px] text-muted">
            <span>{defaultOwner ? `${defaultOwner.name} starts on it right away` : "Owner: you"}</span>
            <span>↵ add</span>
          </div>
        </div>
      )}
      {ordered.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-line px-3 py-4 text-center text-[13.5px] text-muted">
          Nothing open. Ask the Chief to delegate, or add a task.
        </div>
      ) : (
        <div className="divide-y divide-line">
          {ordered.slice(0, 12).map((t) => (
            <div key={t.id} className="group flex items-start gap-2.5 py-2">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${t.ownerBotId === null ? "bg-signal" : STATUS_DOT[t.status]}`} />
              <button onClick={() => t.ownerBotId && void selectBot(t.ownerBotId)} className="min-w-0 flex-1 text-left" title={t.detail || t.title}>
                <div className="line-clamp-2 text-[14px] leading-snug">{t.title}</div>
                <div className="font-mono text-[12px] text-muted">
                  {name(t.ownerBotId)} · {t.ownerBotId === null ? "waiting on you" : t.status}
                </div>
              </button>
              <button
                onClick={() => void updateTask(t.id, { status: "done" })}
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line text-muted opacity-0 hover:border-accent hover:text-accent group-hover:opacity-100"
                title="Mark done"
              >
                <Check size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Messages the user pinned to come back to. Click to jump to the message; × unpins. */
function Pinned() {
  const pins = useStore((s) => s.pins);
  const bots = useStore((s) => s.bots);
  const groups = useStore((s) => s.groups);
  const spaceId = useStore((s) => s.spaceId);
  const openPin = useStore((s) => s.openPin);
  const unpin = useStore((s) => s.unpin);
  const [showAll, setShowAll] = useState(false);

  const shown = useMemo(() => {
    const ids = new Set(bots.filter((b) => !spaceId || b.spaceId === spaceId).map((b) => b.id));
    return pins.filter((p) => !p.botId || ids.has(p.botId) || groups.some((g) => g.id === p.conversationId));
  }, [pins, bots, groups, spaceId]);

  if (!shown.length) return null;
  const where = (p: Pin) => {
    const group = groups.find((g) => g.id === p.conversationId);
    const author = p.role === "user" ? "You" : (bots.find((b) => b.id === p.botId)?.name ?? "a Bot");
    return group ? `${author} in ${group.title ?? "group chat"}` : author;
  };
  const list = showAll ? shown : shown.slice(0, 6);
  return (
    <section>
      <div className="label-mono mb-1.5">Pinned · {shown.length}</div>
      <div className="divide-y divide-line">
        {list.map((p) => (
          <div key={p.id} className="group flex items-start gap-2.5 py-2">
            <PinIcon size={13} className="mt-1 shrink-0 fill-current text-accent" />
            <button onClick={() => void openPin(p)} className="min-w-0 flex-1 text-left" title={p.text}>
              <div className="line-clamp-3 whitespace-pre-line break-words text-[14px] leading-snug">{plainPreview(p.text)}</div>
              <div className="truncate font-mono text-[12px] text-muted">
                {where(p)} · {agoLabel(p.messageAt)}
              </div>
            </button>
            <button
              onClick={() => void unpin(p.id)}
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted opacity-0 hover:bg-elev hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              title="Unpin"
              aria-label="Unpin"
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
      {shown.length > 6 && (
        <button onClick={() => setShowAll((v) => !v)} className="mt-1 font-mono text-[12px] text-muted hover:text-fg">
          {showAll ? "Show fewer" : `Show all ${shown.length}`}
        </button>
      )}
    </section>
  );
}

const HIDDEN_PRS_KEY = "cadre.hiddenPullRequests";

/** url -> when it was hidden. A PR mentioned again after that shows up again. */
function loadHiddenPrs(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_PRS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/** GitHub pull requests this space's Bots mentioned in the last two weeks; click to open on GitHub. */
function PullRequests() {
  const bots = useStore((s) => s.bots);
  const spaceId = useStore((s) => s.spaceId);
  const prRev = useStore((s) => s.prRev);
  const [prs, setPrs] = useState<PullRequestLink[]>([]);
  const [hidden, setHidden] = useState<Record<string, string>>(loadHiddenPrs);

  useEffect(() => {
    let live = true;
    const load = () =>
      api.pullRequests
        .list()
        .then((list) => live && setPrs(list))
        .catch(() => {
          /* older server: no PR list */
        });
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [prRev]);

  const shown = useMemo(() => {
    const ids = new Set(bots.filter((b) => !spaceId || b.spaceId === spaceId).map((b) => b.id));
    return prs.filter((p) => (!p.botId || ids.has(p.botId)) && !(hidden[p.url] && hidden[p.url] >= p.lastSeenAt)).slice(0, 8);
  }, [prs, bots, spaceId, hidden]);

  const hide = (p: PullRequestLink) => {
    const next = { ...hidden, [p.url]: new Date().toISOString() };
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_PRS_KEY, JSON.stringify(next));
    } catch {
      /* not remembered; fine */
    }
  };

  if (!shown.length) return null;
  return (
    <section>
      <div className="label-mono mb-1.5">Pull requests · {shown.length}</div>
      <div className="divide-y divide-line">
        {shown.map((p) => {
          const b = bots.find((x) => x.id === p.botId);
          return (
            <div key={p.url} className="group flex items-start gap-2.5 py-2">
              <GitPullRequest size={14} className="mt-0.5 shrink-0 text-accent" />
              <a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 text-left" title={`Open ${p.url}`}>
                <div className="truncate text-[14px] leading-snug underline-offset-2 group-hover:underline">
                  {p.repo.split("/")[1]} #{p.number}
                </div>
                <div className="truncate font-mono text-[12px] text-muted">
                  {b?.name ?? "a Bot"} · {agoLabel(p.lastSeenAt)}
                </div>
              </a>
              <button
                onClick={() => hide(p)}
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted opacity-0 hover:bg-elev hover:text-fg group-hover:opacity-100"
                title="Hide (it comes back if a Bot mentions it again)"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function agoLabel(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function NextUp() {
  const routines = useStore((s) => s.routines);
  const bots = useStore((s) => s.bots);
  const spaceId = useStore((s) => s.spaceId);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const next = useMemo(
    () =>
      Object.values(routines)
        .flat()
        .filter((r) => r.enabled && r.nextRunAt && Date.parse(r.nextRunAt) > Date.now() - 60_000)
        .filter((r) => !spaceId || bots.find((b) => b.id === r.botId)?.spaceId === spaceId)
        .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
        .slice(0, 5),
    [routines, bots, spaceId],
  );
  if (!next.length) return null;
  return (
    <section>
      <div className="label-mono mb-1.5">Next up</div>
      <div className="space-y-1.5">
        {next.map((r) => {
          const b = bots.find((x) => x.id === r.botId);
          return (
            <div key={r.id} className="flex items-center gap-2 text-[14px]" title={r.trigger.kind === "schedule" ? cronToText(r.trigger.cron) : r.name}>
              {b && <BotAvatar name={b.name} color={b.avatarColor} shape={b.avatarShape} image={b.avatarImage} size={18} />}
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{b?.name ?? "Bot"}</span> <span className="text-muted">{r.name}</span>
              </span>
              <span className="shrink-0 font-mono text-[12.5px] text-muted">{whenLabel(r.nextRunAt!)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function whenLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `tmrw ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: "short" }).toLowerCase()} ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}
