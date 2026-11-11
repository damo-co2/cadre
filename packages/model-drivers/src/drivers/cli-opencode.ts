import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEvent, ModelDriver, ProviderStatus, TurnInput } from "../types.js";
import { execText, spawnJsonl, transcriptPrompt, which } from "./cli-common.js";
import { PROVIDERS } from "../providers.js";

/**
 * Drives OpenCode (`opencode run --format json`): its free models plus any provider the user
 * signed in to inside OpenCode (NVIDIA, Ollama Cloud, …).
 *
 * Isolation: XDG_CONFIG_HOME (1.x) and OPENCODE_CONFIG_DIR (2.x) point at a private folder so the
 * user's own OpenCode config (their MCP servers, e.g. Home Assistant) never loads; sign-ins live
 * in the data folder and still work. The whole config for the turn comes in
 * OPENCODE_CONFIG_CONTENT: Cadre's MCP server, and a "cadre" agent whose prompt is Cadre's system
 * prompt (re-sent every turn, so it stays fresh) with OpenCode's shell/edit/write tools off, so
 * changes go only through Cadre's tools and Auto Review.
 */
export class OpenCodeDriver implements ModelDriver {
  readonly provider = "opencode" as const;
  readonly toolMode = "mcp" as const;

  async status(): Promise<ProviderStatus> {
    if (!(await which("opencode"))) return { status: "not-installed", detail: "Install: brew install sst/tap/opencode" };
    return { status: "ready", detail: "Free models have a usage limit set by OpenCode." };
  }

  async listModels() {
    const now = Date.now();
    if (modelCache && now - modelCache.at < 10 * 60_000) return modelCache.models;
    const env = isolatedEnv();
    // OpenCode 1.x prints model metadata with --verbose; 2.x dropped the flag and prints just
    // "provider/model" lines. Try verbose first so older installs keep their nicer labels.
    const verbose = await execText("opencode", ["models", "--verbose"], 60_000, env);
    let models = verbose.code === 0 ? parseModels(verbose.out) : [];
    if (!models.length) {
      const plain = await execText("opencode", ["models"], 60_000, env);
      models = plain.code === 0 ? parseModelIds(plain.out) : [];
    }
    const list = models.length ? models : PROVIDERS.opencode.curatedModels.map((id) => ({ id }));
    if (models.length) modelCache = { at: now, models: list };
    return list;
  }

