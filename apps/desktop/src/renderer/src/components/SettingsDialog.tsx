import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, KeyRound, MessageCircleQuestion, Plus, RefreshCw, Smartphone, Terminal, X } from "lucide-react";
import type { ProfileCategory, ProfileFact, ProviderInfo } from "@grokbot/shared";
import { PROFILE_CATEGORIES, PROFILE_CATEGORY_LABELS, SCREEN_SIZE } from "@grokbot/shared";
import { api } from "../lib/api";
import { askText } from "../lib/ask";
import { prettyModel, useDefaultModel } from "../lib/defaultModel";
import { useStore } from "../lib/store";
import { relativeTime } from "../lib/time";
import { CustomRules } from "./CustomRules";
import { Dialog } from "./Dialog";
import { ModelPicker } from "./ModelPicker";
import { PluginsPane } from "./PluginsPane";
import { SkillsPane } from "./SkillsPane";
import { VaultPane } from "./VaultPane";

type Pane = "general" | "about" | "spaces" | "models" | "skills" | "plugins" | "computer" | "vault" | "phone" | "usage" | "updates";
const PANES: { id: Pane; label: string }[] = [
  { id: "general", label: "General" },
  { id: "about", label: "About you" },
  { id: "spaces", label: "Spaces" },
  { id: "models", label: "Models" },
  { id: "skills", label: "Skills" },
  { id: "plugins", label: "Plugins" },
  { id: "computer", label: "Computer" },
  { id: "vault", label: "Vault" },
  { id: "phone", label: "Phone" },
  { id: "usage", label: "Usage & Billing" },
  { id: "updates", label: "Updates" },
];

