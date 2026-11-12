import { useCallback, useEffect, useState } from "react";
import { ChevronRight, FolderOpen, GitBranch, Plug, RefreshCw, Trash2 } from "lucide-react";
import type { InstalledPlugin, PluginContents, PluginPreview, PluginSuggestion } from "@grokbot/shared";
import { api } from "../lib/api";
import { useStore } from "../lib/store";

const FORMAT_LABEL: Record<string, string> = {
  "claude-plugin": "Claude Code plugin",
  "claude-marketplace": "Claude Code marketplace",
  "codex-plugin": "Codex plugin",
  "codex-home": "Codex",
  "gemini-extension": "Gemini CLI extension",
  opencode: "OpenCode",
  "skills-folder": "Skills folder",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function counts(p: PluginContents): string {
  const skills = p.skills.filter((s) => s.kind !== "command").length;
  const commands = p.skills.length - skills;
  return [
    skills && plural(skills, "skill"),
    commands && plural(commands, "command"),
    p.agents.length && plural(p.agents.length, "agent"),
    p.servers.length && plural(p.servers.length, "app"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Settings → Plugins: skills, apps and agents from any agent harness, or your own skills folders. */
export function PluginsPane() {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [suggestions, setSuggestions] = useState<PluginSuggestion[]>([]);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [list, found] = await Promise.all([api.plugins.list(), api.plugins.suggestions().catch(() => [])]);
    setPlugins(list);
    setSuggestions(found);
  }, []);

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
  }, [load]);

  const look = async (from = source) => {
    const s = from.trim();
    if (!s || busy) return;
    setSource(s);
    setBusy("preview");
    setError(null);
    setPreview(null);
    try {
      setPreview(await api.plugins.preview(s));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pick = async () => {
    const folder = await window.cadre?.pickFolder?.("Choose a plugin or skills folder");
    if (folder) void look(folder);
  };

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <div className="text-[14.5px] font-semibold">Plugins</div>
        <div className="text-xs text-muted">
          Add skills, apps and agents from Claude Code, Codex, Gemini CLI, OpenCode, or any folder of SKILL.md files. Every Bot can use the skills, apps join Connect apps, and agents become Bots you can hire.
        </div>

        <div className="mt-3 flex gap-1.5">
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void look();
            }}
            placeholder="Folder path (~/my-skills) or git URL (github.com/you/plugin)"
            spellCheck={false}
            className={`${inputClass} font-mono text-[13px]`}
          />
          {window.cadre?.pickFolder && (
            <button onClick={() => void pick()} className="flex shrink-0 items-center gap-1 rounded-app border border-line px-2.5 py-1 text-xs hover:bg-sunken" title="Choose a folder">
              <FolderOpen size={13} /> Choose…
            </button>
          )}
          <button
            onClick={() => void look()}
            disabled={!source.trim() || !!busy}
            className="shrink-0 rounded-app bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40"
          >
            {busy === "preview" ? "Looking…" : "Look inside"}
          </button>
        </div>
        {error && <div className="mt-2 text-xs text-danger">{error}</div>}

        {preview && (
          <PreviewCard
            preview={preview}
            onCancel={() => setPreview(null)}
            onInstalled={async () => {
              setPreview(null);
              setSource("");
              await load();
            }}
            onError={setError}
          />
        )}
      </section>

      <section>
        <div className="mb-2 text-[13.5px] font-semibold">Installed</div>
        {plugins.length === 0 ? (
          <div className="rounded-app border border-dashed border-line px-3 py-4 text-center text-xs text-muted">Nothing installed yet. Pick a folder above, or add one found on this computer.</div>
        ) : (
          <div className="divide-y divide-line rounded-app border border-line bg-elev">
            {plugins.map((p) => (
              <InstalledRow key={p.id} plugin={p} busy={busy} act={act} />
            ))}
          </div>
        )}
      </section>

      {suggestions.some((s) => !s.installedId) && (
        <section>
          <div className="mb-2 text-[13.5px] font-semibold">Found on this computer</div>
          <div className="divide-y divide-line rounded-app border border-line bg-elev">
            {suggestions
              .filter((s) => !s.installedId)
              .map((s) => (
                <div key={s.path} className="flex items-center gap-2 px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium">{s.label}</div>
                    <div className="truncate font-mono text-[12px] text-muted" title={s.path}>
                      {s.harness} · {s.path}
                    </div>
                  </div>
                  <button onClick={() => void look(s.path)} disabled={!!busy} className="shrink-0 rounded-app border border-line px-2.5 py-1 text-xs hover:bg-sunken disabled:opacity-40">
                    Look inside
                  </button>
                </div>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}

function PreviewCard({ preview, onCancel, onInstalled, onError }: { preview: PluginPreview; onCancel: () => void; onInstalled: () => Promise<void>; onError: (e: string | null) => void }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(preview.servers.filter((s) => !s.off && !s.connectorId).map((s) => s.key)));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const needs = [...new Set(preview.servers.filter((s) => picked.has(s.key)).flatMap((s) => s.needs))];

  const install = async () => {
    setBusy(true);
    onError(null);
    try {
      await api.plugins.install({ source: preview.url ?? preview.path, secrets, servers: [...picked] });
      await onInstalled();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-3 rounded-app border border-line bg-elev p-3">
      <div>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[15px] font-semibold">{preview.name}</span>
          {preview.version && <span className="text-[12px] text-muted">v{preview.version}</span>}
          {preview.formats.map((f) => (
            <span key={f} className="rounded bg-sunken px-1 text-[11.5px] text-muted">
              {FORMAT_LABEL[f] ?? f}
            </span>
          ))}
        </div>
        {preview.description && <div className="text-xs text-muted">{preview.description}</div>}
        <div className="mt-0.5 font-mono text-[12px] text-muted">{preview.path}</div>
      </div>

      <ContentsList contents={preview} />

      {preview.servers.length > 0 && (
        <div>
          <div className="mb-1 label-mono">Apps to add to Connect apps</div>
          <div className="space-y-1">
            {preview.servers.map((s) => (
              <label key={s.key} className="flex items-start gap-2 rounded-app px-1 py-0.5 text-[13.5px]">
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={!!s.connectorId}
                  checked={picked.has(s.key)}
                  onChange={(e) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(s.key);
                      else next.delete(s.key);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{s.key}</span>{" "}
                  <span className="break-all font-mono text-[12px] text-muted">{s.url ?? s.command}</span>
                  {s.connectorId && <span className="block text-[12px] text-muted">Already in Connect apps as {s.connectorName}; Bots share it.</span>}
                  {s.off && !s.connectorId && <span className="block text-[12px] text-muted">Turned off in the plugin's own settings.</span>}
                  {s.notes.map((n) => (
                    <span key={n} className="block text-[12px] text-muted">
                      {n}
                    </span>
                  ))}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {needs.length > 0 && (
        <div>
          <div className="mb-1 label-mono">Keys and tokens for these apps</div>
          <div className="mb-1.5 text-xs text-muted">Stored encrypted on this computer. Leave one blank to use the value from your environment, or to sign in through the app instead.</div>
          <div className="space-y-1">
            {needs.map((n) => (
              <label key={n} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-2">
                <span className="truncate font-mono text-[12.5px]" title={n}>
                  {n}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  value={secrets[n] ?? ""}
                  onChange={(e) => setSecrets((prev) => ({ ...prev, [n]: e.target.value }))}
                  className={`${inputClass} font-mono text-[13px]`}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      {preview.skipped.length > 0 && (
        <div className="space-y-0.5 text-[12.5px] text-muted">
          {preview.skipped.map((s) => (
            <div key={s}>Not added: {s}</div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-end gap-1.5">
        {preview.installedId && <span className="mr-auto text-xs text-muted">Already installed.</span>}
        <button onClick={onCancel} className="rounded-app px-2.5 py-1 text-xs text-muted hover:bg-sunken">
          Cancel
        </button>
        <button onClick={() => void install()} disabled={busy || !!preview.installedId} className="rounded-app bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40">
          {busy ? "Installing…" : "Install"}
        </button>
      </div>
    </div>
  );
}

function ContentsList({ contents, onHire }: { contents: PluginContents; onHire?: (templateId: string) => void }) {
  const [all, setAll] = useState(false);
  const skills = all ? contents.skills : contents.skills.slice(0, 8);
  return (
    <div className="space-y-2">
      {contents.skills.length > 0 && (
        <div>
          <div className="mb-1 label-mono">Skills every Bot can use</div>
          <div className="space-y-0.5">
            {skills.map((s) => (
              <div key={s.path + s.name} className="truncate text-[13px]" title={s.description}>
                <span className="font-mono">/{s.name}</span>
                {s.kind !== "skill" && <span className="ml-1 rounded bg-sunken px-1 text-[11px] text-muted">{s.kind}</span>}
                <span className="ml-1.5 text-muted">{s.description}</span>
              </div>
            ))}
          </div>
          {contents.skills.length > 8 && (
            <button onClick={() => setAll(!all)} className="mt-0.5 text-[12.5px] text-muted hover:text-fg">
              {all ? "Show fewer" : `Show all ${contents.skills.length}`}
            </button>
          )}
        </div>
      )}
      {contents.agents.length > 0 && (
        <div>
          <div className="mb-1 label-mono">Agents you can hire as Bots</div>
          <div className="space-y-0.5">
            {contents.agents.map((a) => (
              <div key={a.name} className="flex items-center gap-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate" title={a.description}>
                  <span className="font-medium">{a.name}</span>
                  <span className="ml-1.5 text-muted">{a.description}</span>
                </span>
                {onHire && a.templateId && (
                  <button onClick={() => onHire(a.templateId)} className="shrink-0 rounded-app border border-line px-2 py-0.5 text-[12px] hover:bg-sunken">
                    Hire
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InstalledRow({ plugin: p, busy, act }: { plugin: InstalledPlugin; busy: string | null; act: (key: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setCreateOpen = useStore((s) => s.setCreateOpen);
  const ownedApps = p.servers.filter((s) => s.connectorId).length;

  const remove = () => {
    const apps = p.servers.filter((s) => s.connectorId).length;
    if (!window.confirm(`Remove ${p.name}? Its skills and agents leave Cadre${apps ? `, and the apps it added are removed from Connect apps` : ""}.${p.sourceKind === "folder" ? " Your folder isn't touched." : ""}`)) return;
    void act(`remove:${p.id}`, () => api.plugins.remove(p.id));
  };

  return (
    <div>
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-start gap-1.5 text-left">
          <ChevronRight size={12} className={`mt-1 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className={`truncate text-[14px] font-medium ${p.enabled ? "" : "text-muted line-through"}`}>{p.name}</span>
              {p.version && <span className="shrink-0 text-[12px] text-muted">v{p.version}</span>}
              <span className="flex shrink-0 items-center gap-0.5 rounded bg-sunken px-1 text-[11.5px] text-muted" title={p.sourceKind === "git" ? (p.url ?? "") : "Read live from your folder"}>
                {p.sourceKind === "git" ? <GitBranch size={10} /> : <FolderOpen size={10} />}
                {p.sourceKind === "git" ? "git" : "folder"}
              </span>
            </div>
            <div className={`truncate text-xs ${p.error ? "text-danger" : "text-muted"}`}>{p.error ?? (counts(p) || "Nothing found in it right now")}</div>
          </div>
        </button>
        <label className="flex shrink-0 items-center gap-1 text-[12.5px] text-muted" title={p.enabled ? "On: Bots use it" : "Off: hidden from Bots"}>
          <input type="checkbox" checked={p.enabled} onChange={(e) => void act(`toggle:${p.id}`, () => api.plugins.setEnabled(p.id, e.target.checked))} />
          On
        </label>
        <button
          onClick={() => void act(`refresh:${p.id}`, () => (p.sourceKind === "git" ? api.plugins.update(p.id) : api.plugins.refresh(p.id)))}
          disabled={!!busy}
          className="shrink-0 rounded-md p-1 text-muted hover:bg-sunken hover:text-fg disabled:opacity-40"
          title={p.sourceKind === "git" ? "Update: download the latest version" : "Refresh: read the folder again"}
        >
          <RefreshCw size={13} className={busy === `refresh:${p.id}` ? "animate-spin" : ""} />
        </button>
        <button onClick={remove} disabled={!!busy} className="shrink-0 rounded-md p-1 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40" title="Remove plugin">
          <Trash2 size={13} />
        </button>
      </div>
      {open && (
        <div className="space-y-2 border-t border-line bg-sunken/40 px-3 py-2">
          <div className="break-all font-mono text-[12px] text-muted">{p.url ?? p.path}</div>
          <ContentsList
            contents={p}
            onHire={
              p.enabled
                ? (templateId) => {
                    setSettingsOpen(false);
                    setCreateOpen(true, templateId);
                  }
                : undefined
            }
          />
          {p.servers.length > 0 && (
            <div>
              <div className="mb-1 label-mono">Apps</div>
              {p.servers.map((s) => (
                <div key={s.key} className="flex items-center gap-1.5 text-[13px]">
                  <Plug size={11} className="shrink-0 text-muted" />
                  <span className="font-medium">{s.key}</span>
                  <span className="truncate text-muted">{s.connectorName ? `in Connect apps as ${s.connectorName}` : "not added"}</span>
                </div>
              ))}
              {ownedApps > 0 && <div className="mt-1 text-[12px] text-muted">Sign in, change tokens or turn apps off in Connect apps.</div>}
            </div>
          )}
          {p.skipped.length > 0 && (
            <div className="space-y-0.5 text-[12.5px] text-muted">
              {p.skipped.map((s) => (
                <div key={s}>Not added: {s}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const inputClass = "block w-full min-w-0 rounded-app border border-line bg-sunken px-2 py-1 text-[13.5px] outline-none placeholder:text-muted";
