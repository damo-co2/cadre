import { useEffect } from "react";
import { connectEvents } from "./lib/api";
import { frameBus } from "./lib/frames";
import { useStore } from "./lib/store";
import { MOBILE_QUERY, useMediaQuery } from "./lib/useMediaQuery";
import { Sidebar } from "./components/Sidebar";
import { Rail } from "./components/Rail";
import { ChatView } from "./components/ChatView";
import { CreateBotDialog } from "./components/CreateBotDialog";
import { NewChatDialog } from "./components/NewChatDialog";
import { ConnectAppsDialog } from "./components/ConnectAppsDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { Welcome } from "./components/Welcome";
import { AskDialog } from "./components/AskDialog";
import { LearnedChip } from "./components/LearnedChip";

export default function App() {
  const bootstrap = useStore((s) => s.bootstrap);
  const onEvent = useStore((s) => s.onEvent);
  const setConnected = useStore((s) => s.setConnected);
  const setWsSend = useStore((s) => s.setWsSend);
  const connected = useStore((s) => s.connected);
  const bots = useStore((s) => s.bots);
  const selectedBotId = useStore((s) => s.selectedBotId);
  const selectedConversationId = useStore((s) => s.selectedConversationId);
  const appearance = useStore((s) => s.settings.appearance);
  const error = useStore((s) => s.error);
  const createOpen = useStore((s) => s.createOpen);
  const newChatOpen = useStore((s) => s.newChatOpen);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const connectAppsOpen = useStore((s) => s.connectAppsOpen);
  const setConnectAppsOpen = useStore((s) => s.setConnectAppsOpen);
  const setCreateOpen = useStore((s) => s.setCreateOpen);
  const setNewChatOpen = useStore((s) => s.setNewChatOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const mobileSidebarOpen = useStore((s) => s.mobileSidebarOpen);
  const setMobileSidebarOpen = useStore((s) => s.setMobileSidebarOpen);
  const isMobile = useMediaQuery(MOBILE_QUERY);
  // No Electron bridge: served to a browser (phone or web). Drops the title-bar strip and drag regions.
  const isWeb = !window.cadre;

  // Leaving the phone layout (rotation, resize) must not leave the drawer flag stuck open.
  useEffect(() => {
    if (!isMobile) setMobileSidebarOpen(false);
  }, [isMobile, setMobileSidebarOpen]);

  useEffect(() => {
    void bootstrap();
    const conn = connectEvents(
      (e) => {
        // Frames are too chatty for the store: hand them straight to the canvas subscribers.
        if (e.type === "screen.frame") {
          frameBus.publish(e.botId, { data: e.data, width: e.width, height: e.height });
          return;
        }
        if (e.type === "notify") {
          const open = useStore.getState().conversation?.id === e.conversationId;
          void (async () => {
            const focused = (await window.cadre?.isFocused?.().catch(() => true)) ?? true;
            if (!focused || !open) window.cadre?.notify?.({ title: e.title, body: e.body, botId: e.botId, conversationId: e.conversationId });
          })();
        }
        onEvent(e);
      },
      (ok) => {
        setConnected(ok);
        if (ok) void bootstrap();
      },
    );
    setWsSend(conn.send);
    return () => {
      setWsSend(() => {});
      conn.close();
    };
  }, [bootstrap, onEvent, setConnected, setWsSend]);

  // Dock / taskbar badge: Bots or group chats that are unread or waiting on you.
  const unread = useStore((s) => s.unread);
  const botStatus = useStore((s) => s.botStatus);
  useEffect(() => {
    const ids = new Set<string>();
    for (const [id, v] of Object.entries(unread)) if (v) ids.add(id);
    for (const [id, st] of Object.entries(botStatus)) if (st === "needs-attention") ids.add(id);
    window.cadre?.setBadge?.(ids.size);
  }, [unread, botStatus]);

  // Clicking an OS notification brings the app forward and asks us to open that chat.
  useEffect(() => {
    const onOpen = (e: WindowEventMap["cadre:open"]) => {
      const { botId, conversationId } = e.detail ?? {};
      void useStore.getState().openChat(conversationId, botId);
    };
    window.addEventListener("cadre:open", onOpen);
    return () => window.removeEventListener("cadre:open", onOpen);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = appearance === "dark" || (appearance === "system" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [appearance]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (e.shiftKey) setNewChatOpen(true);
        else setCreateOpen(true);
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
      if (e.key === "Escape") {
        setCreateOpen(false);
        setNewChatOpen(false);
        setSettingsOpen(false);
        setConnectAppsOpen(false);
        setMobileSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCreateOpen, setNewChatOpen, setSettingsOpen, setConnectAppsOpen, setMobileSidebarOpen]);

  return (
    <div className={`flex h-full w-full ${isWeb ? "web" : ""}`}>
      {isMobile ? (
        // Off-canvas drawer: slides in over the chat, closed by the backdrop or by picking a conversation.
        <>
          <div
            className={`fixed inset-0 z-30 bg-black/40 transition-opacity ${mobileSidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
            onClick={() => setMobileSidebarOpen(false)}
            aria-hidden
          />
          <div
            className={`fixed inset-y-0 left-0 z-30 w-[280px] max-w-[85vw] bg-bg shadow-2xl transition-transform duration-200 ${
              mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"
            }`}
            aria-hidden={!mobileSidebarOpen}
          >
            <Sidebar />
          </div>
        </>
      ) : (
        <>
          <Rail />
          <Sidebar />
        </>
      )}
      <main className="flex min-w-0 flex-1 flex-col bg-bg">
        {!connected ? (
          <div className="drag flex h-full items-center justify-center text-muted">
            <div className="no-drag text-center">
              <div className="mb-2 text-base font-medium text-fg">Connecting to the local server…</div>
              <div className="text-xs">
                Start it with <code className="rounded bg-sunken px-1 py-0.5">npm run dev:server</code>
              </div>
              {error && <div className="mt-3 max-w-md text-xs text-danger">{error}</div>}
            </div>
          </div>
        ) : bots.length === 0 || !(selectedBotId || selectedConversationId) ? (
          <Welcome />
        ) : (
          <ChatView />
        )}
      </main>
      {createOpen && <CreateBotDialog />}
      {newChatOpen && <NewChatDialog />}
      {settingsOpen && <SettingsDialog />}
      <LearnedChip />
      {connectAppsOpen && <ConnectAppsDialog />}
      <AskDialog />
    </div>
  );
}