export function SettingsDialog() {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const initialPane = useStore((s) => s.settingsPane);
  const [pane, setPane] = useState<Pane>(PANES.some((p) => p.id === initialPane) ? (initialPane as Pane) : "models");
  return (
    <Dialog title="Settings" onClose={() => setSettingsOpen(false)} width={820} padding={false}>
      <div className="flex h-full flex-col md:h-[560px] md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 md:block md:w-[170px] md:space-y-0.5 md:border-b-0 md:border-r">
          {PANES.map((p) => (
            <button
              key={p.id}
              onClick={() => setPane(p.id)}
              className={`block shrink-0 whitespace-nowrap rounded-app px-2.5 py-1.5 text-left text-[14.5px] md:w-full ${pane === p.id ? "bg-sunken font-medium" : "text-muted hover:bg-sunken/60"}`}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {pane === "general" && <GeneralPane />}
          {pane === "about" && <AboutYouPane />}
          {pane === "spaces" && <SpacesPane />}
          {pane === "models" && <ModelsPane />}
          {pane === "skills" && <SkillsPane />}
          {pane === "plugins" && <PluginsPane />}
          {pane === "computer" && <ComputerPane />}
          {pane === "vault" && <VaultPane />}
          {pane === "phone" && <PhonePane />}
          {pane === "usage" && <Placeholder title="Usage & Billing" text="Per-provider token usage and spend caps are not built yet. Your subscriptions and API keys are billed by each provider as usual." />}
          {pane === "updates" && <Placeholder title="Updates" text="Automatic updates are not built yet. To update, rebuild with npm run dist and reinstall Cadre." />}
        </div>
      </div>
    </Dialog>
  );
}

const ZOOM_PRESETS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

function ZoomControl() {
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    void window.cadre?.getZoom?.().then((z) => setZoom(z));
    const on = (e: WindowEventMap["cadre:zoom"]) => setZoom(e.detail);
    window.addEventListener("cadre:zoom", on);
    return () => window.removeEventListener("cadre:zoom", on);
  }, []);
  if (!window.cadre?.setZoom) return <span className="font-mono text-[13.5px] text-muted">browser</span>;
  const set = (z: number) => {
    setZoom(z);
    window.cadre?.setZoom?.(z);
  };
  return (
    <div className="flex items-center gap-1">
      {ZOOM_PRESETS.map((z) => (
        <button
          key={z}
          onClick={() => set(z)}
          className={`rounded-md px-2 py-1 font-mono text-[13px] ${Math.abs(zoom - z) < 0.01 ? "bg-accent text-accent-fg" : "bg-sunken text-muted hover:text-fg"}`}
        >
          {Math.round(z * 100)}%
        </button>
      ))}
    </div>
  );
}

function GeneralPane() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="space-y-6">
      <Group title="Appearance">
        <Row label="Theme">
          <Segmented
            value={settings.appearance}
            options={[
              { v: "system", l: "Follow System" },
              { v: "light", l: "Light · Day" },
              { v: "dark", l: "Dark · Night" },
            ]}
            onChange={(v) => void updateSettings({ appearance: v })}
          />
        </Row>
        <Row label="Zoom" hint={window.cadre?.setZoom ? "Also ⌘= / ⌘- / ⌘0, or pinch on the trackpad." : "Use your browser's zoom, or pinch on a phone."}>
          <ZoomControl />
        </Row>
      </Group>
      <Group title="Bot">
        <Row label="Timezone" hint={`Auto-detect uses ${tz}`}>
          <input
            value={settings.timezone ?? ""}
            placeholder="Auto-detect"
            onChange={(e) => void updateSettings({ timezone: e.target.value || null })}
            className="w-56 rounded-app border border-line bg-sunken px-2 py-1 text-[14px] outline-none"
          />
        </Row>
        <Row label="Auto mode" hint="Bots act without asking. Actions that can't be undone (rm -rf, git push, sudo…) still ask. Also the Auto button at the top of every chat.">
          <Toggle value={!settings.autoReview} onChange={(v) => void useStore.getState().setAutoMode(v)} />
        </Row>
        <Row
          label="Run sandbox commands without asking"
          hint="Commands run right away while macOS blocks them from changing anything outside the Cadre folder. Deploys, cloud changes, publishing and changes outside the folder still ask."
        >
          <Toggle value={settings.sandboxAutoRun} onChange={(v) => void updateSettings({ sandboxAutoRun: v })} />
        </Row>
        <Row label="Review model" hint="A cheap model that judges actions the rules don't settle.">
          <div className="w-72">
            <ModelPicker
              value={settings.utilityModelRef}
              allowDefault
              defaultLabel="Rules only (no model)"
              onChange={(ref) => void updateSettings({ utilityModelRef: ref })}
            />
          </div>
        </Row>
        <div className="py-2.5">
          <div className="text-[14.5px]">Custom Rules</div>
          <div className="mb-2 text-xs text-muted">Actions to allow without asking, or to always ask about first. Matched before the review model runs.</div>
          <CustomRules />
        </div>
      </Group>
    </div>
  );
}

