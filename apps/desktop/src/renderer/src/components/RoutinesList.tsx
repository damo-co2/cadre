import { useEffect, useState } from "react";
import { Copy, History, Play, Plus, Trash2 } from "lucide-react";
import type { Routine, RoutineRun, RoutineTrigger } from "@grokbot/shared";
import { MAX_ROUTINES_PER_BOT } from "@grokbot/shared";
import { api, SERVER_URL } from "../lib/api";
import type { CreateRoutineInput } from "../lib/api";
import { useStore } from "../lib/store";
import { relativeTime, shortTime } from "../lib/time";

/** Bot details → Routines: scheduled, webhook and manual jobs for this Bot. */
export function RoutinesList({ botId }: { botId: string }) {
  const routines = useStore((s) => s.routines[botId] as Routine[] | undefined) ?? [];
  const loadRoutines = useStore((s) => s.loadRoutines);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadRoutines(botId);
  }, [botId, loadRoutines]);

  const full = routines.length >= MAX_ROUTINES_PER_BOT;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[12.5px] text-muted">
        <span>
          {routines.length} / {MAX_ROUTINES_PER_BOT}
        </span>
        {!adding && (
          <button onClick={() => setAdding(true)} disabled={full} className="flex items-center gap-1 hover:text-fg disabled:opacity-50" title={full ? "Routine limit reached" : undefined}>
            <Plus size={11} /> Add routine
          </button>
        )}
      </div>
      {routines.length === 0 && !adding && (
        <div className="rounded-app border border-dashed border-line px-2.5 py-2 text-xs text-muted">No routines yet. Add one, or ask the Bot to run something on a schedule.</div>
      )}
      <div className="max-h-64 space-y-1.5 overflow-y-auto">
        {routines.map((r) => (
          <RoutineRow key={r.id} routine={r} onError={setError} />
        ))}
      </div>
      {adding && <AddRoutineForm botId={botId} onClose={() => setAdding(false)} onError={setError} />}
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}

function triggerLine(t: RoutineTrigger, timezone: string | null): string {
  if (t.kind === "schedule") return `${t.cron}${timezone ? ` · ${timezone}` : ""}`;
  return t.kind === "webhook" ? "Webhook" : "Manual";
}

