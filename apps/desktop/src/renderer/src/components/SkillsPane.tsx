import { useState } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import type { Skill } from "@grokbot/shared";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { relativeTime } from "../lib/time";

/** Settings → Skills: reusable instruction sets every Bot can use with "/" in the composer. */
export function SkillsPane() {
  const skills = useStore((s) => s.skills);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async (k: Skill) => {
    if (!window.confirm(`Delete skill "${k.name}"? This can't be undone.`)) return;
    setError(null);
    try {
      await api.skills.delete(k.id);
      useStore.setState((s) => ({ skills: s.skills.filter((x) => x.id !== k.id) }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2 flex items-end justify-between">
          <div>
            <div className="text-[14.5px] font-semibold">Skills</div>
            <div className="text-xs text-muted">A reusable set of instructions for how to do a task. Shared by every Bot; type / in the composer to use one.</div>
          </div>
          {!creating && (
            <button onClick={() => setCreating(true)} className="flex shrink-0 items-center gap-1 rounded-app border border-line px-2.5 py-1 text-xs hover:bg-sunken">
              <Plus size={12} /> New skill
            </button>
          )}
        </div>
        {creating && <NewSkillForm onClose={() => setCreating(false)} onError={setError} />}
        {skills.length === 0 && !creating ? (
          <div className="rounded-app border border-dashed border-line px-3 py-4 text-center text-xs text-muted">No skills yet. Write one, or teach a Bot a task from its computer (Phase 8).</div>
        ) : (
          <div className="mt-2 divide-y divide-line rounded-app border border-line bg-elev">
            {skills.map((k) => {
              const expanded = open === k.id;
              return (
                <div key={k.id}>
                  <div className="flex items-center gap-2 px-2.5 py-2">
                    <button onClick={() => setOpen(expanded ? null : k.id)} className="flex min-w-0 flex-1 items-start gap-1.5 text-left">
                      <ChevronRight size={12} className={`mt-1 shrink-0 text-muted transition-transform ${expanded ? "rotate-90" : ""}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate font-mono text-[14px] font-medium">/{k.name}</span>
                          <span className={`shrink-0 rounded px-1 text-[11.5px] ${k.source === "taught" ? "bg-accent/15 text-accent" : "bg-sunken text-muted"}`}>
                            {k.source === "taught" ? "Taught" : "Written"}
                          </span>
                        </div>
                        <div className="truncate text-xs text-muted">{k.description}</div>
                      </div>
                    </button>
                    <span className="shrink-0 text-[12.5px] text-muted" title={k.updatedAt}>
                      {relativeTime(k.updatedAt)}
                    </span>
                    <button onClick={() => void remove(k)} className="shrink-0 rounded-md p-1 text-muted hover:bg-danger/10 hover:text-danger" title="Delete skill">
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {expanded && (
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-line bg-sunken/50 px-3 py-2 font-mono text-[13px]">{k.content}</pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {error && <div className="mt-2 text-xs text-danger">{error}</div>}
      </section>
    </div>
  );
}

function NewSkillForm({ onClose, onError }: { onClose: () => void; onError: (e: string | null) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const nameOk = /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length >= 2;
  const valid = nameOk && description.trim() && content.trim();

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    onError(null);
    try {
      const skill = await api.skills.upsert({ name, description: description.trim(), content });
      useStore.setState((s) => {
        const i = s.skills.findIndex((x) => x.id === skill.id);
        const next = s.skills.slice();
        if (i < 0) next.push(skill);
        else next[i] = skill;
        return { skills: next };
      });
      onClose();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 space-y-1.5 rounded-app border border-line bg-elev p-3">
      <div className="grid grid-cols-[1fr_2fr] gap-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          placeholder="name (a-z, 0-9, dashes)"
          spellCheck={false}
          autoFocus
          className={`${inputClass} font-mono ${name && !nameOk ? "border-danger/60" : ""}`}
        />
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One-line description" maxLength={300} className={inputClass} />
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={"Markdown: when to use it, inputs, steps, validation, output, approval points."}
        rows={8}
        spellCheck={false}
        className={`${inputClass} resize-y font-mono text-[13px]`}
      />
      <div className="flex justify-end gap-1.5">
        <button onClick={onClose} className="rounded-app px-2.5 py-1 text-xs text-muted hover:bg-sunken">
          Cancel
        </button>
        <button onClick={() => void submit()} disabled={!valid || busy} className="rounded-app bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40">
          Save skill
        </button>
      </div>
    </div>
  );
}

const inputClass = "block w-full min-w-0 rounded-app border border-line bg-sunken px-2 py-1 text-[13.5px] outline-none placeholder:text-muted";