function ComputerPane() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const bots = useStore((s) => s.bots);
  const [resetting, setResetting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const resetAll = async () => {
    if (!bots.length || resetting) return;
    if (!window.confirm(`Reset every Bot's screen (${bots.length})? Open pages and browser sessions are discarded.`)) return;
    setResetting(true);
    setNote(null);
    const results = await Promise.allSettled(bots.map((b) => api.computer.reset(b.id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    setNote(failed ? `${failed} of ${bots.length} screens could not be reset.` : `Reset ${bots.length} screen${bots.length === 1 ? "" : "s"}.`);
    setResetting(false);
  };

  return (
    <div className="space-y-6">
      <Group title="Bot's computer" hint="Each Bot has its own browser, files and terminal in a sandbox on this computer.">
        <Row label="Reset all screens" hint={`Screens: ${bots.length} (one per Bot, ${SCREEN_SIZE.width}×${SCREEN_SIZE.height})`}>
          <div className="flex items-center gap-2">
            {note && <span className="text-xs text-muted">{note}</span>}
            <button
              onClick={() => void resetAll()}
              disabled={resetting || !bots.length}
              className="rounded-app border border-line px-2.5 py-1 text-xs hover:bg-sunken disabled:opacity-50"
            >
              {resetting ? "Resetting…" : "Reset all screens"}
            </button>
          </div>
        </Row>
        <Row label="Headed browser (show Chromium window)" hint="Debugging aid: show the Bot's browser on your desktop instead of headless.">
          <Toggle value={settings.headedBrowser} onChange={(v) => void updateSettings({ headedBrowser: v })} />
        </Row>
      </Group>
      <Group title="Your computer" hint="What a Bot may do on this computer outside its sandbox.">
        <Row label="Execution on this computer">
          <Segmented
            value={settings.localExecution}
            options={[
              { v: "ask", l: "Ask every time" },
              { v: "always", l: "Always allow" },
              { v: "never", l: "Never allow" },
            ]}
            onChange={(v) => void updateSettings({ localExecution: v })}
          />
        </Row>
      </Group>
    </div>
  );
}

function PhonePane() {
  const access = useStore((s) => s.access);
  const accessError = useStore((s) => s.accessError);
  const loadAccess = useStore((s) => s.loadAccess);
  const rotateAccess = useStore((s) => s.rotateAccess);
  const [loading, setLoading] = useState(!access);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    void loadAccess().finally(() => setLoading(false));
  }, [loadAccess]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    if (!access) return;
    try {
      // The Mac app copies through Electron (always allowed); browsers use the Clipboard API.
      if (window.cadre?.copyText) window.cadre.copyText(access.url);
      else await navigator.clipboard.writeText(access.url);
      setCopied(true);
    } catch {
      /* clipboard blocked: the URL is selectable in the box */
    }
  };

  const rotate = async () => {
    setRotating(true);
    setRotateError(null);
    try {
      await rotateAccess();
      setConfirming(false);
    } catch (err) {
      setRotateError((err as Error).message);
    } finally {
      setRotating(false);
    }
  };

  const unavailable = !access && !loading;

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sunken text-muted">
            <Smartphone size={14} />
          </div>
          <div>
            <div className="text-[14.5px] font-semibold">Use Cadre from your phone</div>
            <div className="text-xs text-muted">Same Wi‑Fi. Scan to open the app in your phone's browser; the link signs that phone in.</div>
          </div>
        </div>
      </section>

      {loading && <div className="text-xs text-muted">Preparing the link…</div>}

      {unavailable && (
        <div className="rounded-app border border-line bg-sunken/60 px-3 py-2.5 text-xs">
          <div className="font-medium">Only available on the Mac running Cadre</div>
          <div className="mt-0.5 text-muted">Open Settings → Phone in the desktop app to get the QR code.
            {accessError && !/only available/i.test(accessError) ? ` (${accessError})` : ""}</div>
          <button onClick={() => void loadAccess()} className="mt-2 rounded-app border border-line px-2.5 py-1 text-xs hover:bg-sunken">
            Try again
          </button>
        </div>
      )}

      {access && (
        <>
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
            <div
              className="flex h-[220px] w-[220px] shrink-0 items-center justify-center self-center rounded-xl bg-white p-3 shadow-sm [&_svg]:h-full [&_svg]:w-full sm:self-start"
              dangerouslySetInnerHTML={{ __html: access.qrSvg }}
            />
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <div className="mb-1 label-mono">Link</div>
                <div className="flex items-stretch gap-1.5">
                  <div className="min-w-0 flex-1 select-all break-all rounded-app border border-line bg-sunken px-2.5 py-1.5 font-mono text-[13.5px]">
                    {access.url}
                  </div>
                  <button
                    onClick={() => void copy()}
                    className="flex shrink-0 items-center gap-1 rounded-app border border-line px-2.5 text-xs hover:bg-sunken"
                    title="Copy link"
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
              {access.urls.length > 1 && (
                <div>
                  <div className="mb-1 label-mono">Other addresses</div>
                  <div className="flex flex-col gap-0.5">
                    {access.urls
                      .filter((u) => u !== access.url)
                      .map((u) => (
                        <a key={u} href={u} onClick={(e) => e.preventDefault()} className="select-all truncate font-mono text-[13px] text-muted hover:text-fg" title={u}>
                          {u}
                        </a>
                      ))}
                  </div>
                  <div className="mt-1 text-[12.5px] text-muted">If the first one does not open, your phone may be on a different interface; try these.</div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>Port {access.port}</span>
                <span>·</span>
                <span title={access.rotatedAt}>Rotated {relativeTime(access.rotatedAt) ?? "—"}</span>
              </div>
            </div>
          </div>

          <Group title="Regenerate link" hint="Makes a new link and QR code. Every phone that used the old one is signed out.">
            {!confirming ? (
              <button onClick={() => setConfirming(true)} className="rounded-app border border-line px-2.5 py-1 text-xs hover:bg-sunken">
                Regenerate link
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-app border border-signal/40 bg-signal/10 px-3 py-2 text-xs">
                <span className="font-medium">This signs out every phone.</span>
                <button onClick={() => void rotate()} disabled={rotating} className="rounded-app bg-accent px-2.5 py-1 font-medium text-accent-fg disabled:opacity-50">
                  {rotating ? "Regenerating…" : "Regenerate"}
                </button>
                <button onClick={() => setConfirming(false)} className="text-muted hover:text-fg">
                  Cancel
                </button>
              </div>
            )}
            {rotateError && <div className="mt-2 text-xs text-danger">{rotateError}</div>}
          </Group>
        </>
      )}
    </div>
  );
}

/** Work, Personal, …: each space has its own Bots, lead Bot and default model. */
/** The Chief asks one question at a time and saves the answers with remember_about_user. */
const INTERVIEW_PROMPT =
  "Interview me so you and the team get to know me. Ask one short question at a time, starting easy, and cover: who I am, what I like and dislike, my weekly routines, the important people in my life, and how I like things done. After each answer, save what you learned with remember_about_user (scope this-space for things that only matter in this space). Stop when I say stop, then list what you saved.";

const MAX_PROFILE_FACTS = 120;

function AboutYouPane() {
  const profile = useStore((s) => s.profile);
  const loadProfile = useStore((s) => s.loadProfile);
  const spaces = useStore((s) => s.spaces);
  const spaceId = useStore((s) => s.spaceId);
  const bots = useStore((s) => s.bots);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const selectBot = useStore((s) => s.selectBot);
  const send = useStore((s) => s.send);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const [draft, setDraft] = useState("");
  const [category, setCategory] = useState<ProfileCategory>("about");
  const [scope, setScope] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);
  const run = (p: Promise<unknown>) => {
    setError(null);
    p.then(() => loadProfile()).catch((err: Error) => setError(err.message));
  };
  const chief = bots.find((b) => b.isPrimary && b.spaceId === spaceId);
  const spaceName = (id: string | null) => (id ? (spaces.find((x) => x.id === id)?.name ?? "Removed space") : "Everywhere");
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    run(api.profile.add({ text, category, spaceId: scope || null }));
  };

  return (
    <div className="space-y-6">
      <Group
        title="About you"
        hint="What your Bots know about you, so they can work the way you like. They learn from your chats; you can change anything here. Facts you write or edit are never changed by the Bots."
      >
        <div className="rounded-app border border-line bg-elev px-3">
          <Row label="Learn about me from chats" hint={settings.learnAboutMe ? "After a chat, Bots note anything new about you" : "Paused: only what you add here or ask a Bot to remember"}>
            <Toggle value={settings.learnAboutMe} onChange={(v) => void updateSettings({ learnAboutMe: v })} />
          </Row>
          <Row label="Get interviewed" hint={chief ? `${chief.name} asks you a few questions and saves your answers` : "Add a Chief of Staff to this space first"}>
            <button
              disabled={!chief}
              onClick={async () => {
                if (!chief) return;
                setSettingsOpen(false);
                await selectBot(chief.id);
                await send(INTERVIEW_PROMPT);
              }}
              className="flex items-center gap-1.5 rounded-app border border-line px-2.5 py-1 text-xs hover:bg-sunken disabled:opacity-40"
            >
              <MessageCircleQuestion size={13} /> Start
            </button>
          </Row>
        </div>
      </Group>

      <Group title="Tell your Bots something" hint="One fact at a time, e.g. “Vegetarian, no mushrooms” or “School run 8:15 on weekdays”.">
        <div className="space-y-2 rounded-app border border-line bg-elev p-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                add();
              }
            }}
            rows={2}
            maxLength={500}
            placeholder="Something about you…"
            className="w-full resize-none rounded-app border border-line bg-sunken px-2.5 py-2 text-[14.5px] outline-none focus:border-accent/60"
          />
          <div className="flex flex-wrap items-center gap-2">
            <SmallSelect value={category} onChange={(v) => setCategory(v as ProfileCategory)} options={PROFILE_CATEGORIES.map((c) => ({ v: c, l: PROFILE_CATEGORY_LABELS[c] }))} />
            <SmallSelect value={scope} onChange={setScope} options={[{ v: "", l: "Everywhere" }, ...spaces.map((sp) => ({ v: sp.id, l: `${sp.emoji} ${sp.name} only` }))]} />
            <button onClick={add} disabled={!draft.trim()} className="ml-auto flex items-center gap-1 rounded-app bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40">
              <Plus size={12} /> Add
            </button>
          </div>
          {error && <div className="text-xs text-danger">{error}</div>}
        </div>
      </Group>

      {PROFILE_CATEGORIES.map((cat) => {
        const facts = profile.filter((f) => f.category === cat);
        return (
          <Group key={cat} title={PROFILE_CATEGORY_LABELS[cat]} hint={facts.length ? undefined : "Nothing yet."}>
            {facts.length > 0 && (
              <div className="rounded-app border border-line bg-elev">
                {facts.map((f) => (
                  <ProfileRow key={f.id + f.updatedAt} fact={f} spaces={spaces} spaceName={spaceName} onChange={run} />
                ))}
              </div>
            )}
          </Group>
        );
      })}
      <div className="font-mono text-[12px] text-muted">
        {profile.length} of {MAX_PROFILE_FACTS} facts
      </div>
    </div>
  );
}

