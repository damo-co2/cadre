import { useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import type { Bot, Conversation } from "@grokbot/shared";
import { MAX_GROUP_BOTS, MIN_GROUP_BOTS } from "@grokbot/shared";
import { useStore } from "../lib/store";
import { BotAvatar } from "./BotAvatar";
import { Library } from "./Library";

/** Header popover for a group chat: members (add or remove), rename, delete. */
export function GroupDetails({ group, members, onClose }: { group: Conversation; members: Bot[]; onClose: () => void }) {
  const renameGroup = useStore((s) => s.renameGroup);
  const deleteGroup = useStore((s) => s.deleteGroup);
  const setGroupMembers = useStore((s) => s.setGroupMembers);
  const allBots = useStore((s) => s.bots);
  const [title, setTitle] = useState(group.title ?? "");
  const [adding, setAdding] = useState(false);
  // Bots that could join: same space as the members, not hidden, not already here.
  const space = members[0]?.spaceId;
  const candidates = useMemo(
    () => allBots.filter((b) => !b.hidden && (!space || b.spaceId === space) && !group.botIds.includes(b.id)),
    [allBots, space, group.botIds],
  );
  const full = group.botIds.length >= MAX_GROUP_BOTS;
  const canRemove = group.botIds.length > MIN_GROUP_BOTS;

  useEffect(() => setTitle(group.title ?? ""), [group.id, group.title]);

  const commit = () => {
    if ((title.trim() || null) !== group.title) void renameGroup(group.id, title);
  };

  return (
    <>
      <div className="no-drag fixed inset-0 z-30" onClick={onClose} />
      <div className="no-drag absolute left-3 top-[54px] z-40 w-[340px] rounded-xl border border-line bg-elev p-4 shadow-2xl">
        <div className="mb-3">
          <div className="mb-1.5 label-mono">Title</div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            placeholder={members.map((b) => b.name).join(", ") || "Group chat"}
            maxLength={80}
            className="w-full rounded-app border border-line bg-sunken px-2 py-1.5 text-[14.5px] outline-none placeholder:text-muted/70 focus:border-accent"
          />
        </div>

        <div className="mb-3">
          <div className="mb-1.5 label-mono">Members ({members.length})</div>
          <div className="space-y-0.5">
            {members.map((b) => (
              <div key={b.id} className="flex items-center gap-2 rounded-app px-1.5 py-1">
                <BotAvatar name={b.name} color={b.avatarColor} shape={b.avatarShape} image={b.avatarImage} size={24} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium">{b.name}</div>
                  {b.label && <div className="truncate text-[12.5px] text-muted">{b.label}</div>}
                </div>
                <button
                  onClick={() => void setGroupMembers(group.id, group.botIds.filter((id) => id !== b.id))}
                  disabled={!canRemove}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
                  title={canRemove ? `Remove ${b.name} from this group` : `A group needs at least ${MIN_GROUP_BOTS} Bots`}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          {adding ? (
            <div className="mt-1.5 rounded-app border border-line bg-sunken p-1">
              {candidates.length === 0 ? (
                <div className="px-2 py-1.5 text-[13px] text-muted">Every Bot in this space is already here.</div>
              ) : (
                <div className="max-h-[220px] overflow-y-auto">
                  {candidates.map((b) => (
                    <button
                      key={b.id}
                      onClick={() => {
                        void setGroupMembers(group.id, [...group.botIds, b.id]);
                        if (group.botIds.length + 1 >= MAX_GROUP_BOTS) setAdding(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-elev"
                    >
                      <BotAvatar name={b.name} color={b.avatarColor} shape={b.avatarShape} image={b.avatarImage} size={22} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-medium">{b.name}</div>
                        {b.label && <div className="truncate text-[12px] text-muted">{b.label}</div>}
                      </div>
                      <Plus size={13} className="shrink-0 text-muted" />
                    </button>
                  ))}
                </div>
              )}
              <button onClick={() => setAdding(false)} className="mt-0.5 w-full rounded-md px-2 py-1 text-left text-[12.5px] text-muted hover:text-fg">
                Done
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAdding(true)}
              disabled={full}
              className="mt-1.5 flex w-full items-center gap-1.5 rounded-app border border-dashed border-line px-2 py-1.5 text-[13.5px] text-muted hover:border-accent hover:text-fg disabled:opacity-40"
              title={full ? `A group can have at most ${MAX_GROUP_BOTS} Bots` : "Add a Bot from this space"}
            >
              <Plus size={13} /> Add a Bot{full ? ` (max ${MAX_GROUP_BOTS})` : ""}
            </button>
          )}
          <div className="mt-1.5 text-[12.5px] text-muted">Mention a member with @Name, or @everyone for all of them. New members see the whole chat.</div>
        </div>

        <div className="mb-3">
          <div className="mb-1.5 label-mono">Library</div>
          <Library />
        </div>

        <button
          onClick={() => {
            if (window.confirm("Delete this group chat? Its messages are erased. The Bots and their own chats are kept.")) {
              onClose();
              void deleteGroup(group.id);
            }
          }}
          className="w-full rounded-app border border-danger/30 px-2.5 py-1.5 text-left text-[14px] text-danger hover:bg-danger/10"
        >
          Delete group chat
        </button>
      </div>
    </>
  );
}
