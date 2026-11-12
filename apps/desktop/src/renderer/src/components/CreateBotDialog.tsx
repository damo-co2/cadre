import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Clock, Sparkles, Users, Webhook } from "lucide-react";
import type { BotTemplate, SquadTemplate, TemplateCategory } from "@grokbot/shared";
import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarShape } from "@grokbot/shared";
import { useStore } from "../lib/store";
import { cronToText } from "../lib/time";
import { BotAvatar } from "./BotAvatar";
import { Dialog } from "./Dialog";
import { ModelPicker } from "./ModelPicker";
import { defaultLabel, useDefaultModel } from "../lib/defaultModel";

type Step = { kind: "gallery" } | { kind: "blank" } | { kind: "template"; template: BotTemplate } | { kind: "squad"; squad: SquadTemplate };

const CATEGORY_LABEL: Record<TemplateCategory, string> = {
  leadership: "Leadership",
  work: "Work",
  research: "Research",
  engineering: "Engineering",
  monitoring: "Monitoring",
  life: "Life",
  creative: "Creative",
  plugins: "From your plugins",
};
const CATEGORY_ORDER: TemplateCategory[] = ["leadership", "work", "research", "engineering", "monitoring", "life", "creative", "plugins"];

export function CreateBotDialog() {
  const setCreateOpen = useStore((s) => s.setCreateOpen);
  const createTemplateId = useStore((s) => s.createTemplateId);
  const templates = useStore((s) => s.templates);
  const loadTemplates = useStore((s) => s.loadTemplates);
  const [step, setStep] = useState<Step>({ kind: "gallery" });
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (templates) return;
    loadTemplates().catch((err: Error) => setLoadError(err.message));
  }, [templates, loadTemplates]);

  // Welcome's "start with a Chief of Staff" opens the dialog straight on that template.
  useEffect(() => {
    if (!createTemplateId || !templates) return;
    const t = templates.bots.find((b) => b.id === createTemplateId);
    if (t) setStep({ kind: "template", template: t });
  }, [createTemplateId, templates]);

  const close = () => setCreateOpen(false);
  const back = () => setStep({ kind: "gallery" });

  if (step.kind === "blank") return <BlankForm onBack={back} onClose={close} />;
  if (step.kind === "template") return <TemplateForm template={step.template} onBack={back} onClose={close} />;
  if (step.kind === "squad") return <SquadForm squad={step.squad} onBack={back} onClose={close} />;

  return (
    <Dialog title="Create New Bot" onClose={close} width={640} tall>
      <Gallery
        catalog={templates}
        error={loadError}
        onBlank={() => setStep({ kind: "blank" })}
        onTemplate={(template) => setStep({ kind: "template", template })}
        onSquad={(squad) => setStep({ kind: "squad", squad })}
      />
    </Dialog>
  );
}

// ---------- Step 1: gallery ----------