function ProfileRow({
  fact,
  spaces,
  spaceName,
  onChange,
}: {
  fact: ProfileFact;
  spaces: { id: string; name: string; emoji: string }[];
  spaceName: (id: string | null) => string;
  onChange: (p: Promise<unknown>) => void;
}) {
  return (
    <div className="border-b border-line px-3 py-2 last:border-0">
      <div className="flex items-start gap-2">
        <textarea
          defaultValue={fact.text}
          rows={1}
          maxLength={500}
          aria-label="Fact"
          onBlur={(e) => {
            const t = e.target.value.trim();
            if (t && t !== fact.text) onChange(api.profile.update(fact.id, { text: t }));
          }}
          className="min-w-0 flex-1 resize-none bg-transparent text-[14.5px] leading-snug outline-none [field-sizing:content] focus:rounded-[6px] focus:bg-sunken"
        />
        <button onClick={() => onChange(api.profile.remove(fact.id))} title="Forget this" aria-label="Forget this" className="mt-0.5 rounded-app p-0.5 text-muted hover:bg-danger/10 hover:text-danger">
          <X size={14} />
        </button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">
        <span className={`rounded-full px-1.5 py-px ${fact.source === "you" ? "bg-accent/15 text-accent" : "bg-sunken"}`}>{fact.source === "you" ? "From you" : "Learned"}</span>
        <SmallSelect
          value={fact.spaceId ?? ""}
          onChange={(v) => onChange(api.profile.update(fact.id, { spaceId: v || null }))}
          options={[{ v: "", l: "Everywhere" }, ...spaces.map((sp) => ({ v: sp.id, l: `${sp.emoji} ${sp.name} only` })), ...(fact.spaceId && !spaces.some((sp) => sp.id === fact.spaceId) ? [{ v: fact.spaceId, l: spaceName(fact.spaceId) }] : [])]}
        />
        <SmallSelect value={fact.category} onChange={(v) => onChange(api.profile.update(fact.id, { category: v as ProfileCategory }))} options={PROFILE_CATEGORIES.map((c) => ({ v: c, l: PROFILE_CATEGORY_LABELS[c] }))} />
      </div>
    </div>
  );
}

function SmallSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-[6px] border border-line bg-sunken px-1.5 py-0.5 text-[12px] text-fg outline-none">
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.l}
        </option>
      ))}
    </select>
  );
}

function SpacesPane() {
  const spaces = useStore((s) => s.spaces);
  const bots = useStore((s) => s.bots);
  const appEffective = useDefaultModel(null);
  const saveSpace = useStore((s) => s.saveSpace);
  const addSpace = useStore((s) => s.addSpace);
  const removeSpace = useStore((s) => s.removeSpace);
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => {
    setError(null);
    p.catch((err: Error) => setError(err.message));
  };
  return (
    <div className="space-y-6">
      <Group title="Spaces" hint="Split your team: each space has its own Bots, its own Chief and its own default model. Switch spaces from the left rail.">
        <div className="space-y-2">
          {spaces.map((sp) => {
            const count = bots.filter((b) => b.spaceId === sp.id).length;
            const lead = bots.find((b) => b.spaceId === sp.id && b.isPrimary);
            return (
              <div key={sp.id} className="rounded-app border border-line bg-elev p-3">
                <div className="flex items-center gap-2">
                  <input
                    defaultValue={sp.emoji}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== sp.emoji && run(saveSpace(sp.id, { emoji: e.target.value.trim() }))}
                    maxLength={8}
                    aria-label="Emoji"
                    className="w-11 rounded-app border border-line bg-sunken px-1 py-1 text-center text-[18px] outline-none"
                  />
                  <input
                    defaultValue={sp.name}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== sp.name && run(saveSpace(sp.id, { name: e.target.value.trim() }))}
                    aria-label="Space name"
                    className="min-w-0 flex-1 rounded-app border border-line bg-sunken px-2 py-1 text-[14.5px] outline-none"
                  />
                  <button
                    onClick={() => run(removeSpace(sp.id))}
                    disabled={count > 0 || spaces.length <= 1}
                    title={count > 0 ? "Move or delete this space's Bots first" : spaces.length <= 1 ? "Keep at least one space" : "Delete space"}
                    className="rounded-app px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-30"
                  >
                    Delete
                  </button>
                </div>
                <div className="mt-2 font-mono text-[12px] text-muted">
                  {count} Bot{count === 1 ? "" : "s"} · {lead ? `led by ${lead.name}` : "no Chief yet"}
                </div>
                <div className="mt-2">
                  <div className="mb-1 text-xs text-muted">Default model for this space</div>
                  <ModelPicker
                    value={sp.defaultModelRef}
                    allowDefault
                    defaultLabel={appEffective ? `App default: ${prettyModel(appEffective.modelRef)}` : "App default"}
                    onChange={(ref) => run(saveSpace(sp.id, { defaultModelRef: ref }))}
                  />
                </div>
              </div>
            );
          })}
          <button
            onClick={async () => {
              const name = await askText({ title: "New space", placeholder: "e.g. Side project", confirmLabel: "Create" });
              if (name) run(addSpace(name, "✨"));
            }}
            className="flex items-center gap-1.5 rounded-app border border-dashed border-line px-3 py-2 text-xs text-muted hover:text-fg"
          >
            <Plus size={12} /> Add a space
          </button>
          {error && <div className="text-xs text-danger">{error}</div>}
        </div>
      </Group>
      <HiringLimits />
    </div>
  );
}

