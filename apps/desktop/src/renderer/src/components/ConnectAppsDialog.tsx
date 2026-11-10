import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Copy, ExternalLink, Plug, RefreshCw, Trash2 } from "lucide-react";
import type { AppConnector, ConnectorTemplate, ConnectorTransport } from "@grokbot/shared";
import { api } from "../lib/api";
import type { CreateConnectorInput, OAuthAppInfo } from "../lib/api";
import { useStore } from "../lib/store";
import { Dialog } from "./Dialog";

type Tab = "apps" | "connected";

const STATUS: Record<AppConnector["status"], { label: string; cls: string }> = {
  connected: { label: "Connected", cls: "bg-accent/15 text-accent" },
  "needs-auth": { label: "Needs sign-in", cls: "bg-signal/15 text-signal" },
  error: { label: "Error", cls: "bg-danger/10 text-danger" },
  disabled: { label: "Off", cls: "bg-sunken text-muted" },
  unknown: { label: "Connecting", cls: "bg-sunken text-muted" },
};

const CATEGORY_ORDER: ConnectorTemplate["category"][] = ["Work", "Engineering", "Docs & files", "Sales & support", "Personal"];

/** Opens an app's sign-in page in the user's browser (Electron routes window.open to the OS browser). */
function openSignIn(url: string) {
  window.open(url, "_blank", "noopener");
}

/** Sidebar → Connect apps: one click per app; a custom server form stays under Advanced. */
export function ConnectAppsDialog() {
  const setOpen = useStore((s) => s.setConnectAppsOpen);
  const connectors = useStore((s) => s.connectors);
  const [tab, setTab] = useState<Tab>("apps");
  const [templates, setTemplates] = useState<ConnectorTemplate[]>([]);
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.connectors.templates().then(setTemplates).catch((err: Error) => setError(err.message));
    void useStore.getState().loadConnectors().catch(() => {});
  }, []);

  return (
    <Dialog title="Connect apps" onClose={() => setOpen(false)} width={860}>
      <div className="-m-5 flex h-[600px] flex-col">
        <div className="flex gap-1 border-b border-line px-4 pt-2">
          {(["apps", "connected"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setCustom(false);
              }}
              className={`-mb-px border-b-2 px-2.5 py-1.5 text-[14.5px] ${tab === t ? "border-accent font-medium" : "border-transparent text-muted hover:text-fg"}`}
            >
              {t === "apps" ? "Apps" : `Connected${connectors.length ? ` (${connectors.length})` : ""}`}
            </button>
          ))}
        </div>
        <div key={tab} className="flex-1 space-y-3 overflow-y-auto p-5">
          {error && <div className="text-xs text-danger">{error}</div>}
          {tab === "apps" &&
            (custom ? (
              <AddForm template={null} onClose={() => setCustom(false)} onAdded={() => { setCustom(false); setTab("connected"); }} />
            ) : (
              <AppsTab templates={templates} connectors={connectors} onError={setError} onCustom={() => setCustom(true)} />
            ))}
          {tab === "connected" &&
            (connectors.length === 0 ? (
              <div className="rounded-app border border-dashed border-line px-3 py-6 text-center text-xs text-muted">Nothing connected yet. Pick an app under Apps and click Connect.</div>
            ) : (
              connectors.map((c) => <ConnectorCard key={c.id} connector={c} onError={setError} />)
            ))}
        </div>
      </div>
    </Dialog>
  );
}

