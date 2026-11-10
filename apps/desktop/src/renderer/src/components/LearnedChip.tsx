import { useEffect } from "react";
import { Sparkles, X } from "lucide-react";
import { useStore } from "../lib/store";

/** "Learned about you: …" — shown for a few seconds after Bots add to About you; click to review. */
export function LearnedChip() {
  const learned = useStore((s) => s.justLearned);
  const dismiss = useStore((s) => s.dismissLearned);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  useEffect(() => {
    if (!learned.length) return;
    const t = setTimeout(dismiss, 9000);
    return () => clearTimeout(t);
  }, [learned, dismiss]);
  if (!learned.length) return null;
  const first = learned[0]!;
  return (
    <div className="fixed bottom-4 left-1/2 z-40 flex max-w-[min(520px,calc(100vw-32px))] -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-elev py-1.5 pl-3 pr-1.5 text-[13.5px] shadow-lg">
      <Sparkles size={14} className="shrink-0 text-accent" />
      <button
        onClick={() => {
          dismiss();
          setSettingsOpen(true, "about");
        }}
        className="min-w-0 truncate text-left hover:underline"
        title="Review in Settings → About you"
      >
        Learned about you: {first}
        {learned.length > 1 ? ` (+${learned.length - 1} more)` : ""}
      </button>
      <button onClick={dismiss} aria-label="Dismiss" className="shrink-0 rounded-full p-1 text-muted hover:bg-sunken">
        <X size={13} />
      </button>
    </div>
  );
}