function Gallery({
  catalog,
  error,
  onBlank,
  onTemplate,
  onSquad,
}: {
  catalog: ReturnType<typeof useStore.getState>["templates"];
  error: string | null;
  onBlank: () => void;
  onTemplate: (t: BotTemplate) => void;
  onSquad: (s: SquadTemplate) => void;
}) {
  const grouped = useMemo(() => {
    const map = new Map<TemplateCategory, BotTemplate[]>();
    for (const t of catalog?.bots ?? []) map.set(t.category, [...(map.get(t.category) ?? []), t]);
    const known = CATEGORY_ORDER.filter((c) => map.has(c));
    const extra = [...map.keys()].filter((c) => !CATEGORY_ORDER.includes(c));
    return [...known, ...extra].map((c) => ({ category: c, items: map.get(c)! }));
  }, [catalog]);

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 label-mono">Start from a template</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            onClick={onBlank}
            className="flex items-start gap-3 rounded-app border border-dashed border-line bg-elev p-3 text-left hover:border-accent"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-sunken text-muted">
              <Sparkles size={16} />
            </div>
            <div className="min-w-0">
              <div className="text-[14.5px] font-medium">Blank Bot</div>
              <div className="text-xs text-muted">Just a name and a picture. Tell it its job in the first message.</div>
            </div>
          </button>
        </div>
      </div>

      {!catalog && !error && <div className="text-xs text-muted">Loading templates…</div>}
      {error && (
        <div className="rounded-app border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          Templates could not be loaded: {error}. You can still create a blank Bot.
        </div>
      )}

      {grouped.map(({ category, items }) => (
        <div key={category}>
          <div className="mb-2 label-mono">{CATEGORY_LABEL[category] ?? category}</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {items.map((t) => (
              <TemplateCard key={t.id} template={t} onClick={() => onTemplate(t)} />
            ))}
          </div>
        </div>
      ))}

      {catalog && catalog.squads.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-1 label-mono">
            <Users size={11} /> Squads
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {catalog.squads.map((sq) => (
              <button
                key={sq.id}
                onClick={() => onSquad(sq)}
                className="flex items-start gap-3 rounded-app border border-line bg-elev p-3 text-left hover:border-accent"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sunken text-lg">{sq.emoji}</div>
                <div className="min-w-0">
                  <div className="text-[14.5px] font-medium">{sq.name}</div>
                  <div className="line-clamp-2 text-xs text-muted">{sq.tagline}</div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    <Chip>
                      {sq.botTemplateIds.length} Bot{sq.botTemplateIds.length === 1 ? "" : "s"} + group chat
                    </Chip>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TemplateCard({ template: t, onClick }: { template: BotTemplate; onClick: () => void }) {
  const routines = t.routines.length;
  return (
    <button onClick={onClick} className="flex items-start gap-3 rounded-app border border-line bg-elev p-3 text-left hover:border-accent">
      <div className="relative shrink-0">
        <BotAvatar name=" " color={t.color} shape={t.shape} size={36} />
        <span className="absolute -bottom-1 -right-1 text-[15px] leading-none">{t.emoji}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-[14.5px] font-medium">{t.name}</span>
          <span className="truncate text-[12.5px] text-muted">{t.label}</span>
        </div>
        <div className="line-clamp-2 text-xs text-muted">{t.tagline}</div>
        {(routines > 0 || t.primary) && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {routines > 0 && (
              <Chip>
                {routines} routine{routines === 1 ? "" : "s"}
              </Chip>
            )}
            {t.primary && <Chip accent>Primary</Chip>}
          </div>
        )}
      </div>
    </button>
  );
}

function Chip({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[12px] font-medium ${accent ? "bg-accent/15 text-accent" : "bg-sunken text-muted"}`}>{children}</span>
  );
}

// ---------- Step 2a: blank Bot (today's form) ----------

function BlankForm({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const createBot = useStore((s) => s.createBot);
  const [name, setName] = useState("");
  const [shape, setShape] = useState<AvatarShape>("circle");
  const [color, setColor] = useState<string>(AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createBot({ name: name.trim(), avatarShape: shape, avatarColor: color });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog title="Create New Bot" onClose={onClose} width={440}>
      <div className="flex flex-col items-center gap-5">
        <BotAvatar name={name || "?"} color={color} shape={shape} size={84} />
        <input
          ref={input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="Bot name"
          maxLength={60}
          className="w-full rounded-app border border-line bg-sunken px-3 py-2 text-center text-base outline-none focus:border-accent"
        />
        <AvatarEditor shape={shape} color={color} onShape={setShape} onColor={setColor} />
        {error && <div className="w-full text-xs text-danger">{error}</div>}
        <div className="flex w-full items-center justify-between gap-2">
          <BackButton onClick={onBack} />
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-app px-3 py-1.5 text-[14.5px] text-muted hover:bg-sunken">
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={!name.trim() || busy}
              className="rounded-app bg-accent px-4 py-1.5 text-[14.5px] font-medium text-accent-fg disabled:opacity-40"
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function AvatarEditor({
  shape,
  color,
  onShape,
  onColor,
}: {
  shape: AvatarShape;
  color: string;
  onShape: (s: AvatarShape) => void;
  onColor: (c: string) => void;
}) {
  return (
    <div className="w-full">
      <div className="mb-1.5 label-mono">Picture</div>
      <div className="mb-3 flex gap-2">
        {AVATAR_SHAPES.map((s) => (
          <button
            key={s}
            onClick={() => onShape(s)}
            className={`flex h-10 w-10 items-center justify-center rounded-md border ${shape === s ? "border-accent" : "border-line"}`}
            title={s}
          >
            <BotAvatar name=" " color={color} shape={s} size={22} />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {AVATAR_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => onColor(c)}
            className={`h-7 w-7 rounded-full border-2 ${color === c ? "border-fg" : "border-transparent"}`}
            style={{ background: c }}
            title={c}
          />
        ))}
      </div>
    </div>
  );
}

// ---------- Step 2b: from a template ----------

function TemplateForm({ template: t, onBack, onClose }: { template: BotTemplate; onBack: () => void; onClose: () => void }) {
  const createBotFromTemplate = useStore((s) => s.createBotFromTemplate);
  const bots = useStore((s) => s.bots);
  const spaceId = useStore((s) => s.spaceId);
  const effectiveDefault = useDefaultModel(useStore((s) => s.spaceId));
  const hasPrimary = bots.some((b) => b.isPrimary && (!spaceId || b.spaceId === spaceId));
  const [name, setName] = useState(t.name);
  const [shape, setShape] = useState<AvatarShape>(t.shape);
  const [color, setColor] = useState<string>(t.color);
  const [modelRef, setModelRef] = useState<string | null>(null);
  const [withRoutines, setWithRoutines] = useState(true);
  const [introduce, setIntroduce] = useState(true);
  const [makePrimary, setMakePrimary] = useState(Boolean(t.primary) && !hasPrimary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const avatarChanged = shape !== t.shape || color !== t.color;

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createBotFromTemplate(
        t.id,
        {
          name: name.trim() !== t.name ? name.trim() : undefined,
          modelRef: modelRef ?? undefined,
          withRoutines,
          introduce,
          makePrimary,
        },
        avatarChanged ? { avatarShape: shape, avatarColor: color } : undefined,
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const brief = t.brief.length > 300 ? `${t.brief.slice(0, 300).trimEnd()}…` : t.brief;

  return (
    <Dialog title={`New ${t.label}`} onClose={onClose} width={640} tall>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-3">
            <div className="relative shrink-0">
              <BotAvatar name={name || "?"} color={color} shape={shape} size={56} />
              <span className="absolute -bottom-1 -right-1 text-[18px] leading-none">{t.emoji}</span>
            </div>
            <div className="min-w-0 flex-1">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submit()}
                placeholder="Bot name"
                maxLength={60}
                autoFocus
                className="w-full rounded-app border border-line bg-sunken px-3 py-1.5 text-[15.5px] font-medium outline-none focus:border-accent"
              />
              <div className="mt-1 text-xs text-muted">{t.tagline}</div>
            </div>
          </div>

          <AvatarEditor shape={shape} color={color} onShape={setShape} onColor={setColor} />

          <div>
            <div className="mb-1.5 label-mono">Model</div>
            <ModelPicker value={modelRef} allowDefault defaultLabel={defaultLabel(effectiveDefault)} onChange={setModelRef} />
          </div>

          <div className="space-y-2">
            <Check value={withRoutines} onChange={setWithRoutines} label="Create its routines" hint={t.routines.length ? `${t.routines.length} scheduled or webhook task${t.routines.length === 1 ? "" : "s"}` : "This template has no routines"} disabled={!t.routines.length} />
            <Check value={introduce} onChange={setIntroduce} label="Introduce itself" hint="Wakes up, says hello and asks its setup questions" />
            <Check value={makePrimary} onChange={setMakePrimary} label="Make it the primary Bot" hint={hasPrimary ? "Replaces the current primary Bot" : "The Bot that opens first"} />
          </div>

          {error && <div className="text-xs text-danger">{error}</div>}
        </div>

        <Preview template={t} brief={brief} withRoutines={withRoutines} />
      </div>

      <div className="mt-5 flex items-center justify-between gap-2">
        <BackButton onClick={onBack} />
        <div className="flex gap-2">
          <button onClick={onClose} className="rounded-app px-3 py-1.5 text-[14.5px] text-muted hover:bg-sunken">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={!name.trim() || busy}
            className="rounded-app bg-accent px-4 py-1.5 text-[14.5px] font-medium text-accent-fg disabled:opacity-40"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function Preview({ template: t, brief, withRoutines }: { template: BotTemplate; brief: string; withRoutines: boolean }) {
  return (
    <aside className="space-y-3 rounded-app border border-line bg-sunken/60 p-3 text-xs">
      <div className="label-mono">What you'll get</div>
      <div>
        <div className="mb-0.5 font-medium">Brief</div>
        <p className="whitespace-pre-line text-muted">{brief}</p>
      </div>
      {t.routines.length > 0 && (
        <div className={withRoutines ? "" : "opacity-50"}>
          <div className="mb-0.5 font-medium">Routines{withRoutines ? "" : " (skipped)"}</div>
          <ul className="space-y-1">
            {t.routines.map((r) => (
              <li key={r.name} className="flex items-start gap-1.5">
                {r.webhook ? <Webhook size={11} className="mt-0.5 shrink-0 text-muted" /> : <Clock size={11} className="mt-0.5 shrink-0 text-muted" />}
                <span className="min-w-0">
                  <span className="text-fg">{r.name}</span>
                  <span className="text-muted"> · {r.webhook ? "Webhook" : r.cron ? cronToText(r.cron) : "Manual"}{r.enabled === false ? " · paused" : ""}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {t.skills.length > 0 && (
        <div>
          <div className="mb-0.5 font-medium">Skills</div>
          <div className="flex flex-wrap gap-1">
            {t.skills.map((s) => (
              <span key={s.name} className="rounded bg-elev px-1.5 py-0.5 font-mono text-[12px]">
                /{s.name}
              </span>
            ))}
          </div>
        </div>
      )}
      {t.rules.length > 0 && (
        <div className="text-muted">
          {t.rules.length} Auto Review rule{t.rules.length === 1 ? "" : "s"}
        </div>
      )}
      {t.asks.length > 0 && (
        <div>
          <div className="mb-0.5 font-medium">It will ask you</div>
          <ul className="list-disc space-y-0.5 pl-4 text-muted">
            {t.asks.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

// ---------- Step 2c: squad ----------

function SquadForm({ squad, onBack, onClose }: { squad: SquadTemplate; onBack: () => void; onClose: () => void }) {
  const createSquad = useStore((s) => s.createSquad);
  const templates = useStore((s) => s.templates);
  const effectiveDefault = useDefaultModel(useStore((s) => s.spaceId));
  const [modelRef, setModelRef] = useState<string | null>(null);
  const [withRoutines, setWithRoutines] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const members = squad.botTemplateIds.map((id) => templates?.bots.find((b) => b.id === id)).filter((b): b is BotTemplate => Boolean(b));
  const routineCount = members.reduce((n, b) => n + b.routines.length, 0);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await createSquad(squad.id, { modelRef: modelRef ?? undefined, withRoutines });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog title={`New squad: ${squad.name}`} onClose={onClose} width={520}>
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sunken text-2xl">{squad.emoji}</div>
          <div>
            <div className="text-[15.5px] font-semibold">{squad.name}</div>
            <div className="text-xs text-muted">{squad.tagline}</div>
          </div>
        </div>

        <div>
          <div className="mb-1.5 label-mono">
            {squad.botTemplateIds.length} Bots + group chat "{squad.groupTitle}"
          </div>
          <div className="space-y-1">
            {members.length ? (
              members.map((b, i) => (
                <div key={b.id} className="flex items-center gap-2.5 rounded-app border border-line bg-elev px-2.5 py-1.5">
                  <BotAvatar name=" " color={b.color} shape={b.shape} size={24} />
                  <div className="min-w-0 flex-1">
                    <span className="text-[14.5px] font-medium">{b.name}</span> <span className="text-[12.5px] text-muted">{b.label}</span>
                    {i === 0 && <Chip accent>Lead</Chip>}
                  </div>
                  {b.routines.length > 0 && <Chip>{b.routines.length} routine{b.routines.length === 1 ? "" : "s"}</Chip>}
                </div>
              ))
            ) : (
              <div className="text-xs text-muted">{squad.botTemplateIds.join(", ")}</div>
            )}
          </div>
        </div>

        <div className="rounded-app border border-line bg-sunken/60 p-3 text-xs">
          <div className="mb-0.5 font-medium">Kickoff message (posted as you)</div>
          <p className="whitespace-pre-line text-muted">{squad.kickoff}</p>
        </div>

        <div>
          <div className="mb-1.5 label-mono">Model for every Bot</div>
          <ModelPicker value={modelRef} allowDefault defaultLabel={defaultLabel(effectiveDefault)} onChange={setModelRef} />
        </div>

        <Check value={withRoutines} onChange={setWithRoutines} label="Create their routines" hint={routineCount ? `${routineCount} in total` : undefined} />

        {error && <div className="text-xs text-danger">{error}</div>}

        <div className="flex items-center justify-between gap-2">
          <BackButton onClick={onBack} />
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-app px-3 py-1.5 text-[14.5px] text-muted hover:bg-sunken">
              Cancel
            </button>
            <button onClick={() => void submit()} disabled={busy} className="rounded-app bg-accent px-4 py-1.5 text-[14.5px] font-medium text-accent-fg disabled:opacity-40">
              {busy ? "Creating…" : `Create ${squad.botTemplateIds.length} Bots`}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ---------- bits ----------

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1 rounded-app px-2 py-1.5 text-[14.5px] text-muted hover:bg-sunken hover:text-fg">
      <ArrowLeft size={14} /> Templates
    </button>
  );
}

function Check({ value, onChange, label, hint, disabled }: { value: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`flex cursor-pointer items-start gap-2.5 ${disabled ? "opacity-50" : ""}`}>
      <input type="checkbox" checked={value && !disabled} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
      <span>
        <span className="block text-[14.5px]">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}
