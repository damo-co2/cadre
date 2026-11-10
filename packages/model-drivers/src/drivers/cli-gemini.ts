import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEvent, ModelDriver, ProviderStatus, TurnInput } from "../types.js";
import { type JsonlLine, spawnJsonl, transcriptPrompt, which } from "./cli-common.js";
import { PROVIDERS } from "../providers.js";

/**
 * Drives the Gemini CLI (`gemini -p … -o stream-json`).
 * Tools: Cadre's MCP server goes in a private settings file per run (GEMINI_CLI_SYSTEM_SETTINGS_PATH,
 * merged over the user's own settings without touching them), marked `trust: true` because headless
 * Gemini denies any tool that would ask for approval; Cadre's Auto Review still gates each call.
 * `--allowed-mcp-server-names cadre` keeps any other MCP server (user settings, extensions) out.
 * Instructions: Cadre's system prompt replaces Gemini's via GEMINI_SYSTEM_MD, refreshed every turn.
 * No resume: each turn sends the conversation so far.
 */
export class GeminiCliDriver implements ModelDriver {
  readonly provider = "gemini-cli" as const;
  readonly toolMode = "mcp" as const;

  async status(): Promise<ProviderStatus> {
    if (!(await which("gemini"))) return { status: "not-installed", detail: "Install: npm i -g @google/gemini-cli" };
    return { status: "ready", detail: "Sign-in is checked on first use." };
  }

  /** Reads the model list that ships inside the installed Gemini CLI, so new models appear when it updates. */
  async listModels() {
    const live = await geminiCliModels();
    const ids = live.length ? live : PROVIDERS["gemini-cli"].curatedModels;
    return ids.map((id) => ({ id, label: geminiLabel(id) }));
  }

  async *run(input: TurnInput): AsyncIterable<DriverEvent> {
    const dir = mkdtempSync(join(tmpdir(), "cadre-gemini-"));
    try {
      const servers: Record<string, unknown> = {};
      for (const m of input.mcpServers ?? []) {
        if (m.url && /^[\w-]+$/.test(m.name)) servers[m.name === "computer" ? "cadre" : `cadre_${m.name}`] = { httpUrl: m.url, trust: true, timeout: 900_000 };
      }
      const settingsPath = join(dir, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ mcpServers: servers }));
      const systemPath = join(dir, "system.md");
      writeFileSync(systemPath, input.system?.trim() || "You are a helpful teammate.");
      const prompt = transcriptPrompt("", input.messages).trim();
      const args = ["-p", prompt, "-o", "stream-json", "-m", input.model, "--approval-mode", "default"];
      const names = Object.keys(servers);
      if (names.length) args.push("--allowed-mcp-server-names", names.join(","));
      const env = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath, GEMINI_SYSTEM_MD: systemPath };
      yield* this.stream(spawnJsonl({ bin: "gemini", args, cwd: input.cwd, env, signal: input.signal }), input);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async *stream(gen: AsyncGenerator<JsonlLine, { code: number | null }>, input: TurnInput): AsyncGenerator<DriverEvent> {
    const toolNames = new Map<string, string>();
    let emitted = "";
    let failed: string | null = null;
    let stderr = "";
    while (true) {
      const n = await gen.next();
      if (n.done) {
        if (input.signal?.aborted) {
          yield { type: "done", stopReason: "aborted" };
          return;
        }
        if (failed) yield { type: "error", message: failed };
        else if (n.value.code && !emitted) yield { type: "error", message: stderr.trim().split("\n").slice(-3).join("\n") || `Gemini CLI exited with code ${n.value.code}` };
        else yield { type: "done" };
        return;
      }
      const line = n.value;
      if (!line.json) {
        if (line.stream === "stderr") stderr = `${stderr}\n${line.raw}`.slice(-4000);
        continue;
      }
      const ev = line.json as Record<string, unknown>;
      switch (ev.type) {
        case "init":
          if (typeof ev.session_id === "string") yield { type: "session", sessionId: ev.session_id };
          break;
        case "message": {
          if (ev.role !== "assistant" || typeof ev.content !== "string" || !ev.content) break;
          // Streaming chunks carry delta=true; a full message repeats what came before.
          const delta = ev.delta ? ev.content : ev.content.startsWith(emitted) ? ev.content.slice(emitted.length) : ev.content;
          if (delta) {
            emitted += delta;
            yield { type: "text-delta", text: delta };
          }
          break;
        }
        case "tool_use": {
          const id = String(ev.tool_id ?? Math.random());
          const name = String(ev.tool_name ?? "tool").replace(/^cadre__/, "");
          toolNames.set(id, name);
          yield { type: "tool-call", id, name, input: ev.parameters ?? {} };
          break;
        }
        case "tool_result": {
          const id = String(ev.tool_id ?? "");
          const err = ev.error as { message?: string } | undefined;
          yield { type: "tool-result", id, name: toolNames.get(id) ?? "tool", output: err?.message ?? ev.output ?? "", isError: ev.status === "error" };
          break;
        }
        case "error":
          if (ev.severity !== "warning") failed = String(ev.message ?? "Gemini CLI error");
          break;
        case "result": {
          const err = ev.error as { message?: string } | undefined;
          if (ev.status === "error") failed = err?.message ?? failed ?? "Gemini CLI error";
          break;
        }
        default:
          break;
      }
    }
  }
}

async function geminiCliModels(): Promise<string[]> {
  try {
    const { readFile, realpath } = await import("node:fs/promises");
    const { dirname, join } = await import("node:path");
    const bin = await which("gemini");
    if (!bin) return [];
    // bin → …/@google/gemini-cli/dist/index.js; the list lives in its bundled gemini-cli-core.
    let dir = dirname(await realpath(bin));
    for (let i = 0; i < 4; i++) {
      const file = join(dir, "node_modules/@google/gemini-cli-core/dist/src/config/models.js");
      const src = await readFile(file, "utf8").catch(() => null);
      if (src) return parseGeminiModels(src);
      dir = dirname(dir);
    }
  } catch {
    /* fall back to the curated list */
  }
  return [];
}

/** Resolves `VALID_GEMINI_MODELS = new Set([CONST, …])` against the file's `export const CONST = '…'` lines. */
export function parseGeminiModels(src: string): string[] {
  const consts = new Map<string, string>();
  for (const m of src.matchAll(/export const ([A-Z0-9_]+) = ['"]([^'"]+)['"]/g)) consts.set(m[1], m[2]);
  const set = src.match(/VALID_GEMINI_MODELS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
  const ids = set
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => consts.get(t) ?? t.replace(/^['"]|['"]$/g, ""))
    .filter((id) => /^gemini-/.test(id) && !/customtools/.test(id));
  // Newest first: higher version, then pro before flash before lite.
  const ver = (id: string) => Number(id.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const tier = (id: string) => (/lite/.test(id) ? 2 : /flash/.test(id) ? 1 : 0);
  return [...new Set(ids)].sort((a, b) => ver(b) - ver(a) || tier(a) - tier(b));
}

function geminiLabel(id: string): string {
  return id
    .replace(/^gemini-/, "Gemini ")
    .replace(/-preview$/, " (preview)")
    .replace(/-/g, " ")
    .replace(/\b(pro|flash|lite)\b/g, (w) => w[0].toUpperCase() + w.slice(1));
}
