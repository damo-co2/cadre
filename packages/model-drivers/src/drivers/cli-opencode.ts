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
 * Isolation: XDG_CONFIG_HOME points at a private folder so the user's own OpenCode config (their
 * MCP servers, e.g. Home Assistant) never loads; sign-ins live in the data folder and still work.
 * The whole config for the turn comes in OPENCODE_CONFIG_CONTENT: Cadre's MCP server, and a
 * "cadre" agent whose prompt is Cadre's system prompt (re-sent every turn, so it stays fresh) with
 * OpenCode's shell/edit/write tools off, so changes go only through Cadre's tools and Auto Review.
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
    const r = await execText("opencode", ["models", "--verbose"], 60_000, isolatedEnv());
    const models = r.code === 0 ? parseModels(r.out) : [];
    const list = models.length ? models : PROVIDERS.opencode.curatedModels.map((id) => ({ id }));
    if (models.length) modelCache = { at: now, models: list };
    return list;
  }

  async *run(input: TurnInput): AsyncIterable<DriverEvent> {
    const prompt = input.sessionId ? lastUserTurns(input) : transcriptPrompt("", input.messages).trim();
    const mcp: Record<string, unknown> = {};
    for (const m of input.mcpServers ?? []) {
      if (m.url && /^[\w-]+$/.test(m.name)) mcp[`cadre_${m.name}`] = { type: "remote", url: m.url, enabled: true, timeout: 900_000 };
    }
    const config = {
      $schema: "https://opencode.ai/config.json",
      mcp,
      agent: {
        // Turn off only OpenCode's tools that change things. Keep its read-only ones: OpenCode's free
        // models refuse requests that carry none of OpenCode's own tools ("Free usage limit reached …
        // Free models work in OpenCode"), seen on 2026-11-08 with `"*": false` while the same model
        // worked in the user's own OpenCode seconds later.
        cadre: { mode: "primary", prompt: input.system || "You are a helpful teammate.", tools: { bash: false, task: false, todowrite: false, todoread: false } },
      },
      // Edits are allowed in the sandbox (OpenCode's project folder, --dir) and nowhere else:
      // OpenCode asks external_directory before touching anything outside it, and that is denied.
      // Its shell stays off because OpenCode does not confine shell commands to a folder.
      permission: { edit: "allow", bash: "deny", webfetch: "deny", external_directory: "deny" },
    };
    const args = ["run", "--format", "json", "--print-logs", "--log-level", "ERROR", "-m", input.model, "--agent", "cadre"];
    if (input.sessionId) args.push("--session", input.sessionId);
    if (input.cwd) args.push("--dir", input.cwd);
    args.push(prompt);

    // Our own controller so a logged error that leaves opencode hanging can still end the turn.
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const gen = spawnJsonl({ bin: "opencode", args, cwd: input.cwd, env: { ...isolatedEnv(), OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, signal: ac.signal });
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

/** Keep the user's sign-ins (data dir) but not their config (MCP servers, plugins). */
function isolatedEnv(): Record<string, string> {
  const dir = join(process.env.DATA_DIR ?? tmpdir(), "opencode-config");
  mkdirSync(dir, { recursive: true });
  return { XDG_CONFIG_HOME: dir };
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
