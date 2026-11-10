import type { DriverEvent, ModelDriver, ProviderStatus, TurnInput } from "../types.js";
import { existsSync } from "node:fs";
import { execText, spawnJsonl, transcriptPrompt, which } from "./cli-common.js";
import { PROVIDERS } from "../providers.js";

/**
 * Drives the OpenAI Codex CLI (`codex exec --json`) so a ChatGPT subscription powers the Bot.
 * Event stream: thread.started, turn.started, item.{started,updated,completed}, turn.completed|failed.
 * Tools: Cadre's MCP server is attached with `default_tools_approval_mode="approve"` so Codex runs
 * the calls without its own prompt; Cadre's Auto Review still gates each call server-side.
 * Cadre's instructions go in as developer instructions on a new thread. Codex keeps those for the
 * thread's life, so later turns resend the context when it changed (e.g. the Chief's team snapshot).
 */
export class CodexDriver implements ModelDriver {
  readonly provider = "codex" as const;
  readonly toolMode = "mcp" as const;

  async status(): Promise<ProviderStatus> {
    const bin = await codexBinary();
    if (!bin) return { status: "not-installed", detail: "Install: npm i -g @openai/codex" };
    const r = await execText(bin.path, ["login", "status"]);
    if (r.code !== 0 || /not logged in/i.test(r.out)) {
      return { status: "needs-signin", detail: "Run `codex login` in a terminal." };
    }
    return { status: "ready", detail: `Codex ${bin.version.join(".")} at ${bin.path}` };
  }

  /**
   * Codex caches the account's model list in ~/.codex/models_cache*.json, but every Codex client on
   * the Mac (CLI, ChatGPT app) overwrites it, and newer clients unlock newer models. Only trust a
   * list written by the same or an older version than the binary we will run.
   */
  async listModels() {
    const bin = await codexBinary();
    const ids = bin ? await cachedModels(bin.version) : [];
    if (ids.length) return ids;
    return PROVIDERS.codex.curatedModels.map((id) => ({ id }));
  }

  async *run(input: TurnInput): AsyncIterable<DriverEvent> {
    // Threads from before native tools carried a text tool protocol: start those afresh.
    const resume = input.sessionId?.startsWith(SESSION_TAG) ? input.sessionId.slice(SESSION_TAG.length) : undefined;
    let prompt: string;
    if (resume) {
      const fresh = lastUserTurns(input);
      const changed = sentContext.get(resume) !== input.system;
      prompt = changed && input.system.trim() ? `<cadre_context refreshed="this turn">\n${input.system.trim()}\n</cadre_context>\n\n${fresh}` : fresh;
    } else {
      prompt = transcriptPrompt("", input.messages).trim();
    }
    const gen = this.runOnce(input, prompt, resume);
    let sid: string | undefined;
    while (true) {
      const n = await gen.next();
      if (n.done) {
        sid = n.value.sessionId;
        break;
      }
      const ev = n.value;
      if (ev.type === "session") {
        sentContext.set(ev.sessionId, input.system);
        yield { type: "session", sessionId: SESSION_TAG + ev.sessionId };
        continue;
      }
      yield ev;
      if (ev.type === "error" || ev.type === "done") return;
    }
    if (sid) sentContext.set(sid, input.system);
    yield { type: "done" };
  }

