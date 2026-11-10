import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { CustomRule } from "@grokbot/shared";
import { MAX_CUSTOM_RULES_PER_KIND } from "@grokbot/shared";
import { api } from "../lib/api";

type Kind = CustomRule["kind"];

/** Settings → General → Bot → Custom Rules: the allow/ask lists Auto Review consults before asking you. */
export function CustomRules() {
  const [rules, setRules] = useState<CustomRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("allow");
  const [tool, setTool] = useState("*");
  const [match, setMatch] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    api.rules
      .list()
      .then((r) => {
        setRules(r);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  };
  useEffect(refresh, []);

  const allow = rules.filter((r) => r.kind === "allow");
  const ask = rules.filter((r) => r.kind === "ask");
  const full = (k: Kind) => (k === "allow" ? allow : ask).length >= MAX_CUSTOM_RULES_PER_KIND;

  const add = async () => {
    if (!text.trim() || busy || full(kind)) return;
    setBusy(true);
    setError(null);
    try {
      const rule = await api.rules.create({ kind, tool: tool.trim() || "*", match: match.trim(), text: text.trim() });
      setRules((r) => [...r, rule]);
      setMatch("");
      setText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.rules.delete(id);
      setRules((r) => r.filter((x) => x.id !== id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      <RuleList title="Allow automatically" rules={allow} onRemove={remove} />
      <RuleList title="Ask first" rules={ask} onRemove={remove} />

      <div className="rounded-app border border-line bg-elev p-2.5">
        <div className="mb-1.5 label-mono">Add rule</div>
        <div className="grid grid-cols-[auto_1fr_1fr] gap-1.5">
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={inputClass}>
            <option value="allow">Allow automatically</option>
            <option value="ask">Ask first</option>
          </select>
          <input value={tool} onChange={(e) => setTool(e.target.value)} placeholder="Tool (* = any)" spellCheck={false} className={`${inputClass} font-mono`} />
          <input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="Input contains… (optional)" spellCheck={false} className={`${inputClass} font-mono`} />
        </div>
        <div className="mt-1.5 flex gap-1.5">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
            placeholder="Description, e.g. “Reading pages on github.com”"
            className={`${inputClass} flex-1`}
          />
          <button
            onClick={() => void add()}
            disabled={busy || !text.trim() || full(kind)}
            className="rounded-app bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40"
            title={full(kind) ? `Limit of ${MAX_CUSTOM_RULES_PER_KIND} reached` : undefined}
          >
            Add rule
          </button>
        </div>
      </div>
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}

const inputClass = "min-w-0 rounded-app border border-line bg-sunken px-2 py-1 text-[13.5px] outline-none placeholder:text-muted";

function RuleList({ title, rules, onRemove }: { title: string; rules: CustomRule[]; onRemove: (id: string) => Promise<void> }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <div className="text-[14px] font-medium">{title}</div>
        <div className="text-[12.5px] text-muted">
          {rules.length} / {MAX_CUSTOM_RULES_PER_KIND}
        </div>
      </div>
      {rules.length === 0 ? (
        <div className="rounded-app border border-dashed border-line px-2.5 py-2 text-xs text-muted">No rules yet.</div>
      ) : (
        <div className="divide-y divide-line rounded-app border border-line bg-elev">
          {rules.map((r) => (
            <div key={r.id} className="flex items-center gap-2 px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px]">{r.text}</div>
                <div className="truncate font-mono text-[12.5px] text-muted">
                  {r.tool}
                  {r.match ? ` · contains “${r.match}”` : " · any input"}
                </div>
              </div>
              <button onClick={() => void onRemove(r.id)} className="rounded-md p-1 text-muted hover:bg-danger/10 hover:text-danger" title="Remove rule">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
