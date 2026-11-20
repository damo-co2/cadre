import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, LayoutGrid, Zap, Menu, Monitor, ShieldAlert } from "lucide-react";
import type { Bot } from "@grokbot/shared";
import { formatReply } from "@grokbot/shared";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { MOBILE_QUERY, useMediaQuery } from "../lib/useMediaQuery";
import { AvatarStack, groupTitle } from "./AvatarStack";
import { BotAvatar } from "./BotAvatar";
import { BotDetails } from "./BotDetails";
import { Composer } from "./Composer";
import { GroupDetails } from "./GroupDetails";
import { MessageBubble } from "./MessageBubble";
import { NotificationsMenu } from "./NotificationsMenu";
import { ComputerPanel } from "./ComputerPanel";
import { TeamPanel } from "./TeamPanel";

const STARTERS = [
  { title: "Morning briefing", prompt: "Every morning, give me a short briefing: my calendar for the day, urgent emails, and anything I promised people." },
  { title: "Inbox manager", prompt: "You're my inbox manager. Triage my email, draft replies for routine messages, and only pull me in for decisions." },
  { title: "Competitive intelligence", prompt: "Track my top competitors each week: pricing changes, launches, hiring, and news. Summarize what matters." },
  { title: "Travel coordinator", prompt: "Plan and coordinate my trips: compare flights and hotels, hold options, and keep an itinerary up to date." },
];