function AppsTab({
  templates,
  connectors,
  onError,
  onCustom,
}: {
  templates: ConnectorTemplate[];
  connectors: AppConnector[];
  onError: (e: string | null) => void;
  onCustom: () => void;
}) {
  const [q, setQ] = useState("");
  const [oauthApps, setOAuthApps] = useState<OAuthAppInfo[]>([]);
  const [setup, setSetup] = useState<{ app: string; then?: ConnectorTemplate } | null>(null);
  const refreshApps = () => void api.connectors.oauthApps().then(setOAuthApps).catch(() => {});
  useEffect(refreshApps, []);
  const scroller = useRef<HTMLDivElement>(null);
  const openSetup = (app: string, then?: ConnectorTemplate) => {
    setSetup({ app, then });
    scroller.current?.closest(".overflow-y-auto")?.scrollTo({ top: 0, behavior: "smooth" });
  };
  const shown = templates.filter((t) => !q.trim() || `${t.label} ${t.blurb}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div ref={scroller} className="space-y-4">
      {setup && (
        <OAuthAppSetup
          info={oauthApps.find((a) => a.id === setup.app) ?? null}
          onClose={() => {
            setSetup(null);
            refreshApps();
          }}
          onSaved={async () => {
            refreshApps();
            const then = setup.then;
            setSetup(null);
            if (then) {
              try {
                const updated = await api.connectors.connectTemplate(then.name);
                useStore.setState((s) => ({ connectors: [...s.connectors.filter((x) => x.id !== updated.id), updated] }));
                if (updated.authUrl) openSignIn(updated.authUrl);
              } catch (err) {
                onError((err as Error).message);
              }
            }
          }}
        />
      )}
      <div className="flex items-center gap-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps" className={`${inputClass} max-w-xs`} />
        <div className="text-xs text-muted">Click Connect, sign in on the app's page, done. Bots ask before changing anything.</div>
      </div>
      {CATEGORY_ORDER.map((cat) => {
        const list = shown.filter((t) => t.category === cat);
        if (!list.length) return null;
        return (
          <section key={cat}>
            <div className="label-mono mb-1.5">{cat}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {list.map((t) => (
                <AppCard
                  key={t.name}
                  template={t}
                  connector={connectors.find((c) => c.name === (t.connectAs ?? t.name)) ?? null}
                  standIn={t.fallback ? (connectors.find((c) => c.name === t.fallback) ?? null) : null}
                  oauthApp={t.oauthApp ? (oauthApps.find((a) => a.id === t.oauthApp) ?? null) : null}
                  onSetup={() => t.oauthApp && openSetup(t.oauthApp, t)}
                  onError={onError}
                />
              ))}
            </div>
          </section>
        );
      })}
      {templates.length === 0 && <div className="text-xs text-muted">Loading apps…</div>}
      <button onClick={onCustom} className="flex items-center gap-1.5 text-xs text-muted hover:text-fg">
        <Plug size={12} /> Advanced: add a custom app server (MCP)
      </button>
    </div>
  );
}

function AppCard({
  template: t,
  connector: c,
  standIn,
  oauthApp,
  onSetup,
  onError,
}: {
  template: ConnectorTemplate;
  connector: AppConnector | null;
  standIn: AppConnector | null;
  oauthApp: OAuthAppInfo | null;
  onSetup: () => void;
  onError: (e: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [askToken, setAskToken] = useState(false);
  const [token, setToken] = useState("");
  const onPhone = !window.cadre;

  const connect = async (withToken?: string, via?: "fallback") => {
    setBusy(true);
    onError(null);
    try {
      const updated = await api.connectors.connectTemplate(t.name, withToken, via);
      useStore.setState((s) => ({ connectors: [...s.connectors.filter((x) => x.id !== updated.id), updated] }));
      if (updated.authUrl) openSignIn(updated.authUrl);
      if (withToken) {
        setToken("");
        setAskToken(false);
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Gmail & co. may be served by their own connector or by the stand-in (Zapier).
  const useStandIn = !c && !!standIn && !!t.fallback;
  const conn = useStandIn ? standIn : c;
  const status = conn?.status;
  const viaName = t.connectAs ?? (useStandIn ? t.fallback! : null);
  const via = viaName ? viaName[0].toUpperCase() + viaName.slice(1) : null;
  const matchRe = t.match ? new RegExp(t.match, "i") : null;
  const viaTools = matchRe && conn ? conn.tools.filter((x) => matchRe.test(x.name)).length : 0;
  const needsOwnerSetup = !!t.oauthApp && !c && !(oauthApp?.configured ?? false);
  let action: React.ReactNode;
  if (needsOwnerSetup && !(useStandIn && status === "connected")) {
    action = (
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onSetup} disabled={onPhone} className="rounded-app bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40">
          Set up {oauthApp?.label ?? "sign-in"} (one time)
        </button>
        {t.fallback && (
          <button onClick={() => void connect(undefined, "fallback")} disabled={busy || onPhone} className="rounded-app border border-line px-2.5 py-1 text-xs hover:bg-sunken disabled:opacity-40">
            {busy ? "Connecting…" : `Use ${t.fallback[0].toUpperCase()}${t.fallback.slice(1)} instead`}
          </button>
        )}
      </div>
    );
  } else if (status === "connected" && via) {
    action = viaTools ? (
      <span className="flex items-center gap-1 text-xs text-accent">
        <Check size={13} /> Ready through {via} · {viaTools} tools
      </span>
    ) : (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">{via} is connected. Switch on {t.label} there:</span>
        <button onClick={() => openSignIn("https://mcp.zapier.com/")} className="rounded-app border border-line px-2.5 py-1 text-xs hover:bg-sunken">
          Open {via}
        </button>
        <button
          onClick={() => void api.connectors.test(conn!.id).then((u) => useStore.setState((s) => ({ connectors: s.connectors.map((x) => (x.id === u.id ? u : x)) })))}
          className="rounded-app px-2 py-1 text-xs text-muted hover:bg-sunken"
        >
          Check again
        </button>
      </div>
    );
  } else if (status === "connected") {
    action = (
      <span className="flex items-center gap-1 text-xs text-accent">
        <Check size={13} /> Connected · {conn!.tools.length} tools
      </span>
    );
  } else if (status === "needs-auth" && conn?.authUrl) {
    action = (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-signal">{conn.statusDetail && !conn.statusDetail.startsWith("Sign in to") ? conn.statusDetail : "Waiting for you to sign in…"}</span>
        <button onClick={() => openSignIn(conn.authUrl!)} className="rounded-app border border-line px-2.5 py-1 text-xs hover:bg-sunken">
          Open sign-in page
        </button>
      </div>
    );
  } else if (t.signIn === "token" && (askToken || (status && status !== "disabled"))) {
    action = (
      <div className="w-full space-y-1.5">
        <div className="text-xs text-muted">
          1.{" "}
          <button onClick={() => t.tokenUrl && openSignIn(t.tokenUrl)} className="text-accent hover:underline">
            Create a {t.label} token
          </button>
          {t.tokenHint ? ` (${t.tokenHint})` : ""}. 2. Paste it here.
        </div>
        <div className="flex gap-1.5">
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste token" autoComplete="off" className={`${inputClass} font-mono`} />
          <button onClick={() => void connect(token.trim())} disabled={busy || !token.trim()} className="shrink-0 rounded-app bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40">
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    );
  } else {
    action = (
      <button
        onClick={() => (t.signIn === "token" ? setAskToken(true) : void connect())}
        disabled={busy || onPhone}
        title={onPhone ? "Connect apps from Cadre on your Mac" : undefined}
        className="rounded-app bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40"
      >
        {busy ? "Connecting…" : status === "error" ? "Try again" : "Connect"}
      </button>
    );
  }

  return (
    <div className="flex flex-col rounded-app border border-line bg-elev p-3">
      <div className="flex items-start gap-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-sunken text-[18px]">{t.emoji}</div>
        <div className="min-w-0">
          <div className="truncate text-[14.5px] font-medium">{t.label}</div>
          <div className="mt-0.5 text-xs text-muted">{t.blurb}</div>
        </div>
      </div>
      {status === "error" && conn?.statusDetail && <div className="mt-2 line-clamp-2 text-xs text-danger">{conn.statusDetail}</div>}
      <div className="mt-auto pt-3">{action}</div>
      {t.oauthApp && oauthApp?.configured && !needsOwnerSetup && (
        <button onClick={onSetup} disabled={onPhone} className="mt-2 self-start text-xs text-muted hover:text-fg hover:underline disabled:opacity-40">
          Change {oauthApp.label} app (Client ID)
        </button>
      )}
    </div>
  );
}

/** One-time owner setup for a vendor that doesn't let apps register themselves (Google). */
function OAuthAppSetup({ info, onClose, onSaved }: { info: OAuthAppInfo | null; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (!info) return null;
  const copy = (text: string) => {
    if (window.cadre?.copyText) window.cadre.copyText(text);
    else void navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.connectors.saveOAuthApp(info.id, clientId.trim(), secret.trim());
      setClientId("");
      setSecret("");
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-app border border-accent/40 bg-elev p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold">Set up {info.label} sign-in (one time)</div>
          <div className="mt-0.5 text-xs text-muted">
            {info.label} only lets registered apps connect, so you register Cadre once in your own {info.label} account. It takes about 20 minutes. After that, every {info.label} app here is one click. Your ID and secret stay encrypted on this Mac.
          </div>
        </div>
        <button onClick={onClose} className="shrink-0 text-xs text-muted hover:text-fg">
          Close
        </button>
      </div>
      {info.configured && (
        <div className="mt-3 flex items-center gap-2 rounded-app bg-accent/10 px-2.5 py-1.5 text-xs text-accent">
          <Check size={13} /> Already set up ({info.clientIdHint}). Paste a new Client ID and secret below to replace them. Apps signed in with the old one will ask you to sign in again.
        </div>
      )}
      <ol className="mt-3 space-y-2">
        {info.steps.map((st, i) => (
          <li key={i} className="flex gap-2.5 text-[13.5px]">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sunken font-mono text-[12px] text-muted">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div>{st.text}</div>
              {st.copy === "redirect" && (
                <div className="mt-1 flex items-center gap-1.5">
                  <code className="min-w-0 truncate rounded bg-sunken px-2 py-1 font-mono text-[12.5px]">{info.redirectUri}</code>
                  <button onClick={() => copy(info.redirectUri)} className="flex shrink-0 items-center gap-1 rounded-app border border-line px-2 py-1 text-xs hover:bg-sunken">
                    <Copy size={11} /> {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              )}
              {st.url && (
                <button onClick={() => openSignIn(st.url!)} className="mt-1 flex items-center gap-1 text-xs text-accent hover:underline">
                  Open <ExternalLink size={11} />
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Labeled label="Client ID">
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="….apps.googleusercontent.com" spellCheck={false} autoComplete="off" className={`${inputClass} font-mono`} />
        </Labeled>
        <Labeled label="Client secret">
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Stored encrypted on this Mac" autoComplete="off" className={`${inputClass} font-mono`} />
        </Labeled>
      </div>
      {error && <div className="mt-2 text-xs text-danger">{error}</div>}
      <div className="mt-3 flex items-center justify-end gap-2">
        {info.configured && (
          <button
            onClick={() => void api.connectors.removeOAuthApp(info.id).then(onClose)}
            className="mr-auto text-xs text-danger hover:underline"
          >
            Remove {info.label} setup
          </button>
        )}
        <button onClick={() => void save()} disabled={busy || !clientId.trim() || !secret.trim()} className="rounded-app bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40">
          {busy ? "Saving…" : "Save and connect"}
        </button>
      </div>
    </div>
  );
}

function AddForm({ template, onClose, onAdded }: { template: ConnectorTemplate | null; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState(template?.name ?? "");
  const [label, setLabel] = useState(template?.label ?? "");
  const [transport, setTransport] = useState<ConnectorTransport>(template?.transport ?? "http");
  const [url, setUrl] = useState(template?.url ?? "");
  const [command, setCommand] = useState(template?.command ?? "");
  const [args, setArgs] = useState((template?.args ?? []).join(" "));
  const [env, setEnv] = useState<Record<string, string>>({});
  const [bearer, setBearer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const envKeys = template?.envKeys ?? [];

  const nameOk = /^[a-z0-9][a-z0-9_-]*$/.test(name) && name.length >= 2;
  const target = transport === "http" ? url.trim() : command.trim();
  const valid = nameOk && label.trim() && target && envKeys.every((k) => (env[k] ?? "").length > 0);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const input: CreateConnectorInput = {
      name,
      label: label.trim(),
      transport,
      url: transport === "http" ? url.trim() : undefined,
      command: transport === "stdio" ? command.trim() : undefined,
      args: transport === "stdio" ? args.split(/\s+/).filter(Boolean) : [],
      env: Object.fromEntries(Object.entries(env).filter(([, v]) => v)),
      bearerToken: bearer || undefined,
      enabled: true,
    };
    try {
      const c = await api.connectors.create(input);
      useStore.setState((s) => ({ connectors: s.connectors.some((x) => x.id === c.id) ? s.connectors : [...s.connectors, c] }));
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-app border border-line bg-elev p-4">
      <div className="mb-3 text-[14.5px] font-semibold">{template ? `Add ${template.label}` : "Add a custom MCP server"}</div>
      <div className="grid grid-cols-2 gap-2">
        <Labeled label="Name (tool prefix)">
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="e.g. linear" spellCheck={false} className={`${inputClass} font-mono ${name && !nameOk ? "border-danger/60" : ""}`} />
        </Labeled>
        <Labeled label="Label">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Shown in the list" className={inputClass} />
        </Labeled>
        <Labeled label="Transport">
          <select value={transport} onChange={(e) => setTransport(e.target.value as ConnectorTransport)} disabled={!!template} className={inputClass}>
            <option value="http">HTTP</option>
            <option value="stdio">stdio (local command)</option>
          </select>
        </Labeled>
        {transport === "http" ? (
          <Labeled label="URL">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} className={`${inputClass} font-mono`} />
          </Labeled>
        ) : (
          <>
            <Labeled label="Command">
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" spellCheck={false} className={`${inputClass} font-mono`} />
            </Labeled>
            <Labeled label="Arguments (space separated)" wide>
              <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @scope/mcp-server" spellCheck={false} className={`${inputClass} font-mono`} />
            </Labeled>
          </>
        )}
        {envKeys.map((k) => (
          <Labeled key={k} label={k}>
            <input type="password" value={env[k] ?? ""} onChange={(e) => setEnv((x) => ({ ...x, [k]: e.target.value }))} placeholder="Stored encrypted on this computer" autoComplete="off" className={`${inputClass} font-mono`} />
          </Labeled>
        ))}
        {transport === "http" && (
          <Labeled label="Token (optional; most servers sign in through the browser instead). For Jenkins: username:api-token">
            <input type="password" value={bearer} onChange={(e) => setBearer(e.target.value)} placeholder="Stored encrypted on this computer" autoComplete="off" className={`${inputClass} font-mono`} />
          </Labeled>
        )}
      </div>
      {error && <div className="mt-2 text-xs text-danger">{error}</div>}
      <div className="mt-3 flex justify-end gap-1.5">
        <button onClick={onClose} className="rounded-app px-2.5 py-1 text-xs text-muted hover:bg-sunken">
          Cancel
        </button>
        <button onClick={() => void submit()} disabled={!valid || busy} className="rounded-app bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40">
          {busy ? "Connecting…" : "Add"}
        </button>
      </div>
    </div>
  );
}

function ConnectorCard({ connector: c, onError }: { connector: AppConnector; onError: (e: string | null) => void }) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [auth, setAuth] = useState(false);
  const [env, setEnv] = useState<Record<string, string>>({});
  const [bearer, setBearer] = useState("");
  const [busy, setBusy] = useState<"test" | "auth" | "toggle" | null>(null);
  const st = STATUS[c.status];

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<AppConnector | void>) => {
    setBusy(kind);
    onError(null);
    try {
      const updated = await fn();
      if (updated) useStore.setState((s) => ({ connectors: s.connectors.map((x) => (x.id === updated.id ? updated : x)) }));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveAuth = () =>
    run("auth", async () => {
      const patch: Parameters<typeof api.connectors.update>[1] = {};
      const envPatch = Object.fromEntries(Object.entries(env).filter(([, v]) => v));
      if (Object.keys(envPatch).length) patch.env = envPatch;
      if (bearer) patch.bearerToken = bearer;
      if (!Object.keys(patch).length) return;
      const updated = await api.connectors.update(c.id, patch);
      setEnv({});
      setBearer("");
      setAuth(false);
      return updated;
    });

  const remove = () => {
    if (!window.confirm(`Remove ${c.label}? Its stored credentials are deleted. This can't be undone.`)) return;
    void run("toggle", async () => {
      await api.connectors.delete(c.id);
      useStore.setState((s) => ({ connectors: s.connectors.filter((x) => x.id !== c.id) }));
    });
  };

  const target = c.transport === "http" ? c.url : [c.command, ...c.args].filter(Boolean).join(" ");

  return (
    <div className="rounded-app border border-line bg-elev p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14.5px] font-medium">{c.label}</span>
            {c.signedIn && <span className="text-[12.5px] text-muted">signed in</span>}
          </div>
          {detailsOpen && target && <div className="mt-0.5 truncate font-mono text-[12.5px] text-muted">{c.transport} · {target}</div>}
          <div className="mt-1 flex items-center gap-2 text-[13px]">
            <span className={`rounded-full px-1.5 py-0.5 font-medium ${st.cls}`}>{st.label}</span>
            {c.statusDetail && c.status !== "connected" && <span className="truncate text-muted">{c.statusDetail}</span>}
          </div>
        </div>
        <Toggle value={c.enabled} onChange={(v) => void run("toggle", () => api.connectors.update(c.id, { enabled: v }))} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button onClick={() => setToolsOpen((v) => !v)} className="flex items-center gap-1 rounded-app border border-line px-2 py-1 text-xs hover:bg-sunken">
          <ChevronRight size={11} className={`transition-transform ${toolsOpen ? "rotate-90" : ""}`} />
          {c.tools.length} tool{c.tools.length === 1 ? "" : "s"}
        </button>
        <button onClick={() => void run("test", () => api.connectors.test(c.id))} disabled={busy !== null} className="flex items-center gap-1 rounded-app border border-line px-2 py-1 text-xs hover:bg-sunken disabled:opacity-50">
          <RefreshCw size={11} className={busy === "test" ? "animate-spin" : ""} /> Reconnect
        </button>
        {c.status === "needs-auth" && c.authUrl && (
          <button onClick={() => openSignIn(c.authUrl!)} className="rounded-app bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg">
            Sign in
          </button>
        )}
        {(c.signedIn || (c.transport === "http" && !c.hasBearerToken && c.status !== "connected")) && (
          <button
            onClick={() => void run("auth", () => api.connectors.signOut(c.id))}
            disabled={busy !== null}
            title="Forget this app's sign-in and start a fresh one"
            className="rounded-app border border-line px-2 py-1 text-xs hover:bg-sunken disabled:opacity-50"
          >
            {c.signedIn ? "Sign out" : "Reset sign-in"}
          </button>
        )}
        {(c.envKeys.length > 0 || c.hasBearerToken) && (
          <button onClick={() => setAuth((v) => !v)} className="rounded-app border border-line px-2 py-1 text-xs hover:bg-sunken">
            Update keys
          </button>
        )}
        <button onClick={() => setDetailsOpen((v) => !v)} className="rounded-app px-2 py-1 text-xs text-muted hover:bg-sunken">
          {detailsOpen ? "Hide details" : "Details"}
        </button>
        <button onClick={remove} className="ml-auto flex items-center gap-1 rounded-app px-2 py-1 text-xs text-danger hover:bg-danger/10">
          <Trash2 size={11} /> Remove
        </button>
      </div>

      {toolsOpen && (
        <div className="mt-2 max-h-48 space-y-0.5 overflow-y-auto rounded-app border border-line bg-sunken/50 px-2.5 py-1.5">
          {c.tools.length === 0 && <div className="text-xs text-muted">No tools reported yet. Reconnect to refresh.</div>}
          {c.tools.map((t) => (
            <div key={t.name} className="flex items-baseline gap-2 text-xs">
              <span className="shrink-0 font-mono">{t.name}</span>
              <span className="truncate text-muted">{t.description}</span>
            </div>
          ))}
        </div>
      )}

      {auth && (
        <div className="mt-2 space-y-1.5 rounded-app border border-line bg-sunken/50 p-2.5">
          {c.envKeys.map((k) => (
            <Labeled key={k} label={k}>
              <input type="password" value={env[k] ?? ""} onChange={(e) => setEnv((x) => ({ ...x, [k]: e.target.value }))} placeholder="Leave blank to keep the current value" autoComplete="off" className={`${inputClass} font-mono`} />
            </Labeled>
          ))}
          {c.hasBearerToken && (
            <Labeled label="Bearer token">
              <input type="password" value={bearer} onChange={(e) => setBearer(e.target.value)} placeholder={c.hasBearerToken ? "Leave blank to keep the current token" : "Optional"} autoComplete="off" className={`${inputClass} font-mono`} />
            </Labeled>
          )}
          <div className="flex justify-end gap-1.5">
            <button onClick={() => setAuth(false)} className="rounded-app px-2.5 py-1 text-xs text-muted hover:bg-elev">
              Cancel
            </button>
            <button onClick={() => void saveAuth()} disabled={busy !== null || (!bearer && !Object.values(env).some(Boolean))} className="flex items-center gap-1 rounded-app bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40">
              <Check size={11} /> Save securely
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Labeled({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`block ${wide ? "col-span-2" : ""}`}>
      <div className="mb-0.5 text-[12.5px] text-muted">{label}</div>
      {children}
    </label>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${value ? "bg-accent" : "bg-line"}`}
      role="switch"
      aria-checked={value}
      title={value ? "Enabled" : "Disabled"}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${value ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

const inputClass = "block w-full min-w-0 rounded-app border border-line bg-sunken px-2 py-1 text-[13.5px] outline-none placeholder:text-muted focus:border-accent";