  async *run(input: TurnInput): AsyncIterable<DriverEvent> {
    const major = await openCodeMajor();
    const prompt = input.sessionId ? lastUserTurns(input) : transcriptPrompt("", input.messages).trim();
    const config = buildConfig(input, major);

    // OpenCode 2.x takes global flags before the subcommand, uses lowercase log levels, gets the
    // project folder from the process cwd (it dropped `run --dir`), and needs --standalone: without
    // it the CLI reuses a background server that never saw this turn's OPENCODE_CONFIG_CONTENT and
    // then fails with "Agent not found: cadre". 1.x keeps its original command shape.
    const args =
      major >= 2
        ? ["--standalone", "--print-logs", "--log-level", "error", "run", "--format", "json"]
        : ["run", "--format", "json", "--print-logs", "--log-level", "ERROR"];
    args.push("-m", input.model, "--agent", "cadre");
    if (input.sessionId) args.push("--session", input.sessionId);
    if (major < 2 && input.cwd) args.push("--dir", input.cwd);
    args.push(prompt);

    // Our own controller so a logged error that leaves opencode hanging can still end the turn.
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const env: Record<string, string> = { ...isolatedEnv(), OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
    // OpenCode 2 uses $PWD as the project folder. Electron inherits the dev server's PWD, which can
    // point somewhere else entirely (in development: apps/desktop), so the spawned process would
    // treat Cadre's sandbox as an external directory even though its real cwd is correct.
    if (input.cwd) env.PWD = input.cwd;
    const gen = spawnJsonl({ bin: "opencode", args, cwd: input.cwd, env, signal: ac.signal });
    let announced = false;
    let wroteText = false;
    let failed: string | null = null;
    try {
      for await (const line of gen) {
        if (line.stream === "stderr") {
          const err = logError(line.raw);
          if (err && !failed) {
            failed = err;
            ac.abort(); // opencode can hang after a provider error; stop it.
          }
          continue;
        }
        const ev = line.json as { type?: string; sessionID?: string; part?: Record<string, unknown>; error?: unknown } | undefined;
        if (!ev?.type) continue;
        if (!announced && typeof ev.sessionID === "string") {
          announced = true;
          yield { type: "session", sessionId: ev.sessionID };
        }
        const part = ev.part ?? {};
        if (ev.type === "text" && typeof part.text === "string" && part.text) {
          yield { type: "text-delta", text: wroteText ? `\n\n${part.text}` : part.text };
          wroteText = true;
        } else if (ev.type === "reasoning" && typeof part.text === "string" && part.text) {
          yield { type: "reasoning-delta", text: part.text };
        } else if (ev.type === "tool_use") {
          const state = (part.state ?? {}) as { status?: string; input?: unknown; output?: unknown; error?: unknown };
          const id = String(part.callID ?? part.id ?? Math.random());
          const name = String(part.tool ?? "tool").replace(/^cadre_computer_/, "");
          if (state.status === "completed" || state.status === "error") {
            yield { type: "tool-call", id, name, input: state.input ?? {} };
            yield { type: "tool-result", id, name, output: state.status === "error" ? (state.error ?? state.output ?? "error") : (state.output ?? ""), isError: state.status === "error" };
          }
        } else if (ev.type === "error" && !failed) {
          failed = errorText(ev.error ?? ev);
        }
      }
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
    if (input.signal?.aborted) {
      yield { type: "done", stopReason: "aborted" };
      return;
    }
    if (failed) {
      yield { type: "error", message: friendly(failed) };
      return;
    }
    yield { type: "done" };
  }
}

let modelCache: { at: number; models: { id: string; label?: string }[] } | null = null;
let majorCache: number | null = null;

/** OpenCode's major version: the CLI and config shapes differ between 1.x and 2.x. */
async function openCodeMajor(): Promise<number> {
  if (majorCache !== null) return majorCache;
  const r = await execText("opencode", ["--version"], 15_000, isolatedEnv());
  const m = r.code === 0 ? r.out.match(/(\d+)\.\d+/) : null;
  majorCache = m ? Number(m[1]) : 1;
  return majorCache;
}

/**
 * The per-turn config. 1.x keeps its original shape (`mcp` server map, `agent`, `permission`).
 * 2.x uses `mcp.servers`, `agents`, and a `permissions` rule list, and `codemode: false` so
 * Cadre's MCP tools appear on the model's native tool list instead of only inside `execute`
 * (Code Mode hides the real tool names and fills the transcript with JavaScript).
 */
function buildConfig(input: TurnInput, major: number): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const m of input.mcpServers ?? []) {
    if (m.url && /^[\w-]+$/.test(m.name)) {
      servers[`cadre_${m.name}`] =
        major >= 2
          ? { type: "remote", url: m.url, disabled: false, codemode: false, timeout: { startup: 900_000, catalog: 900_000, execution: 900_000 } }
          : { type: "remote", url: m.url, enabled: true, timeout: 900_000 };
    }
  }
  const prompt = input.system || "You are a helpful teammate.";
  if (major >= 2) {
    // Edits are allowed in the sandbox (the process cwd) and nowhere else: OpenCode checks
    // external_directory before touching anything outside it. Its shell stays off because OpenCode
    // does not confine shell commands to a folder; Cadre's own shell_run tool still works through
    // MCP and keeps Auto Review. Turn off only the OpenCode tools that change things; its
    // read-only tools stay on because free models refuse requests that carry none of their own.
    return {
      $schema: "https://opencode.ai/config.json",
      mcp: { servers },
      agents: {
        cadre: {
          mode: "primary",
          prompt,
          permissions: [
            { action: "subagent", resource: "*", effect: "deny" },
            { action: "todowrite", resource: "*", effect: "deny" },
            { action: "todoread", resource: "*", effect: "deny" },
          ],
        },
      },
      permissions: [
        { action: "edit", resource: "*", effect: "allow" },
        { action: "shell", resource: "*", effect: "deny" },
        { action: "webfetch", resource: "*", effect: "deny" },
        { action: "external_directory", resource: "*", effect: "deny" },
      ],
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    mcp: servers,
    agent: {
      // Turn off only OpenCode's tools that change things. Keep its read-only ones: OpenCode's free
      // models refuse requests that carry none of OpenCode's own tools ("Free usage limit reached …
      // Free models work in OpenCode"), seen on 2026-11-08 with `"*": false` while the same model
      // worked in the user's own OpenCode seconds later.
      cadre: { mode: "primary", prompt, tools: { bash: false, task: false, todowrite: false, todoread: false } },
    },
    permission: { edit: "allow", bash: "deny", webfetch: "deny", external_directory: "deny" },
  };
}

/** Keep the user's sign-ins (data dir) but not their config (MCP servers, plugins). */
function isolatedEnv(): Record<string, string> {
  const dir = join(process.env.DATA_DIR ?? tmpdir(), "opencode-config");
  mkdirSync(dir, { recursive: true });
  // XDG_CONFIG_HOME covers 1.x; 2.x reads OPENCODE_CONFIG_DIR and ignores XDG_CONFIG_HOME.
  // Without this, the user's own config (MCP servers, plugins) merges into Cadre's turns.
  return { XDG_CONFIG_HOME: dir, OPENCODE_CONFIG_DIR: dir };
}

/** OpenCode 2.x `models` prints one "provider/model" id per line. */
export function parseModelIds(out: string): { id: string; label?: string }[] {
  const seen = new Set<string>();
  const models = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[\w.-]+\/\S+$/.test(line) && !line.includes("://"))
    .filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
    .map((id) => ({ id, label: id.startsWith("opencode/") ? `${id} · free` : id }));
  models.sort((a, b) => Number(b.id.startsWith("opencode/")) - Number(a.id.startsWith("opencode/")));
  return models;
}

