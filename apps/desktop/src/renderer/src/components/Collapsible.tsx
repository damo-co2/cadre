import { useState } from "react";
import { ChevronRight } from "lucide-react";

/** Chevron-toggled card with a monospace body; used for tool calls, reasoning and approval inputs. */
export function Collapsible({ label, children, muted }: { label: React.ReactNode; children: React.ReactNode; muted?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`rounded-app border border-line ${muted ? "bg-transparent" : "bg-elev"}`}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1 px-2.5 py-1.5 text-xs text-muted hover:text-fg">
        <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        {label}
      </button>
      {open && <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-line px-3 py-2 font-mono text-[13px]">{children}</pre>}
    </div>
  );
}

export function pretty(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
