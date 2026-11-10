import { LayoutGrid, MessagesSquare, Moon, Plug, Settings, Sparkles, Sun, Users } from "lucide-react";
import { useMemo } from "react";
import { botsInSpace, useStore } from "../lib/store";

/**
 * Tidewater's icon rail (desktop only). The first of the 1 : 2 : 8 columns: rail, team roster,
 * then the stage. Starts below the macOS window buttons, which sit over its top-left corner.
 */
export function Rail() {
  const allBots = useStore((s) => s.bots);
  const spaceId = useStore((s) => s.spaceId);
  const spaces = useStore((s) => s.spaces);
  const setSpace = useStore((s) => s.setSpace);
  const bots = useMemo(() => botsInSpace(allBots, spaceId), [allBots, spaceId]);
  const allTasks = useStore((s) => s.tasks);
  const tasks = useMemo(() => {
    const ids = new Set(bots.map((b) => b.id));
    return allTasks.filter((t) => (t.ownerBotId && ids.has(t.ownerBotId)) || (t.createdBy && ids.has(t.createdBy)));
  }, [allTasks, bots]);
  const rightPanel = useStore((s) => s.rightPanel);
  const setRightPanel = useStore((s) => s.setRightPanel);
  const selectBot = useStore((s) => s.selectBot);
  const selectedBotId = useStore((s) => s.selectedBotId);
  const setCreateOpen = useStore((s) => s.setCreateOpen);
  const setNewChatOpen = useStore((s) => s.setNewChatOpen);
  const setConnectAppsOpen = useStore((s) => s.setConnectAppsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const theme = document.documentElement.dataset.theme;
  useStore((s) => s.settings.appearance); // re-render when the theme changes

  const chief = bots.find((b) => b.isPrimary && !b.hidden);
  const waitingOnYou = tasks.filter((t) => t.ownerBotId === null).length;

  return (
    <nav className="drag flex h-full w-16 shrink-0 flex-col items-center gap-1.5 border-r border-line bg-rail pb-4 pt-12">
      <div className="tide-mark no-drag mb-3 h-[30px] w-[30px]" title="Cadre" />
      {spaces.length > 1 && (
        <div className="no-drag mb-3 flex flex-col items-center gap-1 border-b border-line pb-3">
          {spaces.map((x) => (
            <button
              key={x.id}
              onClick={() => void setSpace(x.id)}
              title={`${x.name}${x.defaultModelRef ? ` · ${x.defaultModelRef}` : " · app default model"}`}
              className={`flex h-9 w-9 items-center justify-center rounded-[10px] text-[18px] transition-colors ${x.id === spaceId ? "bg-elev ring-1 ring-accent" : "opacity-60 hover:bg-elev hover:opacity-100"}`}
            >
              {x.emoji}
            </button>
          ))}
        </div>
      )}
      <RailButton
        title={chief ? `Chief of Staff (${chief.name})` : "Chats"}
        active={!!chief && selectedBotId === chief.id}
        onClick={() => chief && void selectBot(chief.id)}
      >
        <Users size={17} />
      </RailButton>
      <RailButton title="Team pulse: task board and what runs next" active={rightPanel === "team"} onClick={() => setRightPanel(rightPanel === "team" ? null : "team")} badge={waitingOnYou || undefined}>
        <LayoutGrid size={17} />
      </RailButton>
      <RailButton title="New group chat (⌘⇧N)" onClick={() => setNewChatOpen(true)} disabled={bots.filter((b) => !b.hidden).length < 2}>
        <MessagesSquare size={17} />
      </RailButton>
      <RailButton title="Hire from a template (⌘N)" onClick={() => setCreateOpen(true)}>
        <Sparkles size={17} />
      </RailButton>
      <RailButton title="Connect apps" onClick={() => setConnectAppsOpen(true)}>
        <Plug size={17} />
      </RailButton>
      <div className="flex-1" />
      <RailButton title={theme === "dark" ? "Switch to day" : "Switch to night"} onClick={() => void toggleTheme()}>
        {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
      </RailButton>
      <RailButton title="Settings (⌘,)" onClick={() => setSettingsOpen(true)}>
        <Settings size={17} />
      </RailButton>
    </nav>
  );
}

function RailButton({
  title,
  active,
  disabled,
  badge,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  badge?: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`no-drag relative flex h-[38px] w-[38px] items-center justify-center rounded-[10px] transition-colors disabled:opacity-35 ${
        active ? "bg-elev text-accent shadow-[inset_2px_0_0_var(--accent)]" : "text-muted hover:bg-elev/70 hover:text-fg"
      }`}
    >
      {children}
      {badge ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-signal px-1 font-mono text-[11px] font-bold text-bg">{badge}</span>
      ) : null}
    </button>
  );
}