/** `opencode models --verbose` prints "provider/model" then a JSON block per model. */
export function parseModels(out: string): { id: string; label?: string }[] {
  const models: { id: string; label: string; free: boolean }[] = [];
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i].trim();
    if (!/^[\w.-]+\/\S+$/.test(id) || lines[i + 1]?.trim() !== "{") continue;
    let depth = 0;
    const buf: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      buf.push(lines[j]);
      depth += (lines[j].match(/{/g) ?? []).length - (lines[j].match(/}/g) ?? []).length;
      if (depth === 0) {
        i = j;
        break;
      }
    }
    try {
      const m = JSON.parse(buf.join("\n")) as {
        name?: string;
        status?: string;
        cost?: { input?: number; output?: number };
        capabilities?: { toolcall?: boolean; input?: { text?: boolean }; output?: { text?: boolean } };
      };
      const cap = m.capabilities ?? {};
      if (!cap.toolcall || !cap.input?.text || !cap.output?.text || (m.status && m.status !== "active")) continue;
      const free = (m.cost?.input ?? 0) === 0 && (m.cost?.output ?? 0) === 0;
      models.push({ id, label: `${m.name ?? id}${free ? " · free" : ""} (${id.split("/")[0]})`, free });
    } catch {
      /* skip */
    }
  }
  // Free first, OpenCode's own models first among those.
  models.sort((a, b) => Number(b.free) - Number(a.free) || Number(b.id.startsWith("opencode/")) - Number(a.id.startsWith("opencode/")));
  return models.map(({ id, label }) => ({ id, label }));
}

/** An ERROR log line from `--print-logs`, reduced to its message. */
export function logError(raw: string): string | null {
  if (!/level=ERROR/.test(raw)) return null;
  const m = raw.match(/error\.error="([^"]+)"/) ?? raw.match(/error="([^"]+)"/) ?? raw.match(/\berror=(\S+)/);
  return m ? m[1].replace(/^AI_APICallError:\s*/, "") : null;
}

function errorText(e: unknown): string {
  const x = e as { data?: { message?: string }; message?: string; name?: string };
  return x?.data?.message ?? x?.message ?? x?.name ?? JSON.stringify(e).slice(0, 300);
}

function friendly(msg: string): string {
  if (/free usage limit/i.test(msg)) return `${msg}\n\nOpenCode's free models have a usage limit. Pick another model for this Bot (an NVIDIA or Ollama Cloud model you signed in to in OpenCode, or another provider), or try again later.`;
  if (/forbidden/i.test(msg)) return `${msg}\n\nYour key for this provider can't use this model. Pick another model for this Bot.`;
  return msg;
}

function lastUserTurns(input: TurnInput): string {
  const lastAssistant = input.messages.map((m) => m.role).lastIndexOf("assistant");
  const fresh = input.messages.slice(lastAssistant + 1);
  return fresh.map((m) => m.content).join("\n\n") || input.messages.at(-1)?.content || "";
}
