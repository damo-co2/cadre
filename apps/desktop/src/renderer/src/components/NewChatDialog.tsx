import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { MAX_GROUP_BOTS, MIN_GROUP_BOTS } from "@grokbot/shared";
import { useStore } from "../lib/store";
import { BotAvatar } from "./BotAvatar";
import { Dialog } from "./Dialog";

/** ⌘⇧N: start a group chat with 2–6 Bots. */
export function NewChatDialog() {
  // Select the stable array and filter outside the store: a selector that returns a new array on
  // every call makes React re-render forever (blank window, React error #185).
  const allBots = useStore((s) => s.bots);
  const spaceId = useStore((s) => s.spaceId);
  const bots = useMemo(() => allBots.filter((b) => !b.hidden && (!spaceId || b.spaceId === spaceId)), [allBots, spaceId]);
  const createGroup = useStore((s) => s.createGroup);
  const setNewChatOpen = useStore((s) => s.setNewChatOpen);
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_GROUP_BOTS ? p : [...p, id]));
  const valid = picked.length >= MIN_GROUP_BOTS && picked.length <= MAX_GROUP_BOTS;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createGroup(picked, title.trim() || undefined);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog title="New chat" onClose={() => setNewChatOpen(false)} width={460}>
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <div className="label-mono">To:</div>
            <div className={`text-[12.5px] ${valid ? "text-muted" : "text-signal"}`}>
              Pick {MIN_GROUP_BOTS} to {MAX_GROUP_BOTS} Bots · {picked.length} selected
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {bots.map((b) => {
              const on = picked.includes(b.id);
              return (
                <button
                  key={b.id}
                  onClick={() => toggle(b.id)}
                  disabled={!on && picked.length >= MAX_GROUP_BOTS}
                  className={`flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-[14px] disabled:opacity-40 ${
                    on ? "border-accent bg-accent/10" : "border-line bg-elev hover:border-accent/50"
                  }`}
                  aria-pressed={on}
                >
                  <BotAvatar name={b.name} color={b.avatarColor} shape={b.avatarShape} image={b.avatarImage} size={20} />
                  {b.name}
                  {on && <Check size={12} className="text-accent" />}
                </button>
              );
            })}
            {bots.length < MIN_GROUP_BOTS && <div className="text-xs text-muted">You need at least {MIN_GROUP_BOTS} visible Bots to start a group chat.</div>}
          </div>
        </div>
        <div>
          <div className="mb-1.5 label-mono">Title (optional)</div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            placeholder="e.g. Launch week"
            maxLength={80}
            className="w-full rounded-app border border-line bg-sunken px-3 py-1.5 text-[14.5px] outline-none focus:border-accent"
          />
        </div>
        {error && <div className="text-xs text-danger">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={() => setNewChatOpen(false)} className="rounded-app px-3 py-1.5 text-[14.5px] text-muted hover:bg-sunken">
            Cancel
          </button>
          <button onClick={() => void submit()} disabled={!valid || busy} className="rounded-app bg-accent px-4 py-1.5 text-[14.5px] font-medium text-accent-fg disabled:opacity-40">
            Create
          </button>
        </div>
      </div>
    </Dialog>
  );
}