export function ChatView() {
  const conversation = useStore((s) => s.conversation);
  const bot = useStore((s) => s.bots.find((b) => b.id === s.selectedBotId));
  const messages = useStore((s) => s.messages);
  const status = useStore((s) => (bot ? s.botStatus[bot.id] : undefined) ?? "idle");
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const error = useStore((s) => s.error);
  const approvals = useStore((s) => s.approvals);
  const secureForms = useStore((s) => s.secureForms);
  const bots = useStore((s) => s.bots);
  const openChat = useStore((s) => s.openChat);
  const groups = useStore((s) => s.groups);
  const skills = useStore((s) => s.skills);
  const replyTo = useStore((s) => s.replyTo);
  const setReplyTo = useStore((s) => s.setReplyTo);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Screen view: in a group, whose screen is open (picked from the Team panel), and whether it fills the window.
  const [screenBotId, setScreenBotId] = useState<string | null>(null);
  const [screenExpanded, setScreenExpanded] = useState(false);
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const mobileComputerOpen = useStore((s) => s.mobileComputerOpen);
  const setMobileComputerOpen = useStore((s) => s.setMobileComputerOpen);
  const mobileTeamOpen = useStore((s) => s.mobileTeamOpen);
  const setMobileTeamOpen = useStore((s) => s.setMobileTeamOpen);
  const setMobileSidebarOpen = useStore((s) => s.setMobileSidebarOpen);
  const rightPanel = useStore((s) => s.rightPanel);
  const setRightPanel = useStore((s) => s.setRightPanel);
  const tasks = useStore((s) => s.tasks);
  const autoMode = useStore((s) => !s.settings.autoReview);
  const setAutoMode = useStore((s) => s.setAutoMode);
  const showComputer = isMobile ? mobileComputerOpen : rightPanel === "computer";
  const toggleComputer = () => (isMobile ? setMobileComputerOpen(!mobileComputerOpen) : setRightPanel(rightPanel === "computer" ? "team" : "computer"));
  // The big view ends whenever the screen panel closes, however it was closed.
  useEffect(() => {
    if (!showComputer) setScreenExpanded(false);
  }, [showComputer]);
  const closeComputer = () => {
    setScreenExpanded(false);
    if (isMobile) setMobileComputerOpen(false);
    else setRightPanel("team");
  };
  const scroller = useRef<HTMLDivElement>(null);
  const streaming = useMemo(() => messages.some((m) => m.status === "streaming"), [messages]);

  const isGroup = conversation?.kind === "group";
  const members = useMemo(
    () => (isGroup ? conversation.botIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)) : []),
    [isGroup, conversation, bots],
  );

  // Long chats load the newest page; scrolling near the top loads the page before it. Keep the
  // reader's place: remember the distance from the bottom and restore it once older messages are in.
  const hasOlder = useStore((s) => s.hasOlder);
  const loadingOlder = useStore((s) => s.loadingOlder);
  const loadOlder = useStore((s) => s.loadOlder);
  const keepFromBottom = useRef<number | null>(null);
  const loadEarlier = () => {
    const el = scroller.current;
    if (!el || !useStore.getState().hasOlder || useStore.getState().loadingOlder) return;
    keepFromBottom.current = el.scrollHeight - el.scrollTop;
    void loadOlder().then((added) => {
      if (!added) keepFromBottom.current = null;
    });
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || keepFromBottom.current === null) return;
    el.scrollTop = el.scrollHeight - keepFromBottom.current;
  }, [messages]);

  // Follow the conversation: jump to the bottom when a conversation loads or the user sends,
  // and keep following while streaming unless the user has scrolled up to read.
  // `stick` stays true while the view is at the bottom. Messages out of view are laid out at a guessed
  // height (content-visibility), so after the jump they render at their real height and the page grows
  // under the reader: while stuck, every change in the page's height scrolls back to the bottom.
  const stick = useRef(true);
  const content = useRef<HTMLDivElement>(null);
  const conversationKey = conversation?.id;
  useEffect(() => {
    const inner = content.current;
    const el = scroller.current;
    if (!inner || !el) return;
    const ro = new ResizeObserver(() => {
      if (stick.current && keepFromBottom.current === null) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [conversationKey]);
  const lastConversation = useRef<string | null>(null);
  const lastMessageId = useRef<string | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const convId = messages[0]?.conversationId ?? null;
    const switched = convId !== lastConversation.current;
    lastConversation.current = convId;
    const last = messages.at(-1);
    const appended = !!last && last.id !== lastMessageId.current;
    lastMessageId.current = last?.id ?? null;
    if (keepFromBottom.current !== null && !switched) {
      // Older messages were just added above: the layout effect kept the reader's place.
      keepFromBottom.current = null;
      return;
    }
    keepFromBottom.current = null;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (switched || (appended && last?.role === "user") || nearBottom) {
      stick.current = true;
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Opening a pin or a reply's quote: load older pages until the message is there, then scroll to it
  // and flash it. `focusMessageId` may be a full id or the 8-character prefix a reply quote carries.
  const focusMessageId = useStore((s) => s.focusMessageId);
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!focusMessageId) return;
    const state = useStore.getState();
    const pin = state.pins.find((p) => p.messageId === focusMessageId);
    // Wait until the pin's chat has loaded.
    if (pin && messages[0]?.conversationId !== pin.conversationId) return;
    const target = messages.find((m) => m.id === focusMessageId || (focusMessageId.length < 36 && m.id.startsWith(focusMessageId)));
    const el = target ? document.getElementById(`msg-${target.id}`) : null;
    if (!el) {
      if (state.hasOlder) {
        // Not loaded yet: fetch the page before; this effect runs again when it arrives.
        if (!state.loadingOlder) void state.loadOlder().then((added) => !added && useStore.setState({ focusMessageId: null }));
        return;
      }
      useStore.setState({ focusMessageId: null, error: pin ? "That pinned message is no longer in this chat. Its text is still on the pin in Team pulse." : "That message is no longer in this chat." });
      return;
    }
    useStore.setState({ focusMessageId: null });
    stick.current = false; // reading an older message: don't snap back to the bottom
    el.scrollIntoView({ block: "center" });
    setFlashId(target!.id);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 1800);
  }, [messages, focusMessageId]);

  useEffect(() => {
    setDetailsOpen(false);
  }, [conversation?.id]);

  // Pending approvals and Secure Forms that belong to OTHER conversations: surfaced as a strip above the composer.
  // One chip per Bot and chat, and a click opens the chat the request is waiting in (a group, or the Bot's own chat).
  const elsewhere = useMemo(() => {
    const byChat = new Map<string, { botId: string; conversationId: string; count: number }>();
    const pending = [...Object.values(approvals), ...Object.values(secureForms)];
    for (const a of pending) {
      if (a.status !== "pending" || a.conversationId === conversation?.id) continue;
      const key = `${a.botId}:${a.conversationId}`;
      const e = byChat.get(key) ?? { botId: a.botId, conversationId: a.conversationId, count: 0 };
      e.count += 1;
      byChat.set(key, e);
    }
    return [...byChat.entries()]
      .map(([key, e]) => {
        const name = bots.find((b) => b.id === e.botId)?.name ?? "Bot";
        const group = groups.find((g) => g.id === e.conversationId);
        const where = group ? groupTitle(group.title, group.botIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b))) : null;
        return { ...e, key, name, where };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [approvals, secureForms, bots, groups, conversation?.id]);
  const elsewhereCount = elsewhere.reduce((n, e) => n + e.count, 0);
  const reports = useMemo(() => bots.filter((b) => !b.hidden && !b.isPrimary), [bots]);
  const waitingOnYou = tasks.filter((t) => t.ownerBotId === null).length;
  // The Bot whose screen the Team panel shows: this chat's Bot, or in a group the one working.
  const panelBot = bot ?? members.find((m) => useStore.getState().botStatus[m.id] === "working") ?? members.find((m) => m.isPrimary) ?? members[0] ?? null;
  // The Bot whose full screen is open: this chat's Bot, or in a group the one picked from the Team panel.
  const screenBot = bot ?? members.find((m) => m.id === screenBotId) ?? null;
  const openScreen = (expand: boolean) =>
    panelBot
      ? () => {
          setScreenBotId(panelBot.id);
          setScreenExpanded(expand);
          if (isMobile) {
            setMobileTeamOpen(false);
            setMobileComputerOpen(true);
          } else setRightPanel("computer");
        }
      : undefined;

  if (!conversation || (!isGroup && !bot)) return null;

  const sendWithFiles = async (text: string, files: File[]) => {
    const attachmentIds = files.length ? (await api.uploads(files)).map((a) => a.id) : [];
    const to = useStore.getState().replyTo;
    await send(to ? formatReply(to, text) : text, attachmentIds);
    if (to) setReplyTo(null);
  };

  const title = isGroup ? groupTitle(conversation.title, members) : bot!.name;
  const mentions = (isGroup ? members : bots.filter((b) => b.id !== bot!.id && !b.hidden)).map((b) => ({ id: b.id, name: b.name, label: b.label ?? undefined }));
  if (isGroup) mentions.unshift({ id: "everyone", name: "everyone", label: "All Bots in this chat" });

  return (
    <div className="flex h-full min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="drag relative flex h-[56px] shrink-0 items-center justify-between gap-2 border-b border-line px-2 md:h-[64px] md:px-5">
          <button
            onClick={() => setMobileSidebarOpen(true)}
            className="no-drag mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-elev hover:text-fg md:hidden"
            title="Open sidebar"
          >
            <Menu size={18} />
          </button>
          <button
            onClick={() => setDetailsOpen((v) => !v)}
            className="no-drag flex min-w-0 flex-1 items-center gap-3 rounded-[10px] px-1.5 py-1 hover:bg-elev/60 md:flex-initial"
            title="View conversation details"
          >
            {isGroup ? (
              <AvatarStack bots={members} size={26} max={3} />
            ) : (
              <BotAvatar name={bot!.name} color={bot!.avatarColor} shape={bot!.avatarShape} image={bot!.avatarImage} size={30} className="md:hidden" />
            )}
            <div className="flex min-w-0 items-baseline gap-2.5 text-left">
              <span className="max-w-[170px] truncate font-serif text-[22px] leading-tight sm:max-w-[360px] md:text-[26px]">{title}</span>
              <span className="hidden truncate text-[13.5px] text-muted sm:inline">
                {isGroup
                  ? `${members.length} Bot${members.length === 1 ? "" : "s"}`
                  : status === "working"
                    ? "Working…"
                    : [bot!.label ?? "Add a role", bot!.modelRef?.split(":")[0]].filter(Boolean).join(" · ")}
              </span>
              <ChevronDown size={13} className="shrink-0 self-center text-muted" />
            </div>
          </button>
          {!isGroup && bot!.isPrimary && reports.length > 0 && (
            <div className="no-drag ml-auto hidden items-center lg:flex" title={reports.map((b) => b.name).join(", ")}>
              {reports.slice(0, 5).map((b) => (
                <BotAvatar key={b.id} name={b.name} color={b.avatarColor} shape={b.avatarShape} image={b.avatarImage} size={24} className="-ml-1.5 ring-2 ring-bg" />
              ))}
              <span className="ml-2.5 font-mono text-[12.5px] text-muted">
                {reports.length} report{reports.length === 1 ? "" : "s"}
              </span>
            </div>
          )}
          <button
            onClick={() => void setAutoMode(!autoMode)}
            className={`no-drag flex shrink-0 items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-[13.5px] ${autoMode ? "bg-elev text-accent" : "text-muted hover:bg-elev"}`}
            title={
              autoMode
                ? "Auto mode is on: Bots act without asking. Actions that can't be undone (rm -rf, git push, sudo) still ask. Click to turn off."
                : "Auto mode is off: some actions wait for your approval. Click to let Bots act without asking."
            }
          >
            <Zap size={14} className={autoMode ? "fill-current" : ""} />
            <span className="hidden sm:inline">Auto</span>
          </button>
          <NotificationsMenu />
          {(!isGroup || members.length > 0) && (
            <button
              onClick={isGroup ? (showComputer ? closeComputer : openScreen(false)) : toggleComputer}
              className={`no-drag flex shrink-0 items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-[13.5px] ${showComputer ? "bg-elev text-accent" : "text-muted hover:bg-elev"}`}
              title={isGroup ? "See a Bot's screen in this group" : "Open computer"}
            >
              <Monitor size={14} />
              <span className="hidden sm:inline">Computer</span>
            </button>
          )}
          <button
            onClick={() => (isMobile ? setMobileTeamOpen(true) : setRightPanel(rightPanel === "team" ? null : "team"))}
            className={`no-drag relative flex shrink-0 items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-[13.5px] ${!isMobile && rightPanel === "team" ? "bg-elev text-accent" : "text-muted hover:bg-elev"}`}
            title="Team pulse: live screen, task board, next routines"
          >
            <LayoutGrid size={14} />
            <span className="hidden sm:inline">Pulse</span>
            {waitingOnYou > 0 && <span className="h-1.5 w-1.5 rounded-full bg-signal" />}
          </button>
          {detailsOpen &&
            (isGroup ? (
              <GroupDetails group={conversation} members={members} onClose={() => setDetailsOpen(false)} />
            ) : (
              <BotDetails bot={bot!} onClose={() => setDetailsOpen(false)} />
            ))}
        </header>

        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            // Scrolled up to read: stop following. Back at the bottom: follow again.
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (hasOlder && el.scrollTop < 400) loadEarlier();
          }}
          className="no-drag flex-1 overflow-y-auto"
        >
          <div ref={content} className="mx-auto w-full max-w-[780px] px-3 py-4 md:px-8 md:py-7">
            {messages.length === 0 ? (
              isGroup ? (
                <div className="mt-10 text-center">
                  <AvatarStack bots={members} size={44} max={6} className="mx-auto mb-4" />
                  <div className="text-lg font-semibold">{title}</div>
                  <p className="mx-auto mt-1 max-w-md text-muted">Start the conversation. Mention a Bot with @Name or @everyone.</p>
                </div>
              ) : (
                <div className="mt-10 text-center">
                  <BotAvatar name={bot!.name} color={bot!.avatarColor} shape={bot!.avatarShape} image={bot!.avatarImage} size={64} className="mx-auto mb-4" />
                  <div className="text-lg font-semibold">{bot!.name}</div>
                  <p className="mx-auto mt-1 max-w-md text-muted">
                    Tell {bot!.name} what its job is. Try one of these, or write your own.
                  </p>
                  <div className="mx-auto mt-6 grid max-w-lg grid-cols-1 gap-2 text-left sm:grid-cols-2">
                    {STARTERS.map((s) => (
                      <button
                        key={s.title}
                        onClick={() => void send(s.prompt)}
                        className="rounded-app border border-line bg-elev p-3 text-[14px] hover:border-accent"
                      >
                        <div className="font-medium">{s.title}</div>
                        <div className="mt-0.5 line-clamp-2 text-muted">{s.prompt}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )
            ) : (
              <div className="space-y-5">
                {hasOlder && (
                  <div className="flex justify-center">
                    <button onClick={loadEarlier} disabled={loadingOlder} className="rounded-full border border-line px-3 py-1 font-mono text-[12px] text-muted hover:text-fg disabled:opacity-60">
                      {loadingOlder ? "Loading…" : "Load earlier messages"}
                    </button>
                  </div>
                )}
                {messages.map((m) => (
                  // content-visibility: messages scrolled out of view skip layout and paint, so typing stays fast in long chats.
                  <div
                    key={m.id}
                    id={`msg-${m.id}`}
                    className={`rounded-[12px] transition-shadow duration-500 [contain-intrinsic-size:auto_120px] [content-visibility:auto] ${flashId === m.id ? "ring-2 ring-accent ring-offset-4 ring-offset-bg" : ""}`}
                  >
                    <MessageBubble message={m} bot={bot} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="mx-auto w-full max-w-[760px] px-5">
            <div className="mb-2 flex items-start justify-between rounded-app border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              <span className="whitespace-pre-wrap break-words">{error}</span>
              <button className="ml-3 shrink-0 underline" onClick={() => useStore.setState({ error: null })}>
                Dismiss
              </button>
            </div>
          </div>
        )}

        {elsewhereCount > 0 && (
          <div className="mx-auto w-full max-w-[760px] px-5">
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-app border border-signal/40 bg-signal/10 px-3 py-1.5 text-xs">
              <ShieldAlert size={13} className="shrink-0 text-signal" />
              <span>
                {elsewhereCount} request{elsewhereCount === 1 ? "" : "s"} need{elsewhereCount === 1 ? "s" : ""} attention
              </span>
              <span className="text-muted">·</span>
              {elsewhere.map((e) => (
                <button
                  key={e.key}
                  onClick={() => void openChat(e.conversationId, e.botId)}
                  className="rounded-md bg-elev px-1.5 py-0.5 font-medium hover:text-accent"
                  title={e.where ? `Open the group chat "${e.where}"` : `Open ${e.name}`}
                >
                  {e.name}
                  {e.where && <span className="ml-1 font-normal text-muted">in {e.where}</span>}
                  {e.count > 1 && <span className="ml-1 text-muted">×{e.count}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        <Composer
          key={conversation.id}
          botName={title}
          placeholder={isGroup ? "Message the group…  (@ to mention, @everyone)" : undefined}
          streaming={streaming}
          skills={skills}
          mentions={mentions}
          onSend={sendWithFiles}
          onStop={() => void stop()}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
        />
      </div>
      {showComputer &&
        screenBot &&
        (isMobile ? (
          // Phone: the computer takes the whole screen; its header's X closes it.
          <div className="fixed inset-0 z-30 bg-bg">
            <ComputerPanel bot={screenBot} onClose={closeComputer} members={isGroup ? members : undefined} onPickBot={setScreenBotId} />
          </div>
        ) : (
          <ComputerPanel
            bot={screenBot}
            onClose={closeComputer}
            expanded={screenExpanded}
            onToggleExpand={() => setScreenExpanded((v) => !v)}
            members={isGroup ? members : undefined}
            onPickBot={setScreenBotId}
          />
        ))}
      {!isMobile && (rightPanel === "team" || (rightPanel === "computer" && !screenBot)) && (
        <TeamPanel bot={panelBot} onClose={() => setRightPanel(null)} onOpenComputer={openScreen(true)} />
      )}
      {isMobile && mobileTeamOpen && (
        <div className="fixed inset-0 z-30 bg-sunken">
          <TeamPanel
            fullScreen
            bot={panelBot}
            onClose={() => setMobileTeamOpen(false)}
            onOpenComputer={openScreen(false)}
          />
        </div>
      )}
    </div>
  );
}