/** Your limits on Chiefs hiring Bots by themselves. 0 = no limit (the default). */
function HiringLimits() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const field = (label: string, hint: string, key: "hireLimitPerDay" | "teamSizeLimit") => (
    <Row label={label} hint={hint}>
      <input
        type="number"
        min={0}
        defaultValue={settings[key]}
        key={settings[key]}
        onBlur={(e) => {
          const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
          if (n !== settings[key]) void updateSettings({ [key]: n });
        }}
        className="w-20 rounded-app border border-line bg-sunken px-2 py-1 text-right font-mono text-[13.5px] outline-none"
      />
    </Row>
  );
  return (
    <Group title="Hiring" hint="Limits on Chiefs hiring Bots on their own. 0 means no limit. You can always create Bots yourself.">
      <div className="rounded-app border border-line bg-elev px-3">
        {field("Hires per Chief per day", settings.hireLimitPerDay ? `At most ${settings.hireLimitPerDay} in 24 hours` : "No limit", "hireLimitPerDay")}
        {field("Bots in total", settings.teamSizeLimit ? `Chiefs stop hiring at ${settings.teamSizeLimit}` : "No limit", "teamSizeLimit")}
      </div>
    </Group>
  );
}

function ModelsPane() {
  const appEffective = useDefaultModel(null);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = () => {
    setLoading(true);
    void api.providers.list().then(setProviders).finally(() => setLoading(false));
  };
  useEffect(refresh, []);

  return (
    <div className="space-y-6">
      <Group title="Default model" hint="Used by every Bot with no model of its own, unless its space has a default (Settings → Spaces).">
        <ModelPicker
          value={settings.defaultModelRef}
          allowDefault
          defaultLabel={appEffective && appEffective.source === "auto" ? `Automatic (now ${prettyModel(appEffective.modelRef)})` : "Automatic"}
          onChange={(ref) => void updateSettings({ defaultModelRef: ref })}
        />
        <div className="mt-1.5 text-xs text-muted">
          {settings.defaultModelRef
            ? `Default: ${prettyModel(settings.defaultModelRef)}.`
            : `No default set, so Cadre picks the first provider that is on: ${appEffective ? prettyModel(appEffective.modelRef) : "…"}. Pick a model above, or click Make default on a provider below.`}
        </div>
      </Group>
      <Group
        title="Providers"
        hint="Bring whatever you already pay for: an API key, or a subscription through its official CLI."
        action={
          <button onClick={refresh} className="flex items-center gap-1 text-xs text-muted hover:text-fg">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        }
      >
        <div className="space-y-2">
          {providers.map((p) => (
            <ProviderCard key={p.id} info={p} onChanged={refresh} />
          ))}
          {!providers.length && loading && <div className="text-xs text-muted">Checking providers…</div>}
        </div>
      </Group>
    </div>
  );
}