  private async *runOnce(input: TurnInput, prompt: string, sessionId: string | undefined): AsyncGenerator<DriverEvent, { text: string; sessionId: string | undefined }> {
    // `--sandbox` is not accepted by `exec resume`, so the sandbox is set through config overrides.
    // Codex's own shell may change files only inside Cadre's sandbox folder (its working directory);
    // everywhere else it is read-only. Changes outside go through Cadre's shell_run, which asks the user.
    const args = ["exec", "--json", "--skip-git-repo-check", "-m", input.model, ...codexSandboxArgs(input.cwd), "-c", 'approval_policy="never"'];
    // Developer instructions only stick on a new thread; resumed turns carry context in the prompt.
    if (!sessionId && input.system.trim()) args.push("-c", `developer_instructions=${JSON.stringify(input.system)}`);
    for (const m of input.mcpServers ?? []) {
      if (!m.url || !/^[\w-]+$/.test(m.name)) continue;
      const key = `mcp_servers.cadre_${m.name}`;
      args.push("-c", `${key}.url=${JSON.stringify(m.url)}`, "-c", `${key}.default_tools_approval_mode="approve"`, "-c", `${key}.tool_timeout_sec=900`);
    }
    if (sessionId) args.splice(1, 0, "resume", sessionId);
    const textByItem = new Map<string, string>();
    // Codex can start a shell command while it is still streaming a sentence. Hold other events
    // until the open message completes so the sentence isn't split around the command card.
    const openMessages = new Set<string>();
    const held: DriverEvent[] = [];
    let lastMessageId: string | null = null;
    let text = "";
    let sid = sessionId;
    const gen = spawnJsonl({ bin: (await codexBinary())?.path ?? "codex", args: [...args, "-"], stdin: prompt, cwd: input.cwd, signal: input.signal });
    for await (const line of gen) {
      if (!line.json) continue;
      const ev = line.json as Record<string, unknown>;
      const t = ev.type as string;
      if (t === "thread.started" && typeof ev.thread_id === "string") {
        sid = ev.thread_id;
        yield { type: "session", sessionId: sid };
        continue;
      }
      if (t === "item.started" || t === "item.updated" || t === "item.completed") {
        const item = ev.item as Record<string, unknown>;
        const id = String(item.id);
        switch (item.type) {
          case "agent_message": {
            const full = String(item.text ?? "");
            const prev = textByItem.get(id) ?? "";
            if (t === "item.completed") openMessages.delete(id);
            else openMessages.add(id);
            if (full.length > prev.length) {
              let delta = full.slice(prev.length);
              // A separate message starts a new paragraph instead of running on ("Jira.Gmail").
              if (!prev && lastMessageId && lastMessageId !== id && text && !text.endsWith("\n")) delta = `\n\n${delta}`;
              lastMessageId = id;
              text += delta;
              yield { type: "text-delta", text: delta };
              textByItem.set(id, full);
            }
            if (!openMessages.size) yield* held.splice(0);
            break;
          }
          case "reasoning":
            if (t === "item.completed" && typeof item.text === "string") {
              const e: DriverEvent = { type: "reasoning-delta", text: item.text };
              if (openMessages.size) held.push(e);
              else yield e;
            }
            break;
          case "mcp_tool_call": {
            const name = `${String(item.server ?? "mcp")}__${String(item.tool ?? "tool")}`.replace(/^cadre_computer__/, "");
            const e: DriverEvent | null =
              t === "item.started"
                ? { type: "tool-call", id, name, input: item.arguments ?? {} }
                : t === "item.completed"
                  ? {
                      type: "tool-result",
                      id,
                      name,
                      output: (item.error as { message?: string } | null)?.message ?? item.result ?? "",
                      isError: item.status === "failed" || !!item.error,
                    }
                  : null;
            if (e && openMessages.size) held.push(e);
            else if (e) yield e;
            break;
          }
          case "command_execution": {
            const e: DriverEvent | null =
              t === "item.started"
                ? { type: "tool-call", id, name: "codex_shell", input: { command: item.command } }
                : t === "item.completed"
                  ? { type: "tool-result", id, name: "codex_shell", output: item.aggregated_output ?? item.output ?? "" }
                  : null;
            if (e && openMessages.size) held.push(e);
            else if (e) yield e;
            break;
          }
          case "error":
            // Codex reports config warnings this way; they are noise in the transcript.
            break;
          default:
            break;
        }
        continue;
      }
      if (t === "turn.completed") {
        yield* held.splice(0);
        return { text, sessionId: sid };
      }
      if (t === "turn.failed" || t === "error") {
        yield* held.splice(0);
        const err = (ev.error as { message?: string } | undefined)?.message ?? (ev.message as string) ?? "Codex error";
        yield { type: "error", message: friendlyCodexError(err) };
        return { text, sessionId: sid };
      }
    }
    if (input.signal?.aborted) yield { type: "done", stopReason: "aborted" };
    else yield { type: "error", message: "Codex CLI exited without completing the turn" };
    return { text, sessionId: sid };
  }
}