function RoutineRow({ routine: r, onError }: { routine: Routine; onError: (e: string | null) => void }) {
  const runs = useStore((s) => s.routineRuns[r.id] as RoutineRun[] | undefined);
  const loadRuns = useStore((s) => s.loadRoutineRuns);
  const [showRuns, setShowRuns] = useState(false);
  const [started, setStarted] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!started && !copied) return;
    const t = setTimeout(() => {
      setStarted(false);
      setCopied(false);
    }, 2000);
    return () => clearTimeout(t);
  }, [started, copied]);

  const guard = (fn: () => Promise<unknown>) => {
    onError(null);
    fn().catch((err: Error) => onError(err.message));
  };

  const toggleRuns = () => {
    const next = !showRuns;
    setShowRuns(next);
    if (next) guard(() => loadRuns(r.id));
  };

  const next = relativeTime(r.nextRunAt);
  const last = relativeTime(r.lastRunAt);

  return (
    <div className="rounded-app border border-line bg-sunken/60 px-2.5 py-2 text-[13.5px]">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium" title={r.instruction}>
            {r.name}
          </div>
          <div className="truncate font-mono text-[12.5px] text-muted">{triggerLine(r.trigger, r.timezone)}</div>
          <div className="text-[12.5px] text-muted">
            {r.enabled && next ? `Next run ${next}` : null}
            {r.enabled && next && last ? " · " : null}
            {last ? `Last run ${last}` : !next || !r.enabled ? "Never run" : null}
          </div>
        </div>
        <Switch value={r.enabled} onChange={(v) => guard(() => api.routines.update(r.id, { enabled: v }))} />
      </div>
      {r.trigger.kind === "webhook" && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded bg-elev px-1.5 py-0.5 font-mono text-[12px] text-muted" title={`${SERVER_URL}/api/hooks/${r.id}`}>
            {SERVER_URL}/api/hooks/{r.id}
          </code>
          <button
            onClick={() => {
              if (!r.webhookKey) return;
              void navigator.clipboard.writeText(r.webhookKey).then(() => setCopied(true));
            }}
            disabled={!r.webhookKey}
            className="flex shrink-0 items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[12.5px] hover:bg-elev disabled:opacity-50"
            title="Copy the Bearer key for Authorization"
          >
            <Copy size={10} /> {copied ? "Copied" : "Copy key"}
          </button>
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1">
        <SmallBtn onClick={() => guard(() => api.routines.test(r.id).then(() => setStarted(true)))} icon={<Play size={10} />}>
          {started ? "Started" : "Test"}
        </SmallBtn>
        <SmallBtn onClick={toggleRuns} icon={<History size={10} />} active={showRuns}>
          Runs
        </SmallBtn>
        <SmallBtn
          danger
          icon={<Trash2 size={10} />}
          onClick={() => {
            if (window.confirm(`Delete routine "${r.name}"? This can't be undone.`)) guard(() => api.routines.delete(r.id));
          }}
        >
          Delete
        </SmallBtn>
      </div>
      {showRuns && (
        <div className="mt-1.5 space-y-0.5 border-t border-line pt-1.5">
          {!runs && <div className="text-[12.5px] text-muted">Loading…</div>}
          {runs && runs.length === 0 && <div className="text-[12.5px] text-muted">No runs yet.</div>}
          {runs?.map((run) => (
            <div key={run.id} className="flex items-baseline gap-1.5 text-[12.5px]">
              <span className={run.status === "error" ? "text-danger" : run.status === "done" ? "text-accent" : "text-muted"}>{run.status}</span>
              <span className="text-muted">{run.source}</span>
              <span className="text-muted">{shortTime(run.startedAt)}</span>
              {run.error && (
                <span className="min-w-0 truncate text-danger" title={run.error}>
                  {run.error}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddRoutineForm({ botId, onClose, onError }: { botId: string; onClose: () => void; onError: (e: string | null) => void }) {
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [kind, setKind] = useState<RoutineTrigger["kind"]>("schedule");
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState("");
  const [busy, setBusy] = useState(false);

  const valid = name.trim() && instruction.trim() && (kind !== "schedule" || cron.trim());

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    onError(null);
    const trigger: RoutineTrigger = kind === "schedule" ? { kind, cron: cron.trim() } : { kind };
    const input: CreateRoutineInput = { name: name.trim(), instruction: instruction.trim(), trigger, timezone: timezone.trim() || null, enabled: true };
    try {
      const routine = await api.routines.create(botId, input);
      // The routine.updated event also delivers this; upsert now so the row appears without waiting.
      useStore.setState((s) => {
        const list = s.routines[botId] ?? [];
        return { routines: { ...s.routines, [botId]: list.some((r) => r.id === routine.id) ? list : [...list, routine] } };
      });
      onClose();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5 rounded-app border border-line bg-sunken/60 p-2.5">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" maxLength={80} autoFocus className={inputClass} />
      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="What should the Bot do each run?"
        rows={3}
        className={`${inputClass} resize-none`}
      />
      <select value={kind} onChange={(e) => setKind(e.target.value as RoutineTrigger["kind"])} className={inputClass}>
        <option value="schedule">Schedule</option>
        <option value="webhook">Webhook</option>
        <option value="manual">Manual</option>
      </select>
      {kind === "schedule" && (
        <div>
          <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="Cron expression" spellCheck={false} className={`${inputClass} font-mono`} />
          <div className="mt-0.5 text-[12px] text-muted">e.g. 0 8 * * 1-5 = weekdays 08:00</div>
        </div>
      )}
      <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Timezone (blank = app timezone)" spellCheck={false} className={inputClass} />
      <div className="flex justify-end gap-1.5 pt-0.5">
        <button onClick={onClose} className="rounded-app px-2.5 py-1 text-[13.5px] text-muted hover:bg-elev">
          Cancel
        </button>
        <button onClick={() => void submit()} disabled={!valid || busy} className="rounded-app bg-accent px-3 py-1 text-[13.5px] font-medium text-accent-fg disabled:opacity-40">
          Add routine
        </button>
      </div>
    </div>
  );
}

const inputClass = "block w-full rounded-app border border-line bg-elev px-2 py-1 text-[13.5px] outline-none placeholder:text-muted";

function Switch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors ${value ? "bg-accent" : "bg-line"}`}
      role="switch"
      aria-checked={value}
      title={value ? "Active" : "Paused"}
    >
      <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${value ? "left-[14px]" : "left-0.5"}`} />
    </button>
  );
}

function SmallBtn({ children, onClick, icon, danger, active }: { children: React.ReactNode; onClick: () => void; icon?: React.ReactNode; danger?: boolean; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[12.5px] ${
        danger ? "border-transparent text-danger hover:bg-danger/10" : active ? "border-line bg-elev" : "border-line hover:bg-elev"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
