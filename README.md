# Cadre

Open, model-agnostic AI teammates in the shape of xAI's Grok Bot: named **Bots** with their own chat and memory, a shared computer (browser, shell, files), skills, routines, approvals, a Vault, group chats and Bot-to-Bot handoffs. You choose the model: any API key, or the Claude / ChatGPT subscription you already pay for.

See [docs/PLAN.md](docs/PLAN.md) for the research, roadmap and decisions log.

## Install on a Mac

```bash
npm install
npm run dist           # builds apps/desktop/release/Cadre-<version>-arm64.dmg (+ .zip)
```

Open the DMG and drag **Cadre** to Applications, or `cp -R apps/desktop/release/mac-arm64/Cadre.app /Applications/`. The app bundles the server (Electron's Node runs it; SQLite and Playwright are rebuilt for the Electron ABI by `scripts/bundle-server.mjs`). Data lives in `~/Library/Application Support/Cadre/data`. The build is unsigned: on another Mac, right-click → Open the first time, or `xattr -dr com.apple.quarantine /Applications/Cadre.app`.

Bots use the Chromium that `npm install` fetched into `~/Library/Caches/ms-playwright`; on a Mac without it run `npx playwright install chromium` once. Model CLIs (claude, codex, gemini) are found through your login-shell PATH.

## Templates, Chief of Staff, phone

- **Models:** Settings → Models lists every provider. Subscriptions (Claude, ChatGPT, Gemini) are picked up from their signed-in CLIs; each card has **Turn off** so Cadre stops using it without signing you out. Model lists come live from the Codex and Gemini CLIs.
- **Templates:** ⌘N opens a gallery of 24 ready-made Bots (Chief of Staff, Inbox Concierge, Market Scout, Deal Hunter, Repo Sentinel, Uptime Watch, Life Admin, Habit Coach, Tutor, Devil's Advocate, Backcaster, Decision Log, Fact Checker, Reconciler, Expiry Watch, Kin Keeper, …) and 5 squads. Each comes with a role brief, cron routines, skills and Auto Review rules, then introduces itself and asks its setup questions.
- **Chief of Staff:** the primary Bot sees a live team snapshot every turn and gets team tools: `team_overview`, `bot_read`, `bot_hire` (template or custom role, 5 hires a day, 30 Bots max), `bot_update`, `bot_retire`, `routine_assign`. Every Bot shares the task board (`task_create`, `task_update`, `task_list`); finishing a task tells whoever delegated it.
- **Phone:** Settings → Phone shows a QR code. Same Wi-Fi (or a VPN mesh address); the link signs the phone in with a cookie. Without it the server answers 401; the MCP endpoint and the QR itself are Mac-only. Regenerate the link to sign every phone out.
- **Look:** Tidewater design, day and night themes (sun/moon on the rail, or Settings → General).
- **Zoom:** ⌘= / ⌘- / ⌘0, pinch, or Settings → General; remembered between launches.

## Run it in development

```bash
npm install
npm run dev:desktop    # Electron app; it starts the local server itself (SQLite + files in the OS user-data dir)
```

For development with a separate server and live logs:

```bash
npm run dev:server     # API + WebSocket on :3123, data in ./data
npm run dev:desktop
```

First run: press **⌘N** to create a Bot, then tell it its job in the first message.

## What works today

| Area | Status |
|---|---|
| Bots, roster (pin / section / hide / primary), 1:1 chat with streaming | ✅ |
| Model picker: default model + per-Bot override; API keys stored encrypted | ✅ |
| Claude subscription (Claude Code CLI, session resume, MCP tools) | ✅ |
| ChatGPT subscription (Codex CLI) | chat + handoff only (Codex cancels MCP tool calls non-interactively) |
| Anthropic / OpenAI / Google / xAI / OpenRouter / Ollama via API | ✅ (tools via native tool calling) |
| The Bot's computer: Chromium screen per Bot, live view, Take control, shell, workspace files | ✅ (host-local; Docker/Firecracker providers later) |
| Sandbox folder `~/Cadre`: Bots edit freely inside, read-only outside (Codex, OpenCode, Claude Code) | ✅ |
| About you: Bots learn who you are, what you like, your routines; see and edit it in Settings | ✅ |
| Auto Review approvals: cards, Always allow → Custom Rules, built-in safety checks, review model | ✅ |
| Memory (per-Bot facts + shared user facts, background rewrite) | ✅ |
| Skills (`/` picker) and routines (schedule / webhook / manual, limits, run history) | ✅ |
| Vault (logins, cards, contacts, secrets; CSV import) + Secure Form cards | ✅ |
| Connect apps: any MCP server (hosted or local), templates for GitHub, Linear, Notion, Sentry, Slack, Gmail, Calendar | ✅ |
| Group chats (2–6 Bots, @mentions, @everyone, quiet replies) and `bot_message` handoffs | ✅ |
| Attachments, result-file cards, Library, OS notifications + badge | ✅ |
| Teach a task (record once on the Bot's screen → draft skill) | ✅ |
| Mobile apps, teams/shared Bots, voice | later |

## Pick a model

Settings (⌘,) → **Models**:

| Provider | How |
|---|---|
| Claude (subscription) | Uses the `claude` CLI already signed in on this machine (`claude` → `/login`). |
| ChatGPT (subscription) | Uses the `codex` CLI (`codex login`). Model list comes from Codex's own cache. |
| Anthropic / OpenAI / Google / xAI / OpenRouter | Paste an API key. Stored AES-256-GCM encrypted in the data dir. |
| Ollama | Local models; set the base URL if not `localhost:11434`. |

## Layout

```
apps/server             Hono API + WebSocket + MCP endpoint (/mcp/:botId); runs the Bots
apps/desktop            Electron + React + Tailwind; starts the server
packages/shared         Types and zod schemas shared by both
packages/db             Drizzle + better-sqlite3, encrypted secrets
packages/sandbox        The computer: Playwright screens, shell, files, screencast, teach-a-task recording
packages/model-drivers  One ModelDriver interface; API driver (Vercel AI SDK) + CLI drivers (Claude Code, Codex, Gemini CLI)
packages/agent-runtime  Wake router, turn loop, Auto Review, memory, skills/routines, Vault, connectors, group routing
```

## Scripts

```bash
npm run typecheck   # all packages + desktop
npm run build       # desktop production build (out/)
npm run dist        # macOS .dmg + .zip in apps/desktop/release (npm run dist:dir for just the .app)
python3 -I scripts/smoke.py [--skip-chat]   # API regression against a running server on :3123
```