function ProviderCard({ info, onChanged }: { info: ProviderInfo; onChanged: () => void }) {
  const appDefault = useStore((s) => s.settings.defaultModelRef);
  const updateSettings = useStore((s) => s.updateSettings);
  const isDefault = !!appDefault && appDefault.startsWith(`${info.id}:`);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(info.baseUrl ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.providers.update(info.id, {
        apiKey: key ? key : undefined,
        baseUrl: info.id === "ollama" ? baseUrl || null : undefined,
      });
      setKey("");
      setEditing(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    await api.providers.update(info.id, { apiKey: null });
    onChanged();
  };
  const setOff = async (disabled: boolean) => {
    setBusy(true);
    try {
      await api.providers.update(info.id, { disabled });
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const off = info.status === "off";

  const statusText =
    info.status === "off"
      ? "Off"
      : info.status === "ready"
      ? "Ready"
      : info.status === "needs-key"
        ? "Needs API key"
        : info.status === "needs-signin"
          ? "Needs sign-in"
          : info.status === "not-installed"
            ? "Not installed"
            : "Error";

  return (
    <div className={`rounded-app border border-line p-3 ${off ? "bg-sunken" : "bg-elev"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className={`flex items-start gap-2.5 ${off ? "opacity-60" : ""}`}>
          <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-md bg-sunken text-muted">
            {info.kind === "cli" ? <Terminal size={14} /> : <KeyRound size={14} />}
          </div>
          <div>
            <div className="text-[14.5px] font-medium">{info.label}</div>
            <div className="text-xs text-muted">{info.blurb}</div>
            {info.statusDetail && info.status !== "ready" && (
              <div className={`mt-1 text-[13px] ${off ? "text-muted" : "text-signal"}`}>{info.statusDetail}</div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`flex items-center gap-1 text-[13px] ${info.status === "ready" ? "text-accent" : "text-muted"}`}>
            {info.status === "ready" && <Check size={12} />}
            {statusText}
          </span>
          {isDefault && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[12px] font-medium text-accent">Default</span>}
          {info.status === "ready" && !isDefault && (
            <button
              onClick={() => void updateSettings({ defaultModelRef: `${info.id}:${info.defaultModel}` })}
              className="rounded-app border border-line px-2 py-1 text-xs hover:bg-sunken"
              title={`Use ${prettyModel(`${info.id}:${info.defaultModel}`)} for every Bot without its own model`}
            >
              Make default
            </button>
          )}
          {(info.status === "ready" || off) && (
            <button
              onClick={() => void setOff(!off)}
              disabled={busy}
              className={`rounded-app border px-2 py-1 text-xs disabled:opacity-50 ${off ? "border-accent text-accent hover:bg-elev" : "border-line hover:bg-sunken"}`}
              title={off ? "Let Bots use this provider again" : "Stop Cadre using this provider. Nothing is signed out or deleted."}
            >
              {off ? "Turn on" : "Turn off"}
            </button>
          )}
          {info.kind === "api" && !editing && !off && (
            <button onClick={() => setEditing(true)} className="rounded-app border border-line px-2 py-1 text-xs hover:bg-sunken">
              {info.hasKey ? "Change key" : info.id === "ollama" ? "Configure" : "Add key"}
            </button>
          )}
          {info.kind === "cli" && info.status === "needs-signin" && (
            <span className="text-[12.5px] text-muted">Sign in from a terminal</span>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-3 flex items-center gap-2">
          {info.id === "ollama" ? (
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:11434"
              className="flex-1 rounded-app border border-line bg-sunken px-2 py-1.5 font-mono text-[13.5px] outline-none"
            />
          ) : (
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Paste API key (stored encrypted on this computer)"
              autoFocus
              className="flex-1 rounded-app border border-line bg-sunken px-2 py-1.5 font-mono text-[13.5px] outline-none"
            />
          )}
          <button onClick={() => void save()} disabled={busy || (info.id !== "ollama" && !key)} className="rounded-app bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40">
            Save securely
          </button>
          {info.hasKey && (
            <button onClick={() => void clear()} className="text-xs text-danger">Remove</button>
          )}
          <button onClick={() => setEditing(false)} className="text-xs text-muted">Cancel</button>
        </div>
      )}
      {info.kind === "cli" && info.status === "ready" && (
        <div className="mt-2 flex items-center gap-1 text-[12.5px] text-muted">
          <ExternalLink size={11} /> Turns run through the {info.label.replace(" (subscription)", "")} CLI on this computer.
        </div>
      )}
    </div>
  );
}

function Group({ title, hint, children, action }: { title: string; hint?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-end justify-between">
        <div>
          <div className="text-[14.5px] font-semibold">{title}</div>
          {hint && <div className="text-xs text-muted">{hint}</div>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line py-2.5 last:border-0">
      <div>
        <div className="text-[14.5px]">{label}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-app border border-line bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`rounded-[7px] px-2.5 py-1 text-xs ${value === o.v ? "bg-elev font-medium shadow-sm" : "text-muted"}`}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative h-5 w-9 rounded-full transition-colors ${value ? "bg-accent" : "bg-line"}`}
      role="switch"
      aria-checked={value}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${value ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

function Placeholder({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <div className="text-[14.5px] font-semibold">{title}</div>
      <div className="mt-1 text-xs text-muted">{text}</div>
    </div>
  );
}
