import { useState } from "react";
import { api } from "../lib/api";

/**
 * "Compact chat": summarises everything but the newest few messages, and every Bot in the chat starts its
 * next turn fresh from that summary. Messages stay in the chat; memory is untouched.
 */
export function CompactButton({ conversationId, className = "" }: { conversationId: string; className?: string }) {
  const [state, setState] = useState<{ busy: boolean; note: string | null; failed: boolean }>({ busy: false, note: null, failed: false });
  const run = async () => {
    if (state.busy) return;
    setState({ busy: true, note: null, failed: false });
    try {
      const { summarized } = await api.conversations.compact(conversationId);
      setState({
        busy: false,
        failed: false,
        note: summarized ? `Summarised ${summarized} older message${summarized === 1 ? "" : "s"}. Bots pick up from the summary on their next turn.` : "Nothing to compact yet. Bots start fresh on their next turn.",
      });
    } catch (e) {
      setState({ busy: false, failed: true, note: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className={className}>
      <button
        onClick={() => void run()}
        disabled={state.busy}
        className="w-full rounded-app border border-line px-2.5 py-1.5 text-left hover:bg-sunken disabled:opacity-60"
        title="Summarise older messages so the Bots work from a short summary instead of the whole chat. Messages and memory are kept."
      >
        {state.busy ? "Compacting…" : "Compact chat"}
      </button>
      {state.note && <div className={`mt-1 text-[12.5px] ${state.failed ? "text-danger" : "text-muted"}`}>{state.note}</div>}
    </div>
  );
}
