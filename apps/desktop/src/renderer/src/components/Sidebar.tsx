import { useMemo, useState } from "react";
import { Plus, Settings, Plug, Pin, EyeOff, Eye, ChevronDown, ChevronRight, Bot as BotIcon, MessagesSquare, Pencil, Trash2, X, Sun, Moon, LayoutGrid } from "lucide-react";
import type { Bot, Conversation } from "@grokbot/shared";
import { botsInSpace, useStore } from "../lib/store";
import { askText } from "../lib/ask";
import { AvatarStack, groupTitle } from "./AvatarStack";
import { BotAvatar } from "./BotAvatar";

type Menu = { kind: "bot"; bot: Bot; x: number; y: number } | { kind: "group"; group: Conversation; x: number; y: number };

export function Sidebar() {
  const allBots = useStore((s) => s.bots);
  const spaceId = useStore((s) => s.spaceId);
  const spaces = useStore((s) => s.spaces);
  const setSpace = useStore((s) => s.setSpace);
  const moveBotToSpace = useStore((s) => s.moveBotToSpace);
  const bots = useMemo(() => botsInSpace(allBots, spaceId), [allBots, spaceId]);
  const space = spaces.find((x) => x.id === spaceId) ?? null;
  const allGroups = useStore((s) => s.groups);
  // A group belongs to the spaces of its members.
  const groups = useMemo(() => allGroups.filter((g) => g.botIds.some((id) => bots.some((b) => b.id === id))), [allGroups, bots]);
  const selectedBotId = useStore((s) => s.selectedBotId);
  const selectedConversationId = useStore((s) => s.selectedConversationId);
  const botStatus = useStore((s) => s.botStatus);
  const unread = useStore((s) => s.unread);
  const approvals = useStore((s) => s.approvals);
  const secureForms = useStore((s) => s.secureForms);
  const selectBot = useStore((s) => s.selectBot);
  const selectConversation = useStore((s) => s.selectConversation);
  const updateBot = useStore((s) => s.updateBot);
  const renameGroup = useStore((s) => s.renameGroup);
  const deleteGroup = useStore((s) => s.deleteGroup);
  const setCreateOpen = useStore((s) => s.setCreateOpen);
  const setNewChatOpen = useStore((s) => s.setNewChatOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setConnectAppsOpen = useStore((s) => s.setConnectAppsOpen);
  const setMobileSidebarOpen = useStore((s) => s.setMobileSidebarOpen);
  const [showHidden, setShowHidden] = useState(false);
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);

  const toggleTheme = useStore((s) => s.toggleTheme);
  const setMobileTeamOpen = useStore((s) => s.setMobileTeamOpen);
  useStore((s) => s.settings.appearance); // re-render the theme icon when it flips
  const dark = document.documentElement.dataset.theme === "dark";
  const working = Object.values(botStatus).filter((st) => st === "working" || st === "typing").length;

  const { lead, pinned, sections, hidden } = useMemo(() => {
    const lead = bots.find((b) => b.isPrimary && !b.hidden) ?? null;
    const visible = bots.filter((b) => !b.hidden && b.id !== lead?.id);
    const pinned = visible.filter((b) => b.pinned);
    const rest = visible.filter((b) => !b.pinned);
    const sections = new Map<string, Bot[]>();
    for (const b of rest) {
      const key = b.section ?? "";
      sections.set(key, [...(sections.get(key) ?? []), b]);
    }
    return { lead, pinned, sections: [...sections.entries()].sort(([a], [b]) => a.localeCompare(b)), hidden: bots.filter((b) => b.hidden) };
  }, [bots]);

  const pendingBots = useMemo(() => {
    const set = new Set<string>();
    for (const a of Object.values(approvals)) if (a.status === "pending") set.add(a.botId);
    for (const f of Object.values(secureForms)) if (f.status === "pending") set.add(f.botId);
    return set;
  }, [approvals, secureForms]);

  const row = (b: Bot) => {
    const raw = botStatus[b.id] ?? "idle";
    const status = pendingBots.has(b.id) ? "needs-attention" : raw;
    const active = b.id === selectedBotId;
    return (
      <button
        key={b.id}
        onClick={() => void selectBot(b.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ kind: "bot", bot: b, x: e.clientX, y: e.clientY });
        }}
        className={`no-drag group flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left transition-colors ${
          active ? "bg-elev shadow-tide" : "hover:bg-elev/60"
        }`}
      >
        <div className="relative">
          <BotAvatar name={b.name} color={b.avatarColor} shape={b.avatarShape} image={b.avatarImage} size={30} />
          {status !== "idle" && (
            <span
              className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-sunken ${
                status === "needs-attention" ? "bg-signal" : "tide-live bg-accent"
              }`}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`truncate text-[14.5px] ${active ? "font-semibold" : "font-medium"}`}>{b.name}</span>
            {b.isPrimary && <span className="rounded border border-accent/50 px-1 font-mono text-[11px] font-medium tracking-wider text-accent">CHIEF</span>}
            {b.hiredBy && !b.isPrimary && <span className="font-mono text-[11px] text-muted" title="Hired by the Chief of Staff">hired</span>}
          </div>
          <div className="truncate text-[12.5px] text-muted">
            {status === "needs-attention" ? (
              <span className="text-signal">Needs attention</span>
            ) : status === "working" ? (
              "Working…"
            ) : status === "typing" ? (
              "Typing…"
            ) : (
              (b.label ?? "Add a label")
            )}
          </div>
        </div>
        {unread[b.id] && !active && <span className="h-2 w-2 rounded-full bg-accent" />}
      </button>
    );
  };

  const groupRow = (g: Conversation) => {
    const members = g.botIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b));
    const active = g.id === selectedConversationId && !selectedBotId;
    return (
      <button
        key={g.id}
        onClick={() => void selectConversation(g.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ kind: "group", group: g, x: e.clientX, y: e.clientY });
        }}
        className={`no-drag flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left transition-colors ${active ? "bg-elev shadow-tide" : "hover:bg-elev/60"}`}
      >
        <div className="flex w-[30px] shrink-0 justify-center overflow-hidden">
          <AvatarStack bots={members} size={18} max={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className={`truncate text-[14.5px] ${active ? "font-semibold" : "font-medium"}`}>{groupTitle(g.title, members)}</div>
          <div className="truncate text-[12.5px] text-muted">
            {members.length} Bot{members.length === 1 ? "" : "s"}
          </div>
        </div>
        {unread[g.id] && !active && <span className="h-2 w-2 rounded-full bg-accent" />}
      </button>
    );
  };

  return (
    <aside className="drag flex h-full w-full shrink-0 flex-col border-r border-line bg-sunken md:w-[244px]">
      <div className="sidebar-head flex items-end gap-1 px-4 pb-3 pt-5">
        <button
          onClick={() => setMobileSidebarOpen(false)}
          title="Close"
          className="no-drag -ml-1 mr-1 flex h-7 w-7 items-center justify-center self-center rounded-md text-muted hover:bg-elev hover:text-fg md:hidden"
        >
          <X size={16} />
        </button>
        <div className="mr-auto min-w-0">
          <div className="font-serif text-[28px] leading-none">{space ? space.name : "Team"}</div>
          <div className="mt-1 font-mono text-[12px] text-muted">
            {bots.filter((b) => !b.hidden).length} Bots{working ? ` · ${working} working` : ""}
          </div>
        </div>
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setPlusMenu({ x: r.left, y: r.bottom + 4 });
          }}
          title="New Bot (⌘N) · New chat (⌘⇧N)"
          className="no-drag flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-elev hover:text-fg"
        >
          <Plus size={16} />
        </button>
      </div>

      {spaces.length > 1 && (
        // Phones have no rail: switch spaces here.
        <div className="no-drag mb-2 flex gap-1 px-3 md:hidden">
          {spaces.map((x) => (
            <button
              key={x.id}
              onClick={() => void setSpace(x.id)}
              className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[13px] ${x.id === spaceId ? "border-accent bg-accent/10 text-fg" : "border-line text-muted"}`}
            >
              <span>{x.emoji}</span>
              {x.name}
            </button>
          ))}
        </div>
      )}
      <div className="no-drag flex-1 space-y-4 overflow-y-auto px-2 pb-2">
        {lead && <Section title="Lead">{row(lead)}</Section>}
        {pinned.length > 0 && (
          <Section title="Pinned" icon={<Pin size={11} />}>
            {pinned.map(row)}
          </Section>
        )}
        {sections.map(([name, list]) => (
          <Section key={name || "__bots"} title={name || (lead ? "Specialists" : "Bots")}>
            {list.map(row)}
          </Section>
        ))}
        {groups.length > 0 && (
          <Section title="Groups" icon={<MessagesSquare size={11} />}>
            {groups.map(groupRow)}
          </Section>
        )}
        {hidden.length > 0 && (
          <div>
            <button
              onClick={() => setShowHidden((v) => !v)}
              className="label-mono flex w-full items-center gap-1 px-2 py-1 hover:text-fg"
            >
              {showHidden ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Hidden Bots ({hidden.length})
            </button>
            {showHidden && <div className="space-y-0.5 opacity-70">{hidden.map(row)}</div>}
          </div>
        )}
        {bots.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted">
            No Bots in {space?.name ?? "this space"} yet.
            <br />
            Press <kbd className="rounded border border-line bg-elev px-1">⌘N</kbd> to create one.
          </div>
        )}
      </div>

      {/* Desktop has the rail for these; the phone drawer has no rail. */}
      <div className="no-drag space-y-0.5 border-t border-line p-2 md:hidden">
        <NavButton icon={<LayoutGrid size={15} />} label="Team pulse" onClick={() => setMobileTeamOpen(true)} />
        <NavButton icon={<Plug size={15} />} label="Connect apps" onClick={() => setConnectAppsOpen(true)} />
        <NavButton icon={dark ? <Sun size={15} /> : <Moon size={15} />} label={dark ? "Day theme" : "Night theme"} onClick={() => void toggleTheme()} />
        <NavButton icon={<Settings size={15} />} label="Settings" onClick={() => setSettingsOpen(true)} />
      </div>

      {plusMenu && (
        <ContextMenu
          x={plusMenu.x}
          y={plusMenu.y}
          onClose={() => setPlusMenu(null)}
          items={[
            { label: "New Bot", shortcut: "⌘N", icon: <BotIcon size={13} />, onClick: () => setCreateOpen(true) },
            { label: "New chat", shortcut: "⌘⇧N", icon: <MessagesSquare size={13} />, onClick: () => setNewChatOpen(true), disabled: bots.filter((b) => !b.hidden).length < 2 },
          ]}
        />
      )}

      {menu?.kind === "bot" && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: menu.bot.pinned ? "Unpin" : "Pin", icon: <Pin size={13} />, onClick: () => updateBot(menu.bot.id, { pinned: !menu.bot.pinned }) },
            {
              label: menu.bot.hidden ? "Show in sidebar" : "Hide from sidebar",
              icon: menu.bot.hidden ? <Eye size={13} /> : <EyeOff size={13} />,
              onClick: () => updateBot(menu.bot.id, { hidden: !menu.bot.hidden }),
            },
            {
              label: "Move to new section…",
              onClick: async () => {
                const name = await askText({
                  title: "Move to section",
                  label: menu.bot.name,
                  value: menu.bot.section ?? "",
                  placeholder: "Section name, e.g. Research (empty = back to Specialists)",
                  confirmLabel: "Move",
                  allowEmpty: true,
                });
                if (name !== null) void updateBot(menu.bot.id, { section: name || null });
              },
            },
            {
              label: "Rename Bot",
              onClick: async () => {
                const name = await askText({ title: "Rename Bot", value: menu.bot.name, confirmLabel: "Rename" });
                if (name) void updateBot(menu.bot.id, { name });
              },
            },
            { label: `Make lead of ${space?.name ?? "this space"}`, onClick: () => updateBot(menu.bot.id, { isPrimary: true }), disabled: menu.bot.isPrimary },
            ...spaces
              .filter((x) => x.id !== menu.bot.spaceId)
              .map((x) => ({ label: `Move to ${x.emoji} ${x.name}`, onClick: () => void moveBotToSpace(menu.bot.id, x.id) })),
            {
              label: "Delete",
              danger: true,
              onClick: () => {
                if (window.confirm(`Delete ${menu.bot.name}? This erases its profile, conversation and memory. This can't be undone.`))
                  void useStore.getState().deleteBot(menu.bot.id);
              },
            },
          ]}
        />
      )}

      {menu?.kind === "group" && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Rename",
              icon: <Pencil size={13} />,
              onClick: async () => {
                const title = await askText({ title: "Rename group", value: menu.group.title ?? "", placeholder: "Group title (empty = list the Bots)", confirmLabel: "Rename", allowEmpty: true });
                if (title !== null) void renameGroup(menu.group.id, title);
              },
            },
            {
              label: "Delete",
              icon: <Trash2 size={13} />,
              danger: true,
              onClick: () => {
                if (window.confirm("Delete this group chat? Its messages are erased. The Bots and their own chats are kept.")) void deleteGroup(menu.group.id);
              },
            },
          ]}
        />
      )}
    </aside>
  );
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="label-mono flex items-center gap-1 px-2 pb-1.5 pt-1">
        {icon}
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function NavButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-app px-2.5 py-1.5 text-[14.5px] text-muted hover:bg-elev hover:text-fg"
    >
      {icon}
      {label}
    </button>
  );
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: { label: string; icon?: React.ReactNode; shortcut?: string; onClick: () => unknown; danger?: boolean; disabled?: boolean }[];
  onClose: () => void;
}) {
  return (
    // no-drag: these menus open over the sidebar, a window-drag region in Electron. Without it macOS
    // treats clicks on the items as window drags and they never reach the buttons.
    <div className="no-drag fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        className="no-drag absolute min-w-[190px] rounded-[10px] border border-line bg-elev p-1 shadow-tide"
        style={{ left: Math.min(x, window.innerWidth - 210), top: Math.min(y, window.innerHeight - items.length * 32 - 16) }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it) => (
          <button
            key={it.label}
            disabled={it.disabled}
            onClick={() => {
              void it.onClick();
              onClose();
            }}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[14.5px] disabled:opacity-40 ${
              it.danger ? "text-danger hover:bg-danger/10" : "hover:bg-sunken"
            }`}
          >
            {it.icon}
            <span className="flex-1">{it.label}</span>
            {it.shortcut && <span className="text-[12.5px] text-muted">{it.shortcut}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