/** When resuming, send only the user-side turns since the Bot's last reply. */
function lastUserTurns(input: TurnInput): string {
  const lastAssistant = input.messages.map((m) => m.role).lastIndexOf("assistant");
  const fresh = input.messages.slice(lastAssistant + 1);
  return fresh.map((m) => m.content).join("\n\n") || input.messages.at(-1)?.content || "";
}

/** Marks threads that use native tools; older ones are replaced by a fresh thread. */
const SESSION_TAG = "v2:";
/** Last context sent per Codex thread, so resumed turns resend it only when it changed. */
const sentContext = new Map<string, string>();

type Version = number[];

function parseVersion(text: string): Version | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

let binCache: { at: number; value: { path: string; version: Version } | null } | null = null;

/**
 * The newest Codex binary on this Mac: the one on PATH, the standalone install, or the copy the
 * ChatGPT desktop app ships. They share ~/.codex (sign-in included), so the newest one wins.
 */
export async function codexBinary(): Promise<{ path: string; version: Version } | null> {
  if (binCache && Date.now() - binCache.at < 60_000) return binCache.value;
  const { existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const home = homedir();
  const onPath = await which("codex");
  const candidates = [
    onPath,
    `${home}/.local/bin/codex`,
    `${home}/.codex/packages/standalone/current/bin/codex`,
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter((p): p is string => !!p && existsSync(p));
  let best: { path: string; version: Version } | null = null;
  for (const path of [...new Set(candidates)]) {
    const r = await execText(path, ["--version"], 5000);
    const version = r.code === 0 ? parseVersion(r.out) : null;
    if (version && (!best || compareVersions(version, best.version) > 0)) best = { path, version };
  }
  binCache = { at: Date.now(), value: best };
  return best;
}

async function cachedModels(binVersion: Version): Promise<{ id: string; label?: string }[]> {
  const { readFile, readdir } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const dir = `${homedir()}/.codex`;
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /^models_cache.*\.json$/.test(f));
  let best: { version: Version; models: { id: string; label?: string; priority: number }[] } | null = null;
  for (const f of files) {
    try {
      const raw = JSON.parse(await readFile(`${dir}/${f}`, "utf8")) as {
        client_version?: string;
        models?: { slug?: string; id?: string; display_name?: string; visibility?: string; priority?: number }[];
      };
      const version = parseVersion(raw.client_version ?? "");
      if (!version || compareVersions(version, binVersion) > 0) continue;
      if (best && compareVersions(version, best.version) <= 0) continue;
      const models = (raw.models ?? [])
        .filter((m) => (m.slug ?? m.id) && m.visibility !== "hide")
        .map((m) => ({ id: (m.slug ?? m.id)!, label: m.display_name, priority: m.priority ?? 99 }))
        .sort((a, b) => a.priority - b.priority);
      if (models.length) best = { version, models };
    } catch {
      /* skip unreadable cache */
    }
  }
  return (best?.models ?? []).map(({ id, label }) => ({ id, label }));
}

function friendlyCodexError(message: string): string {
  if (/model_not_found|not supported when using Codex with a ChatGPT account/i.test(message)) {
    return `${message}\n\nYour ChatGPT plan or Codex version doesn't offer this model. Pick another ChatGPT model in this Bot's details, or update Codex (npm i -g @openai/codex).`;
  }
  return message;
}

/** Write access for Codex's own shell: the sandbox folder (with internet for installs), nothing else. */
export function codexSandboxArgs(cwd: string | undefined): string[] {
  if (!cwd || !existsSync(cwd)) return ["-c", 'sandbox_mode="read-only"'];
  return [
    "-c", 'sandbox_mode="workspace-write"',
    "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([cwd])}`,
    "-c", "sandbox_workspace_write.network_access=true",
  ];
}
