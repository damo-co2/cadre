import { useEffect, useState } from "react";
import type { ProviderId, ProviderInfo } from "@grokbot/shared";
import { makeModelRef, parseModelRef } from "@grokbot/shared";
import { api } from "../lib/api";

/**
 * Two selects: provider, then model. Model ids are fetched live per provider (falls back to a
 * curated list), and free text is allowed so a brand-new model id still works.
 */
const CUSTOM = "__custom__";

export function ModelPicker({
  value,
  onChange,
  allowDefault,
  defaultLabel = "Default",
}: {
  value: string | null;
  onChange: (ref: string | null) => void;
  allowDefault?: boolean;
  defaultLabel?: string;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const parsed = value ? safeParse(value) : null;
  const [provider, setProvider] = useState<ProviderId | "">(parsed?.provider ?? "");
  const [models, setModels] = useState<{ id: string; label?: string }[]>([]);
  const [model, setModel] = useState(parsed?.model ?? "");
  const [loading, setLoading] = useState(false);
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    void api.providers.list().then(setProviders).catch(() => setProviders([]));
  }, []);

  useEffect(() => {
    const p = value ? safeParse(value) : null;
    setProvider(p?.provider ?? "");
    setModel(p?.model ?? "");
  }, [value]);

  useEffect(() => {
    setCustom(false);
    if (!provider) return setModels([]);
    setLoading(true);
    void api.providers
      .models(provider)
      .then((l) => setModels(l.models))
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, [provider]);

  const pick = (p: ProviderId | "", m: string) => {
    if (!p) return onChange(null);
    if (!m) return;
    onChange(makeModelRef(p, m));
  };

  return (
    <div className="flex w-full min-w-0 gap-1.5">
      <select
        value={provider}
        onChange={(e) => {
          const p = e.target.value as ProviderId | "";
          setProvider(p);
          const info = providers.find((x) => x.id === p);
          const m = info?.defaultModel ?? "";
          setModel(m);
          pick(p, m);
        }}
        className="min-w-0 flex-1 rounded-app border border-line bg-sunken px-2 py-1.5 text-[14px] outline-none"
      >
        {allowDefault && <option value="">{defaultLabel}</option>}
        {!allowDefault && !provider && <option value="">Choose provider…</option>}
        {providers.map((p) => (
          <option key={p.id} value={p.id} disabled={p.status === "not-installed" || p.status === "off"}>
            {p.label}
            {p.status === "ready" ? "" : p.status === "needs-key" ? " (needs key)" : p.status === "needs-signin" ? " (sign in)" : p.status === "not-installed" ? " (not installed)" : p.status === "off" ? " (turned off)" : ""}
          </option>
        ))}
      </select>
      {provider && !custom && (
        <select
          value={model}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setCustom(true);
              return;
            }
            setModel(e.target.value);
            pick(provider, e.target.value);
          }}
          className="min-w-0 flex-1 rounded-app border border-line bg-sunken px-2 py-1.5 font-mono text-[13.5px] outline-none"
        >
          {loading && !models.length && <option value={model}>Loading…</option>}
          {model && !models.some((m) => m.id === model) && !loading && <option value={model}>{model}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id} title={m.id}>
              {m.label ?? m.id}
            </option>
          ))}
          <option value={CUSTOM}>Other model id…</option>
        </select>
      )}
      {provider && custom && (
        <div className="flex min-w-0 flex-1 gap-1">
          <input
            autoFocus
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => model && pick(provider, model)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && model) {
                pick(provider, model);
                setCustom(false);
              }
              if (e.key === "Escape") setCustom(false);
            }}
            placeholder="Type a model id"
            className="min-w-0 flex-1 rounded-app border border-line bg-sunken px-2 py-1.5 font-mono text-[13.5px] outline-none"
          />
          <button onClick={() => setCustom(false)} className="shrink-0 rounded-app border border-line px-2 text-[12.5px] text-muted hover:text-fg" title="Back to the list">
            List
          </button>
        </div>
      )}
    </div>
  );
}

function safeParse(ref: string) {
  try {
    return parseModelRef(ref);
  } catch {
    return null;
  }
}
