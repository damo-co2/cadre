import { useState } from "react";
import { Bell } from "lucide-react";
import { useStore } from "../lib/store";
import { BotAvatar } from "./BotAvatar";

/**
 * Bell button in the chat header. Replies and "needs attention" pings from other conversations
 * collect here instead of sitting above the composer. The dot shows only for ones not yet seen.
 */
export function NotificationsMenu() {
  const notifications = useStore((s) => s.notifications);
  const conversationId = useStore((s) => s.conversation?.id);
  const bots = useStore((s) => s.bots);
  const clearNotifications = useStore((s) => s.clearNotifications);
  const openChat = useStore((s) => s.openChat);
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState(() => new Date(0).toISOString());

  const items = notifications.filter((n) => n.conversationId !== conversationId);
  const unseen = items.filter((n) => n.at > seenAt);
  const urgent = unseen.some((n) => n.kind === "needs-attention");

  const toggle = () => {
    if (!open) setSeenAt(new Date().toISOString());
    setOpen(!open);
  };

  return (
    <>
      <button
        onClick={toggle}
        className={`no-drag relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] ${open ? "bg-elev text-accent" : "text-muted hover:bg-elev hover:text-fg"}`}
        title={items.length ? `${items.length} notification${items.length === 1 ? "" : "s"}` : "No notifications"}
      >
        <Bell size={15} />
        {unseen.length > 0 && (
          <span
            className={`absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold text-bg ${urgent ? "bg-signal" : "bg-accent"}`}
          >
            {unseen.length > 9 ? "9+" : unseen.length}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="no-drag fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="no-drag absolute right-3 top-[58px] z-40 w-[min(380px,calc(100vw-24px))] overflow-hidden rounded-[14px] border border-line bg-elev text-[13px] shadow-tide md:top-[66px]">
            <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
              <span className="font-medium">Notifications</span>
              {items.length > 0 && (
                <button onClick={clearNotifications} className="text-muted hover:text-fg">
                  Clear all
                </button>
              )}
            </div>
            {items.length === 0 ? (
              <div className="px-3.5 py-6 text-center text-muted">Nothing new from your other chats.</div>
            ) : (
              <div className="max-h-[min(420px,calc(100dvh-140px))] divide-y divide-line overflow-y-auto">
                {items.map((n) => {
                  const b = bots.find((x) => x.id === n.botId);
                  return (
                    <button
                      key={n.id}
                      onClick={() => {
                        setOpen(false);
                        void openChat(n.conversationId, n.botId);
                      }}
                      className="flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left hover:bg-sunken/60"
                      title={n.body || n.title}
                    >
                      {b ? (
                        <BotAvatar name={b.name} color={b.avatarColor} shape={b.avatarShape} image={b.avatarImage} size={22} className="mt-0.5" />
                      ) : (
                        <BotAvatar name="?" color="#6b6b76" shape="circle" size={22} className="mt-0.5" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className={`truncate font-medium ${n.kind === "needs-attention" ? "text-signal" : ""}`}>{b?.name ?? "Bot"}</span>
                          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">
                            {new Date(n.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
                          </span>
                        </div>
                        <div className="line-clamp-2 text-muted">{n.body || n.title}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
