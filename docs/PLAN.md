# Build Plan: a Grok Bot clone with bring-your-own LLM

Written 2026-11-07. Research sources at the bottom.

## 0. What Grok Bot actually is (research summary)

xAI (with Cursor) launched Grok Bot in early beta on **11 Aug 2026**. Closed source, Grok models only, not self-hostable.

**Core idea:** you create named **Bots** (AI teammates). Every Bot on your account shares **one persistent cloud computer** (a Firecracker microVM in Cursor's cloud) with a browser, filesystem (`/workspace`) and terminal. Each Bot gets its own *screen* on that computer. Bots keep working after you close your laptop.

**Product concepts (official terminology):**

| Concept | Definition |
|---|---|
| Bot | Named agent with its own conversation, role, memory. Created with "+" / Cmd+N: name, picture (Bot / Generate / Upload), label. No description field; the job is set in the first message. |
| Primary Bot | One Bot that "answers for every Bot working for you". |
| Cloud computer | One per user, shared by all Bots. Browser, `/workspace`, terminal, saved logins, CLI creds. "Not a security boundary." |
| Computer view | Right-hand panel showing the Bot's live screen. Buttons: "Open computer", "Take control", "I'm done". |
| Skill | "A reusable set of instructions for how to do a task." Shared across all Bots. Created by asking in chat ("Save the process we just used as a skill called…") or by **Teach a task**. |
| Teach a task | Record yourself doing a browser task once (≤10 min, no audio). Bot drafts a skill from the recording. |
| Routine | Assigns a workflow to one Bot and says when to run: schedule or event. Created by asking in chat. |
| Auto Review | Model-based approval layer that checks every command, app use and computer action before it runs. |
| Custom Rules | Up to 20 "Allow automatically" + 20 "Ask first" rules (≤1000 chars each). Ask-first wins. |
| Vault | Account-wide store: Login / Card / Contact info, with "Hints". CSV import. Autofilled without the model ever seeing the value. |
| Secure Form / secret card | Masked one-off entry for passwords, OTPs, API keys. |
| Connect apps | Sidebar screen: Browse / Installed / Needs auth. Gmail, GCal, Drive, Slack, Notion, GitHub, Linear, Sentry, PagerDuty, 1Password, MCP, "any API". |
| Group chat | "New chat" → "To:" with 2–6 Bots. `@mention`, `@everyone`. Approval cards and secret requests never appear in groups. |
| Handoff | Bot-to-Bot async message. Receiving Bot wakes, works, replies later. Text-only. |
| Memory | Per-Bot: preferences, role context, summaries of prior work. Shared across Bots: a few user facts (name, timezone). No memory UI; "What do you remember about me?" / "Forget that…". |
| Pages | Bot-built web pages, shareable (invite / team / anyone with link). |
| Bot email | `name@mail.grokbot.com`, used as a routine trigger. |

**Documented limits:** 50 routines per Bot; 300 routine runs/hour per account, 200/hour per routine; schedule spacing ≥5 min; 20 run records kept per routine; approval cards from background work expire after ~30 min; one computer-use task per Bot screen at a time; 20 attachments per message.

**Execution model (from Lee Robinson's Stanford talk, via Builder.io):** every wake (user message, routine, webhook, another Bot, background job) is a model turn routed into a per-conversation queue. The model decides whether to speak; quiet is allowed. The only user-facing tool is `SendToUser`. A background pass rewrites memory (≤100 facts, ≤4000 chars). All Bots see all skills; the model picks.

**Approvals model:** Allow once / Always allow (saves rule) / Deny. Warnings: "This can't be undone", "This changes sign-in or security settings", "This shares your data outside this chat". Only the user's own messages count as instructions; text from email or web pages never does. Outbound email/Slack from routines or background work waits as a draft ("Needs approval"). Human-only steps (SSO, passkey, CAPTCHA, 2FA, card verification) trigger "Take over".

**Platforms:** macOS, Windows, Linux desktop (Electron-style app), iOS 18+, iPadOS, Android 9+. Also reachable via X Chat and Slack.

**Known weaknesses (reviews):** browser automation fragile; cloud computer sleeps when idle so routines ran 12–80 min late; "I'll get back to you" with no follow-up; ~15% of group replies landed in the wrong channel; shared logins across Bots is a security smell; expensive.

**Open-source clones already exist:**
- **Rakazo** (github.com/elie222/rakazo, Apache-2.0, ~7.4k stars): closest clone. TS, React 19 + Vite + Tailwind, Electron + Expo, Hono + oRPC, Postgres + Prisma, Graphile Worker, BYO model via Pi / OpenRouter, Docker/E2B/Daytona sandboxes, Composio/Pipedream connectors, MCP.
- **OpenMausBot** (github.com/milind-soni/OpenMausBot, Apache-2.0, ~16k stars): Electron, Telegram-style UI, runs **Claude Code / Codex / Grok Build CLIs via ACP** so you use your *subscriptions*, cloud desktop via Boat, Composio connectors.
- Nobody has shipped Teach-a-task yet.

---

## 1. Your added requirement: any LLM you subscribe to

Two different things people mean by "subscribed":

| Kind | Examples | How we drive it |
|---|---|---|
| **API key / pay-per-token** | Anthropic, OpenAI, Google, xAI, OpenRouter, Ollama, LM Studio | Direct API driver (Vercel AI SDK). Easiest, fully featured (tools, vision, streaming). |
| **Consumer subscription** | Claude Pro/Max, ChatGPT Plus/Pro, Gemini Advanced, SuperGrok | No public chat API. Drive the vendor's **agent CLI** that is licensed for the subscription: Claude Code (`claude -p --output-format stream-json`, or the Claude Agent SDK), Codex CLI (`codex exec --json` / app-server), Gemini CLI, Grok Build. Speak **ACP (Agent Client Protocol)** where the CLI supports it. This is exactly what OpenMausBot does. |

**Design consequence:** the sandbox (browser / screen / shell / files) must be exposed as an **MCP server**, not as in-process tool functions. Then any driver can use it: API models get it as tool definitions, subscription CLIs get it as an MCP server in their config. One tool surface, every model.

**Check before shipping:** each vendor's terms on using a subscription CLI as a backend for your own app. Claude Code via Max is explicitly allowed for the Agent SDK; Codex/Gemini CLI are OSS and use your OAuth; re-check at build time.

**UI:** Settings → **Models**: provider cards, each with "Sign in" (runs the CLI login) or "API key". Default model for new Bots. Per-Bot override in the Bot profile (Grok Bot has no picker; this is the one deliberate deviation). Separate cheap-model setting for Auto Review and memory rewrite.

---

## 2. Big decision first: fork or greenfield

| Path | Time to Grok-Bot parity | Notes |
|---|---|---|
| **A. Fork Rakazo** (recommended) | 6–8 weeks | Already has roster, chat, sandboxes, routines, connectors, MCP, desktop + mobile, BYO model. Gaps to close: subscription-CLI drivers, Grok Bot's exact UI labels/flows, Auto Review, Vault, Teach-a-task, group chat polish. |
| **B. Greenfield** | 4–6 months solo with AI coding tools | Full control, no upstream drift. Plan below is written for this path; for path A, phases 1, 2, 5, 6 are mostly "already there". |

Recommendation: **A**, unless you specifically want to own every line. Either way the phase plan below is the parity checklist.

---

## 3. Architecture (greenfield)

```
apps/
  desktop/      Electron + React 19 + Vite + Tailwind + shadcn   (macOS/Win/Linux)
  mobile/       Expo (iOS/Android)                                (phase 10)
  server/       Hono + oRPC/tRPC, WebSocket/SSE event stream
packages/
  agent-runtime/   wake router, per-conversation queue, turn loop, SendToUser
  model-drivers/   api (AI SDK), cli-acp (Claude Code, Codex, Gemini, Grok Build)
  sandbox/         computer lifecycle; exposes MCP server: browser, screen, shell, files
  approvals/       Auto Review classifier + Custom Rules + card lifecycle
  memory/          per-bot + shared facts, background rewrite pass
  skills/          skill store (markdown + frontmatter), teach-a-task compiler
  routines/        scheduler (pg-boss or Graphile Worker), triggers, limits
  connectors/      Composio/Pipedream OAuth apps, MCP client, Vault autofill
  db/              Postgres + Drizzle (or Prisma)
infra/
  sandbox-image/   Docker: Ubuntu + Xvfb + Chromium + Playwright + node-pty + screencast
```

**Sandbox ("cloud computer"):** one container per user, started on demand, kept warm (fixes Grok Bot's "sleeps when idle" lateness). Inside: Xvfb with **one X display per Bot screen**, Chromium per screen under Playwright/CDP, node-pty shell, `/workspace` volume. Live view via CDP screencast → WebRTC/MJPEG to the desktop app. "Take control" = forward the user's mouse/keyboard events to that display (noVNC under the hood). Providers behind one interface: `docker` (local, default), `e2b`, `daytona`, `firecracker` (self-hosted later). Optional **private computer per Bot** (Rakazo has this; Grok Bot does not) to fix the shared-login problem.

**Agent runtime (copy Grok Bot's model):**
1. Every wake → `WakeEvent {source: user|routine|webhook|bot|background, conversationId, payload}` → router → per-conversation FIFO queue.
2. Turn = model call with system prompt (Bot role + memory + skills index + connectors) + tools (MCP from sandbox + connectors + `send_to_user` + `handoff_to_bot` + `save_skill` + `create_routine`).
3. Model may finish without calling `send_to_user` (quiet is allowed). User messages preempt background work.
4. Every tool call passes through **Auto Review** before execution.
5. After the turn: enqueue background memory rewrite.

**Model driver interface:**
```ts
interface ModelDriver {
  id: string;                // "anthropic:claude-sonnet-4-5", "cli:claude-code", "cli:codex"
  capabilities: { tools: boolean; vision: boolean; streaming: boolean };
  run(turn: { system: string; messages: Msg[]; tools: ToolDef[]; mcpServers?: McpServerConfig[] }): AsyncIterable<DriverEvent>;
}
// DriverEvent = text-delta | tool-call | tool-result | done | error
```

**Data model (Postgres):** `users, bots, conversations (1:1 | group), conversation_members, messages, activity_events, approvals, custom_rules, memories, skills, routines, routine_runs, triggers, connectors, vault_items, secrets, computers, screens, files, pages, model_providers, bot_model_overrides`.

---

## 4. Phases (greenfield; solo dev + AI coding tools)

Each phase ends with something you can click.

### Phase 0 — Decisions and scaffold (3–5 days)
1. Decide fork vs greenfield (section 2).
2. `pnpm` monorepo, Electron + React shell, Hono server, Postgres via Docker Compose, Drizzle migrations.
3. Auth: single local user first (Better Auth later for teams).
4. CI: typecheck, lint, Playwright smoke test.

### Phase 1 — Bots + chat + model picker (2–3 weeks)
1. Sidebar: Bot roster with Pin / Move to section / Hide from sidebar / Hidden Bots. First run creates a Bot named after the app.
2. "Create New Bot" dialog: name, picture (Bot / Generate / Upload ≤25 MB), label. Rename via right-click or double-click.
3. 1:1 chat with streaming, attachments (20/msg), reply-to, reactions, `@` mention popover, dictation stub.
4. Transcript renders activity events: tool activity, computer use, created files, questions, approval requests.
5. **Settings → Models**: provider cards (Anthropic, OpenAI, Google, xAI, OpenRouter, Ollama, Claude Code, Codex, Gemini CLI). API-key and "Sign in" (spawn CLI login). Default model; per-Bot override.
6. `model-drivers`: API driver via Vercel AI SDK; `cli-acp` driver for Claude Code (`stream-json`) and Codex (`exec --json`). Both yield the same `DriverEvent` stream.
7. Primary Bot flow: "Introducing your primary Bot" → Create / Choose existing / Confirm / Replace.

### Phase 2 — The computer (3–4 weeks)
1. Docker sandbox image: Ubuntu, Xvfb, Chromium, Playwright, node-pty, ffmpeg.
2. `sandbox` package: start/stop/update/recover/reset; `/workspace` persistent volume; one X display per Bot screen; one computer-use task per screen enforced with a lock.
3. **MCP server inside the sandbox** exposing: `browser.navigate/click/type/screenshot/read_page/find`, `screen.screenshot`, `shell.exec` (streaming), `fs.read/write/list`. This is the only tool surface the models see.
4. Computer view panel (right-hand): live screencast, status line, "Open computer", "Take control" (input forwarding), "I'm done", "Continue in Background", "Keep waiting", "Retry", "Reconnecting" state.
5. Settings → Computer: Bot's computer (Update / Recover / Reset), Your computer (Execution on this computer: Ask every time / Always allow / Never allow; Route traffic through this computer).
6. Local-execution tool: run a command on the user's desktop with per-command approval (Esc denies).

### Phase 3 — Agent loop + Auto Review (2–3 weeks)
1. `agent-runtime`: wake router, per-conversation queue, turn loop, `send_to_user`, quiet-allowed, user preemption, "Stop now".
2. `approvals`: classifier call (cheap model) on every tool call → allow / ask / deny-with-warning. Instruction-source boundary: only user messages are instructions; web/email content is data.
3. Custom Rules UI (20 allow + 20 ask-first, ≤1000 chars), ask-first wins, "Saved to Custom Rules".
4. Approval cards: Allow once / Always allow / Deny; terminal card: Allow / Skip / Manage settings; warnings; 30-min expiry → "Expired, the Bot didn't do the action".
5. Drafts: outbound email/Slack from background work → "Needs approval" draft with Send button.
6. Notifications list above the composer, sidebar states "Needs attention" / "Unread activity", OS notifications, dock badge.

### Phase 4 — Memory (1 week)
1. Per-Bot memory + shared user facts tables.
2. Background rewrite pass after each turn: ≤100 facts / ≤4000 chars, plus short-term notes.
3. Inject into system prompt. "What do you remember about me?" and "Forget that…" handled as tools.
4. Settings → General → Import → "Start Import" → "Add to Memory" (paste from another assistant).

### Phase 5 — Skills and Routines (2–3 weeks)
1. Skill = markdown with frontmatter (name, description, inputs, approval points). Tool `save_skill`. All Bots see the skill index; `/` and `@` pickers in composer.
2. Routines: tool `create_routine` from chat; fields owner Bot, schedule (cron) + timezone, event trigger, instruction, input source, approval boundary. Enforce 50/Bot, ≥5 min spacing, 300/hr account, 200/hr routine → "Automation run rate limit exceeded".
3. Scheduler: pg-boss (or Graphile Worker). Keep 20 run records per routine. Controls: Pause / Resume / Test / Edit / Delete. Bot details → Details tab lists routines with switch.
4. Triggers: webhook (POST URL + `Authorization: Bearer <key>`, 200 = accepted), Bot email address (inbound via Postmark/SES), Slack (mention / phrase / reaction / any), GitHub, Linear, Sentry, PagerDuty.
5. "Away too long" check: ask whether to keep routines running; pause on no answer.

### Phase 6 — Connect apps, Vault, MCP (2–3 weeks)
1. Connect apps screen: Browse / Installed / Needs auth / Authorize / Reconnect; "Added" ≠ signed in.
2. OAuth connectors via **Composio** (fast path, 500+ apps) with native fallbacks for Gmail, Calendar, Drive, Slack, Notion, GitHub.
3. MCP client: remote (HTTP/SSE) and stdio servers added by URL/command.
4. Vault (Settings → Vault): New item → Login / Card / Contact info, Hints, Import from CSV (1Password, Chrome, Safari, Firefox, Bitwarden, LastPass), Remove. Values encrypted at rest; autofill into the sandbox browser via CDP **without passing through the model**.
5. Secure Form + secret card ("Save securely"); login lookup order Vault → 1Password → Secure Form.
6. Human-only step detection (SSO/passkey/CAPTCHA/2FA/card) → "Take over" card.

### Phase 7 — Group chats and Bot-to-Bot (1–2 weeks)
1. "New chat" / Cmd+Shift+N → "To:" picker, 2–6 Bots. `@everyone`. Reply-to routes to one Bot.
2. `handoff_to_bot` tool → wake event in the target Bot's 1:1 queue; text-only; async reply.
3. Group rules: no approval cards, no secret requests, no drafts in groups; requester-only approvals; no "Always allow" on group cards.
4. Fix Grok Bot's known bug: replies must land in the conversation that woke the Bot.

### Phase 8 — Teach a task (2–3 weeks; nobody has shipped this yet)
1. In the computer view: "Teach a task" → describe the result → record ≤10 min. Capture CDP screencast frames + DOM events (click/type/navigate) + URLs; no audio.
2. Compiler: vision model summarises frames + events into a draft skill (steps, decision rules, validation, approval points).
3. Review draft → save. Mark "learned skill is a draft".

### Phase 9 — Files, Pages, voice, polish (2 weeks)
1. Result cards (file / image / link / tool result), preview, Download / Download all, conversation Library (Today / This week / Older / Pinned).
2. Pages: Bot builds a static page → card with "Open" → share: invite / team / anyone with link (hosted at a subdomain).
3. Dictation (Cmd+D) via local Whisper or provider STT; voice memo from Bot via TTS; voice chat optional.
4. Settings panes: General (Account, Appearance incl. accent "Bot color", Language, System, Bot: Timezone + Auto-review + Custom Rules), Computer, Vault, Models, Usage, Updates (auto-update via electron-updater).
5. Bot templates: Connect apps → Bot templates → Import Bot; Share a Bot → Create a copy → Publish → Copy link.

### Phase 10 — Mobile, hosted sandboxes, teams (later)
1. Expo app: chat, approvals (Approve once / Deny), computer view, routines view (Active / Schedule / Next run / Instruction / Run history), push.
2. Sandbox providers: E2B / Daytona / self-hosted Firecracker.
3. Teams: Better Auth orgs, Team Bots, Team Secrets, Slack app per Bot, audit log, network allowlists.

---

## 5. Time estimates

| Scope | Fork Rakazo | Greenfield |
|---|---|---|
| MVP (phases 0–3: Bots, chat, any model, computer, approvals) | 2–3 weeks | 6–8 weeks |
| Grok Bot parity minus mobile (0–9) | 6–8 weeks | 4–6 months |
| Full parity incl. mobile/teams (0–10) | 3 months | 6–9 months |

Assumes one developer working with Claude Code daily.

---

## 6. Risks to design around now

1. **Shared logins across Bots.** Offer private computers per Bot as an option from day one (cheap with Docker).
2. **Browser automation fragility.** Use accessibility-tree reads (`read_page`/`find`) before pixel clicks; verify outcomes; never report success without a check.
3. **Prompt injection.** Enforce the instruction-source boundary in the runtime, not only in the prompt.
4. **Idle sleep lateness.** Keep the container warm; wake it 60 s before a routine fires.
5. **Subscription-CLI terms.** Verify each vendor's policy; keep API-key path as the always-safe default.
6. **Spend runaway.** Per-account spend cap and per-routine wake filters (Builder.io saw 500–750 wakes/day from one unfiltered trigger).

---

## 7. First three actions

1. Clone and run Rakazo locally for one hour; decide fork vs greenfield.
2. Create the repo (or fork) and move this session into it.
3. Build Phase 1 step 5–6 first (model picker + two drivers), because it is the one thing Grok Bot does not have and it validates the MCP-sandbox design before the sandbox exists.

---

## Sources

Official: [docs overview](https://docs.x.ai/grok-bot/overview), [skills & routines](https://docs.x.ai/grok-bot/skills-routines-and-automations), [FAQ](https://docs.x.ai/grok-bot/faq), [approvals & security](https://docs.x.ai/grok-bot/approvals-security-and-privacy), [how it works](https://docs.x.ai/grok-bot/how-grok-bot-works), [bots](https://docs.x.ai/grok-bot/bots), [chat & collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration), [computer & apps](https://docs.x.ai/grok-bot/computer-and-apps), [files & results](https://docs.x.ai/grok-bot/files-and-results), [vault](https://docs.x.ai/grok-bot/vault), [settings](https://docs.x.ai/grok-bot/settings-and-notifications), [get started](https://docs.x.ai/grok-bot/get-started), [x.ai/bot](https://x.ai/bot) (403 to fetch).

Explainers: [DataCamp](https://www.datacamp.com/blog/grok-bot), [DataCamp tutorial](https://www.datacamp.com/tutorial/grok-bot-tutorial), [Vellum](https://www.vellum.ai/blog/official-grok-bot-breakdown), [Digital Applied](https://www.digitalapplied.com/blog/grok-bot-ai-teammates-launch-cloud-computer-2026), [Codersera](https://codersera.com/blog/grok-bot-complete-guide-2026/), [Kingy](https://kingy.ai/blog/what-is-grok-bot/), [TryFriday](https://www.tryfriday.ai/blog/grok-bot-launch), [kie.ai](https://kie.ai/blog/grok-bot-release-ai-builders), [AIToolsReview](https://aitoolsreview.co.uk/insights/grok-bot-agent-launch), [MindStudio](https://www.mindstudio.ai/blog/what-is-grok-bot), [Layer3](https://www.layer3labs.io/guides/what-is-grok-bot), [ToolRadar](https://toolradar.com/blog/what-is-grok-bot), [Developers Digest](https://www.developersdigest.tech/blog/grok-bot-computer-primitive-explained).

Reviews: [Dev.to](https://dev.to/aditi_gupta_8d81622a592aa/grokbot-honest-review-is-xai-and-cursors-computer-use-agent-worth-200-a-month-2924), [Builder.io](https://www.builder.io/blog/grokbot-review), [Emergent](https://emergent.sh/learn/grok-bot-review), [The Rundown](https://www.therundown.ai/tools/grok-bot), [Stork](https://www.stork.ai/en/grok-bot), [BigHat](https://www.bighatgroup.com/blog/grok-bot-review-ai-coworker-small-business/).

Open source: [Rakazo](https://github.com/elie222/rakazo), [OpenMausBot](https://github.com/milind-soni/OpenMausBot), [Bitdoze comparison](https://www.bitdoze.com/best-open-source-grok-bot-alternatives/), [aitoolly](https://aitoolly.com/zh/ai-news/article/2026-10-31-openmausbot-emerges-on-github-trending-as-an-open-source-grok-bot-alternative-with-dedicated-virtual).

---

## Decisions log

- **2026-11-08 — Build from scratch** (not a Rakazo fork). Repo: this one.
- **2026-11-08 — SQLite, not Postgres.** Desktop-first app; no daemon to run. Drizzle + better-sqlite3, schema bootstrapped with `CREATE TABLE IF NOT EXISTS`. Routines scheduler (phase 5) will be in-process cron rather than pg-boss.
- **2026-11-08 — npm workspaces** (pnpm's corepack install was broken on the dev machine).
- **2026-11-08 — Subscription drivers verified:** Claude Code CLI (`-p --output-format stream-json --include-partial-messages --setting-sources "" --resume`) and Codex CLI (`exec --json -m gpt-5.6-sol`, model slugs read from `~/.codex/models_cache.json`). Gemini CLI's free tier was discontinued on the dev machine, so that driver is best-effort; Google goes through the API-key path.
- **2026-11-08 — Vercel AI SDK** for all API-key providers (one streaming/tool interface). Default Anthropic model `claude-opus-5-5`.
- **Phase 1 shipped:** Bots CRUD, roster (pin/section/hide/primary), Create New Bot dialog, 1:1 chat with streaming parts (text, reasoning, tool call/result), Settings → General + Models, per-Bot model override, encrypted key storage.
- **2026-11-08 — Phases 2–5 built in parallel** (sandbox worker, desktop worker, server/runtime by the lead):
  - Computer: Playwright Chromium, one BrowserContext + Page per Bot screen (1280×800), CDP screencast → WebSocket → canvas; Take control forwards mouse/keyboard; shell runs in `data/workspace`; files sandboxed to the workspace. Docker/Firecracker providers deferred: the host-local computer is "provider 0".
  - One tool surface: the computer + skill/routine tools are exposed to API drivers as tool defs and to CLI drivers as an MCP server at `/mcp/:botId` (Streamable HTTP via @hono/mcp). Every call passes `AgentRuntime.callTool` → Auto Review.
  - Auto Review: built-in safety checks (dangerous shell patterns, outbound-looking clicks) → Ask-first rules → Allow rules → read-only tools → optional review model (`utilityModelRef`) → default (shell asks, browsing allowed). Cards: Allow once / Always allow (saves rule, max 20) / Deny; 30-min expiry.
  - Memory: `memories` table, per-Bot facts (≤100 / 4000 chars) + shared user facts; background rewrite 15 s after a turn, using the review model if set, else the Bot's model.
  - Skills: markdown in DB, tools skill_list/read/save, index in the system prompt. Routines: croner scheduler, limits 50/Bot, ≥5 min spacing, 200/hr per routine, 300/hr account, 20 run records; triggers schedule / webhook (`POST /api/hooks/:id`, bearer key) / manual; routine runs post a system message into the Bot's chat and run a turn.
- **2026-11-08 — Phase 7 (group chats, Bot-to-Bot):** group conversations (2–6 Bots) route a user message to @mentioned Bots, @everyone, or the primary/first member; other Bots' messages reach a model as user-side turns labelled "[Name]: …"; a Bot replying exactly `[no reply]` is deleted ("quiet is allowed"); a Bot's reply that @mentions teammates wakes them, capped at 6 Bot-initiated wakes per user message. `bot_message` hands work to another Bot's 1:1 chat ("Message from X: …" system message) with the same cap. Codex driver fix: `exec resume` rejects `--sandbox`, so the sandbox is passed as `-c sandbox_mode="read-only"`.
- **2026-11-08 — Phase 6 (Vault, Secure Form, Connect apps):** `vault_items` keep public columns + one AES-GCM blob of secret fields; the model only ever sees titles/websites/usernames (`vault_list`) and asks the server to use a value (`vault_fill` → `ComputerService.fillSecret`, `shell_run_with_secrets` → hidden `_env`). `request_secret` posts a Secure Form card; the answer is saved to the Vault and the Bot gets a handle, never the value. Connect apps = user-added MCP servers (http or stdio) proxied as `<app>__<tool>`; read-looking tool names pass Auto Review, the rest ask. Templates: GitHub, Linear, Notion, Sentry (hosted), Slack, Gmail, Google Calendar, local folder (stdio).
- **Known gap — Codex + MCP:** `codex exec` cancels every MCP tool call ("user cancelled MCP tool call") regardless of `approval_policy`, `trusted`, or `--disable guardian_approval`. Codex Bots can chat and be handed work but cannot use the computer yet. A prompt-level tool loop was added (`prompt-tools.ts`: tool catalogue in the prompt, `<<tool>>…<</tool>>` blocks, `exec resume` per step) and Gemini CLI uses it too, but Codex prefers its own built-in fetch/shell tools and does not emit the block, even with `features.apps=false`. Codex Bots: chat + handoff only until Codex exposes a tool-approval setting for `exec`.
- **2026-11-08 — Phase 9 (files, results, notifications):** uploads (`POST /api/uploads`, multipart) are stored under `data/files/<id>` and copied into the workspace (`attachments/<msg>/`) so Bots read them with `fs_read` / look at images with `attachment_view`; `fs_write` results become `file` parts (result cards served at `/api/workspace?path=`); a `notify` event fires on replies and approval requests, the Electron main process shows OS notifications and a dock badge through the preload bridge. The Electron app now starts the local server itself (dev: tsx; packaged: `apps/server/dist`), with data in the OS user-data dir.
- **2026-11-08 — Phase 8 (Teach a task):** recording = the user drives the Bot's screen (Take control) while the sandbox logs clicks/typing/navigation with element descriptions and captures up to 40 jpeg frames (10 min max); on stop the runtime writes `teach/<id>/events.json` + frames into the workspace and wakes the Bot with a system message asking it to study them (`attachment_view`) and `skill_save` a draft skill. No audio, no video upload: the model sees an event log plus key frames.
- **2026-11-08 — Verified end to end** (`scripts/smoke.py`, all pass with chat): health/providers, Bot + conversation, routine limits, webhook auth + run, Vault (secrets hidden) + CSV import, uploads/downloads, MCP initialize, chat reply, file result card. Teach a task verified manually: 3 events + 2 frames → Bot read `events.json`, viewed frames, `skill_save` with `taught: true`.

## What is left (after Phase 9)

1. **Sandbox providers**: Docker image (Xvfb + Chromium) and a Firecracker/E2B option so Bots don't run on the host. The `ComputerService` already isolates everything behind one class.
2. **Codex tool use**: blocked on Codex `exec` cancelling MCP calls; revisit when Codex exposes an MCP approval setting or an app-server mode we can drive.
3. **Mobile (Expo)**: chat, approvals, computer view, routines; the server API and WebSocket are already the only contract.
4. **Teams**: Better Auth orgs, shared Bots, Team Secrets, audit log, Slack app per Bot.
5. **Voice**: dictation and voice memos (local Whisper or provider STT/TTS).
6. **Polish**: edit routine form, memory import UI, Pages hosting, usage/billing pane, auto-update, code signing + notarization (the build is unsigned), Intel build (arm64 only today).

### Packaging (done 2026-11-08)

`npm run dist` → `apps/desktop/release/Cadre-0.1.0-arm64.dmg`. `scripts/bundle-server.mjs` esbuilds the server into one CJS file with `better-sqlite3` and `playwright` external, installs those two into a private folder and rebuilds sqlite with `@electron/rebuild`; electron-builder ships that folder as `Resources/server/deps` (its extraResources filter drops any `node_modules` dir, hence the rename + `NODE_PATH`). Electron main runs the bundle with `ELECTRON_RUN_AS_NODE`, adopts the login-shell PATH so the model CLIs resolve from Finder launches, and keeps data in `~/Library/Application Support/Cadre/data`. Verified: packaged app boots its server, Playwright computer loads example.com, full `smoke.py` passes (Claude chat + file card).

### Templates, Chief of Staff, phone (done 2026-11-08)

Templates live in `packages/agent-runtime/src/templates.ts` (24 Bots, 5 squads; the 10 "Both Ways" Bots added 2026-11-08 have palindrome names); `instantiateTemplate` is shared by `POST /api/templates/:id/create`, squads and `bot_hire`. Bots gained `brief` (system prompt) and `hiredBy`; a `tasks` table backs the task board (`/api/tasks`, `task_*` tools). Team tools are in `team.ts` and are only offered to the primary Bot. Phone access is `apps/server/src/access.ts`: token in `data/access.json`, cookie sign-in, loopback-only `/api/access` and `/mcp`, Host-header check against DNS rebinding, CORS limited to localhost origins; the server also serves the built renderer (packaged: `Resources/renderer`). Verified live: Founder Mode squad intros (Contra red-teamed Chief's plan unprompted), Chief hired Hawk from the Deal Hunter template, Hawk checked Amazon in its browser, closed the task, Chief was told automatically and reported the price. Deleting a Bot now disarms its routines and hands its tasks back to the user.

### Tidewater redesign (done 2026-11-08)

Picked A · Tidewater from `docs/design/redesign-options.html`, with both themes. Tokens in `apps/desktop/src/renderer/src/index.css` (`:root` = day, `[data-theme=dark]` = night; aqua `--accent`, amber `--signal` for anything waiting on the user). Fonts bundled with @fontsource (Instrument Serif, Inter Tight, JetBrains Mono) so the offline app needs no network. Layout: icon rail (`Rail.tsx`), Team roster with a Lead section (`Sidebar.tsx`), serif chat header with the Chief's team orbit, event cards for handoffs/hires/tasks/routines, markdown replies (`Markdown.tsx`, react-markdown + GFM tables), and the Team pulse panel (`TeamPanel.tsx`: live screen, task board with add/done, next routines; `GET /api/routines`). Theme toggle on the rail and in the phone drawer; zoom presets in Settings → General plus ⌘=/⌘-/⌘0 and pinch.

### QA pass (2026-11-08)

Tested every control in the built renderer against an isolated server (port 3190, scratch data) and inside the packaged Electron window over the remote-debugging port (CDP). Found and fixed: New group chat crashed the app (zustand selector returning a new array → React #185); Rename Bot / Move to section / Rename group used `window.prompt`, which Electron does not support (now `askText()` + `AskDialog`); Copy on the Phone pane used the browser clipboard (now Electron's clipboard over IPC); links could navigate the app window away (now `will-navigate` opens them externally, downloads pass); Bots had no way to edit their role brief (now in Bot details); stale "phase 9" placeholder text. Zoom baseline: displayed 100% = Chromium 125% (`ZOOM_BASE` in main; zoom.json stores `display`). A drag-region audit (clickables whose centre's last app-region is `drag`) runs in the real window: nothing blocked in main view, menus, dialogs or popovers.

Not built: Usage & Billing, auto-update (panes say so). MAX_TEAM_SIZE is 30.

### 2026-11-08: provider Off switch, live model lists

- `provider_configs.disabled`: Settings → Models → **Turn off** / **Turn on** per provider. A turned-off provider shows status `off`, lists no models, is skipped by the auto default, and `DriverRegistry.get` hands out a `DisabledDriver` whose turns fail with "X is turned off…". Nothing is signed out.
- Model lists: Codex reads `~/.codex/models_cache.json` (default = first listed, GPT-6.1-Sol today); Gemini parses `VALID_GEMINI_MODELS` from the installed CLI's `gemini-cli-core/dist/src/config/models.js`; Claude stays on the `opus/sonnet/haiku` aliases (always the newest of each tier).
- `ModelPicker` is now a `<select>` plus "Other model id…". The old `<datalist>` filtered options by the typed value, so only the current model ever showed.
- Codex binary: `codexBinary()` picks the newest `codex` on the Mac (PATH, `~/.local/bin`, the standalone install, or the copy inside `ChatGPT.app`). They share `~/.codex` and its ChatGPT sign-in. The standalone 0.146 CLI rejects GPT-6.x with `model_not_found`; the ChatGPT app's 0.166 accepts it. All Codex clients overwrite `models_cache.json`, so `listModels` only trusts a cache whose `client_version` is not newer than the binary in use.
- Type scale: small sizes raised ~1.5px across the renderer (10.5→12, 12→13.5, 13.5→15), and Tailwind `text-xs`/`text-sm` overridden to 13.5px/15px, on top of the 125% zoom baseline.

### 2026-11-08: one-click Connect apps

- Remote app servers sign in through the browser (OAuth 2.1 + dynamic client registration). `ConnectorManager` implements the SDK's `OAuthClientProvider`; client, tokens, PKCE verifier and discovery state live encrypted in `connectors.auth_enc`. The app redirects to `GET /oauth/callback` on this server, which calls `finishAuth` and reconnects. Streamable HTTP first, SSE fallback. `POST /api/connectors/templates/:name/connect` is the one-click route; `POST /api/connectors/:id/signout` forgets the sign-in.
- Catalog (27 apps), each probed live on 2026-11-08 to return a real sign-in link: Jira & Confluence (Atlassian v2), Trello, Linear, Todoist, Calendly, Fireflies, Granola, Zapier, Notion, Airtable, Webflow, Wix, Sentry, Vercel, Netlify, Supabase, Cloudflare, PostHog, Hugging Face, Stripe, PayPal, Square, Intercom. GitHub takes one pasted token. Gmail, Google Calendar, Slack and Outlook connect through Zapier (`connectAs`).
- Not one-click without registering Cadre with the vendor: Google's own Gmail/Calendar/Drive MCP (Developer Preview, no DCR, restricted scopes need verification), Slack (Marketplace only), GitHub OAuth, Asana v2, HubSpot, Microsoft 365, Box, Zoom, Figma. ClickUp, monday.com and Dropbox gate unknown clients.
- Verified: full sign-in round trip against a mock OAuth MCP server (register → PKCE → callback → tokens → connected), sign-in survives restart, sign out works.
- Direct Google (Gmail, Google Calendar, Google Drive): Google has no dynamic client registration, so the owner registers Cadre once (Connect apps → Gmail → "Set up Google (one time)": Cloud project, Workspace MCP APIs, published consent screen, Web OAuth client with redirect `http://localhost:3123/oauth/callback`) and pastes the client ID and secret (`oauth_clients` table, secret encrypted). Connectors marked `oauthApp: "google"` use that client instead of DCR, ask for sign-in up front (Google lists tools without auth), narrow `scope` to the template's scopes and add `access_type=offline&prompt=consent` so a refresh token is issued. Zapier stays as the fallback ("Use Zapier instead"). Verified against a Google-like mock (no DCR, client_secret_basic) and by building real accounts.google.com sign-in links; a real Google sign-in needs Damien's OAuth client. Jira via Atlassian was signed in for real by Damien on 2026-11-08 (26 tools).

### 2026-11-08: ChatGPT Bots get native tools; Stop and restart fixes

- Codex driver is now `toolMode: "mcp"`. Cadre's MCP endpoint is attached per turn with `-c mcp_servers.cadre_computer.url=…`, `default_tools_approval_mode="approve"` (Codex otherwise fails MCP calls under `approval_policy="never"`) and `tool_timeout_sec=900` (room for Cadre's own approvals). Cadre's Auto Review still gates every call server-side. Before this, tools were a text protocol in the user prompt and GPT-6.1 ignored it ("this session doesn't expose Bot-hiring"). Verified: a ChatGPT Chief hired a Deal Hunter via `bot_hire`.
- Instructions go in as `developer_instructions` on a new Codex thread. Codex keeps the first thread's developer instructions on resume, so later turns prepend `<cadre_context>` when the system prompt changed (e.g. the Chief's team snapshot). Threads are tagged `v2:` in `driver_sessions`; untagged (old text-protocol) threads are replaced by a fresh thread carrying the transcript.
- Codex `mcp_tool_call` items map to tool cards; Codex `error` items (config warnings) are dropped.
- Stop: if nothing is running, `POST /api/conversations/:id/stop` marks the chat's still-streaming replies stopped. Startup marks every leftover `streaming` reply stopped (a restart mid-reply used to leave typing dots forever).

### 2026-11-08: end-to-end gate (`npm run e2e`)

`scripts/e2e.py` runs real model turns (default `codex:gpt-6.1-sol`) against a fresh server plus a fake OAuth app (`scripts/e2e/mock-app.mts`), then the API smoke suite. 19 checks: app sign-in, app tool inputs arrive, read-only app tools skip approval, data-changing ones wait for Allow, the Chief has no app/browser tools and delegates with task_create (no polling, relays once), hiring on request, Stop ends the reply and the model process, restart cleans up cut-off replies. Passed 19/19 twice on 2026-11-08 before install. Run it before every install.

Fixes it caught: the MCP route registered connector tools with an empty zod shape, so the SDK stripped every argument (Jira search got no query); it now uses the low-level Server with each tool's real JSON schema. App tools annotated `readOnlyHint` skip approval. The Chief (primary Bot) loses browser/shell/connector tools and gets a standing "you manage, the team does the work" rule every turn.

### 2026-11-08: OpenCode provider, Gemini fix, child-process cleanup

- OpenCode (`opencode run --format json`) is a CLI provider, `toolMode: "mcp"`. Isolated: `XDG_CONFIG_HOME` points at `DATA_DIR/opencode-config`, so the user's own OpenCode config (MCP servers such as Home Assistant) never loads, while sign-ins in `~/.local/share/opencode` still work. Each turn passes `OPENCODE_CONFIG_CONTENT` with Cadre's MCP server and a `cadre` agent (system prompt re-sent every turn; `tools: {"*": false, "cadre_*": true}`). Models come from `opencode models --verbose`, filtered to tool-capable chat models, free first (53 on Damien's Mac). OpenCode's free models have a usage limit (hit on 2026-11-08 after a few test calls; ~87k input tokens per call); after a provider error `opencode run` hangs, so the driver reads `--print-logs` ERROR lines, stops the process and shows the error.
- Gemini: `--approval-mode plan` now needs `experimental.plan`; switched to `default`, which headless Gemini treats as read-only (drops every tool needing approval).
- `spawnJsonl` kills a CLI's child processes first (synchronously, before they get re-parented) and stops waiting 2 s after a kill or exit, so Stop and errors end promptly even when helpers hold stdout open.
- Tested offline only (Damien: no live model tests): fake `opencode`/`codex` binaries replay recorded output; API smoke passes.

### 2026-11-08: Gemini native tools, Spaces, OpenCode free-model fix

- Gemini driver is `toolMode: "mcp"`: per run, a private settings file via `GEMINI_CLI_SYSTEM_SETTINGS_PATH` (merged over the user's settings, untouched) lists Cadre's MCP server with `trust: true` (headless Gemini denies any tool that would ask), `--allowed-mcp-server-names cadre`, and `GEMINI_SYSTEM_MD` carries Cadre's system prompt. Parses the documented stream-json events (init/message/tool_use/tool_result/error/result). Verified against Gemini CLI 0.30 source and a fake-binary replay only.
- Spaces: `spaces` table (name, emoji, defaultModelRef), `bots.space_id`. First run creates Work and Personal; existing Bots go to Work. Model order: Bot model → space default → app default. One lead (Chief) per space; moving a Bot never makes it lead, and new Bots don't lead unless they are the very first Bot or a Chief template hired into a lead-less space. Team tools, snapshot and hires are scoped to the Chief's space. UI: space buttons on the rail (chips on phone), roster/groups/task board/Next up filtered, Settings → Spaces, Bot details → Space, sidebar "Move to …" and "Make lead of …". Smoke suite has 10 space checks.
- OpenCode: `"*": false` in the agent's tools made OpenCode's free models answer "Free usage limit reached … Free models work in OpenCode" while the same models worked in the user's OpenCode seconds later. Now only shell/edit/write/patch/task/todo are off; read-only OpenCode tools stay on. Not yet confirmed with a live call (Damien: no model tests).
- Builds use `electronDist: ../../node_modules/electron/dist` (no checksum download; GitHub 504s broke three builds).
- Default model, made visible: `GET /api/settings/default-model?spaceId=` returns the model a Bot with no model gets and why (`space` | `app` | `auto`). With nothing set, the automatic pick is the first provider that is on (Claude first, so a fresh install uses Claude Opus). Defaults whose provider is turned off are skipped; a Bot's own model is kept so the Bot can say its provider is off. UI: Settings → Models shows "Automatic (now …)" and an explanation; ready provider cards have Make default and a Default badge; Bot details offer "Use … as the default for all Bots"; every "Default" option names the model it resolves to.
- Chat images in the Mac app: the renderer's CSP had `img-src 'self' data: blob:`; the packaged page is `file://`, so every `http://localhost:3123/api/files/…` image was blocked (phones were fine: same origin). CSP now allows `http://localhost:*` and `http://127.0.0.1:*` for img/media, and a failed image falls back to the file chip. Verified in the packaged app (1536×864 photo rendered).
- Hiring limits are user settings (`hireLimitPerDay`, `teamSizeLimit`, 0 = no limit, the default) in Settings → Spaces → Hiring; counted per Chief (the old hard-coded 5/day counted every Chief together). OpenCode's free DeepSeek model confirmed working in Cadre on 2026-11-08 after the read-only-tools change.

### 2026-11-12: OpenCode 2.x support

- The OpenCode CLI driver now detects the installed major version (`opencode --version`) and uses the right command and config shapes, so 1.x keeps working while 2.x is supported.
- **Command line:** 2.x wants global flags before the subcommand, lowercase log levels, and no `run --dir`; each turn now runs `opencode --standalone --print-logs --log-level error run --format json …` (1.x keeps its original `run … --dir`). `--standalone` is required or the CLI reuses a background server that never saw the turn's config and fails with `Agent not found: "cadre"`.
- **Config:** 2.x moved MCP servers to `mcp.servers` with `disabled`/`codemode`/object `timeout`; the `cadre` agent moved to `agents`; and tool gating uses a `permissions` rule list (`shell`, `subagent`) instead of `agent.tools` + `permission`. 1.x keeps its old shape. `codemode: false` keeps Cadre's MCP tools on the model's native tool list instead of wrapping them in 2.x's `execute` Code Mode.
- **Isolation:** 2.x ignores `XDG_CONFIG_HOME` and reads `OPENCODE_CONFIG_DIR`; both are set now so the user's own config never merges into a Cadre turn.
- **Project folder:** 2.x takes the project folder from `$PWD`, not the process cwd. Electron inherits `PWD` from the dev server (in development `apps/desktop`), so the driver overrides `PWD` with the Bot's sandbox folder; otherwise OpenCode treats the sandbox as an external directory and its own `read`/`glob` tools are denied. Existing OpenCode sessions keep the folder they were created with, so a session started before this fix stays stuck until the conversation is reset.
- **Models:** 2.x dropped `opencode models --verbose`. The driver tries `--verbose` first (1.x, nicer labels), then falls back to plain `opencode models` and parses the `provider/model` lines, free `opencode/*` models first (12 free on a clean install).
- Verified live on OpenCode v2.2.6: provider ready, 385 models listed, chat + session memory, and both Cadre's MCP tools (`fs_list`, `fs_read`, `shell_run`) and OpenCode's own `read`/`glob` working inside `~/Cadre`.

## Sandbox folder (~/Cadre)

Bots change files freely in one folder and nowhere else.

- **Where:** `~/Cadre` (set by the desktop app through `WORKSPACE_DIR`; dev servers keep `DATA_DIR/workspace`). On first start the old `DATA_DIR/workspace` moves there and a link is left at the old path. It never merges into a folder that already has files.
- **Codex:** `sandbox_mode="workspace-write"`, the sandbox as the only writable root, internet on (installs). Read-only when there is no sandbox folder.
- **OpenCode:** edit/write tools on, `permission.edit=allow`, `external_directory=deny` (nothing outside the project folder), shell off (OpenCode does not confine its shell).
- **Claude Code:** built-ins `Read,Glob,Grep,Edit,Write`; edits allowed only by `Edit(//<sandbox>/**)`; no Bash.
- **Gemini / API:** unchanged; they use Cadre's tools (`fs_write` is sandbox-only, `shell_run` asks first).
- **Prompt:** every working Bot (not the Chief) gets a "Your sandbox" section: clone projects in, work on the copy, a not-writable folder outside is expected, change things outside only when asked and only via `shell_run`.
- Tests: `codex sandbox` probe (write inside ok, outside blocked, clone + internet ok), `opencode debug agent` rule check, fake-CLI replays of all three drivers, folder-move cases, smoke suite.

## About you (Bots learn who the user is)

One profile of the user, shared by Bots, that the user can see and edit (Settings → About you).

- **Sections:** Who you are, What you like and don't, Your routines, People and places, How you like things done. Up to 120 facts.
- **Scope:** each fact is for every space or one space (Work-only colleagues and projects stay out of Personal Bots' prompts). Deleting a space moves its facts to every space.
- **How Bots learn:**
  - `remember_about_user` / `forget_about_user` tools: saved at once when the user says something lasting ("remember I'm vegetarian").
  - The after-chat memory pass now returns add / update / remove changes (not a full rewrite), so facts no longer disappear. It may only change facts it learned; facts the user wrote, edited or told a Bot are never changed by it.
  - Settings → About you → "Learn about me from chats" pauses the pass (tools still work when asked).
  - "Get interviewed": the space's Chief asks one question at a time and saves the answers.
- **Using it:** every Bot's prompt carries the profile for its space, grouped by section, with instructions to tailor suggestions, plan around routines and offer to turn recurring asks into routines.
- **UI:** a chip ("Learned about you: …") appears when the pass adds something; click to review.
- Storage: `memories` rows with `bot_id NULL`, new columns `category`, `space_id`, `source` (`learned` | `you`). Existing user facts became "Who you are", every space, learned.
- Tests: offline unit test with a fake model (25 checks, including a migration on a copy of the real database) and smoke checks for the API and MCP tool list.

## Teammates talk to each other (within a space)

- Every Bot's prompt lists its teammates in the same space (name and role, the Chief marked) and how to work with them. Bots in other spaces are out of reach.
- `bot_message` finds teammates in the sender's space only, by exact or unique partial name; another space's Bot gets a clear refusal.
- Answers come back on their own: when the asked Bot finishes, its reply is posted in the asker's chat as "Reply from <name>: …" and the asker wakes to carry on. Skipped for `[no reply]` and when the Bot already answered with `bot_message`. The existing 6-turn Bot-to-Bot limit (`MAX_BOT_CHAIN`) still stops loops.
- Chat shows these as "Reply" cards next to "Handoff" cards.
- Tests: offline runtime test with a fake model (12 checks: roster scoping, delivery, partial names, cross-space refusal, no duplicate or looping replies); smoke suite.

### Group discussions

- A user message with `@everyone` in a group starts a discussion: every member gives an opening reply, then a reply that @mentions nobody passes the turn to the member who has gone longest without speaking. An @mention still picks who goes next.
- No fixed turn limit in groups. Every 6 Bot turns (`CHIEF_CHECK_EVERY`) the Chief (a member, else the space's Chief) gets a private check-in note (not saved to the transcript): `[carry on]` lets it continue silently; anything else is the Chief stepping in, which ends the discussion.
- Loop catch: if a Bot message nearly repeats one of the last few (word-overlap ≥ 0.6), the Chief steps in at once with a "Wrap-up" card and a summary.
- A discussion also ends when a Bot hands back with `[over to you]` (stripped from the shown text) or when every other member in a row has nothing to add (`[no reply]`). The user's next message starts fresh.
- `MAX_BOT_CHAIN` (6) still limits `bot_message` chains between 1:1 chats.
- Tests: offline discussion test with a fake model (16 checks: rotation, no cap, private check-ins, step-in, loop catch, hand-back, all-quiet, @mention, plain @Name).

## Sandbox commands run without asking

- Auto Review step "Sandbox": with `settings.sandboxAutoRun` (default on, Settings → Bot), `shell_run` runs unasked under macOS `sandbox-exec`. Writes are allowed only in the sandbox folder, temp folders and package-manager caches; reading anywhere and the network still work.
- Still asks: built-in safety checks (rm -rf, git push, sudo…), the user's Ask-first rules, commands with effects outside the Mac (`hasOutsideEffects`: cloud writes, terraform/kubectl/helm changes, deploys, publishing, global installs, osascript, POSTing curl), and calls with `outsideSandbox: true`. An approved command runs unconfined.
- A blocked write tells the Bot to retry with `outsideSandbox: true` (which asks).
- Tests: offline (30 checks, including real confined runs).

## Group members

- The group menu lists members with ✕ (min 2) and "Add a Bot" (same space only, max `MAX_GROUP_BOTS` = 10). The Chief has `group_invite` in group chats, then @mentions the new member.
- Joins and leaves post "Added:/Removed:" cards; new members see the whole history.
- Handoffs re-read the member list after the turn, so an invited Bot can be @mentioned in the same reply.
- A Bot woken by a message it already answered skips the turn; a turn never reaches a model ending with the Bot's own message; a discussion never hands the turn back to whoever spoke last.
- Tests: offline group members (19 checks) and own-last (5 checks); member API checked against a throwaway server.

## Chief runs multi-Bot jobs in a group

- Chief tool `group_create {title, bots, brief}`: creates a group (the Chief plus those Bots, same space), posts the brief as the Chief's first message and wakes the Bots it @mentions (all of them if none). The group-start alert points at the group.
- While a Bot works in a group, `bot_message` and `task_create`/`task_update` handoffs to members are posted in the group ("Message from A to B: …") and wake the member there. The Chief messaging a non-member adds it to the group first. Answers from Bots outside the group come back to the group as "Reply from …".
- Task alerts (`needs you`, done/blocked) and approval cards point at the group the Bot is working in (`conversationFor`). Members are told to @mention the Chief when their part is done.
- Tests: offline job test (18 checks).

## Approvals: Auto mode and rule matching

- Auto mode (= `autoReview` off): a ⚡ Auto button in every chat header, "Turn on auto mode" on approval cards, and Settings → Bot. Bots act without asking; only the built-in can't-undo checks (rm -rf, git push, sudo, curl | sh, ssh…) still ask. Turning it on also allows waiting cards that have no warnings.
- Custom rules match at the start of a word: "rm " no longer matches "terraform ", "pay" no longer matches "display".
- "Always allow" no longer saves a duplicate rule, and exact duplicates are removed at start.
- Tests: rules test (14 checks, including the user's live rules).

## Quieter transcripts

- A reply's tool calls, results, thinking and status lines fold into one row: "Thinking…" / "Working…" with a spinner while running, "Worked · N steps" (tool names, failures) when done. Click to see each step. Text, files, approvals and secure forms stay visible.

## Connector tokens: Basic auth

- A connector token is turned into the Authorization header by `authorizationHeader`: "Basic …"/"Bearer …"/"Token …" are sent as typed; `user:token` (or its base64) is sent as Basic (Jenkins needs this, and treats a Bearer header as anonymous); anything else is Bearer.
- Tests: 11 checks, including a fake server receiving the header.
