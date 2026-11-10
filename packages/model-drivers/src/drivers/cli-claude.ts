import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEvent, ModelDriver, ProviderStatus, TurnInput } from "../types.js";
import { execText, spawnJsonl, which } from "./cli-common.js";
import { PROVIDERS } from "../providers.js";

/**
 * Drives the Claude Code CLI (`claude -p --output-format stream-json`) so the user's
 * Claude subscription powers the Bot. Multi-turn context is kept with `--resume <session_id>`.
 * Tools arrive through MCP (`--mcp-config`) in phase 2.
 */
export class ClaudeCodeDriver implements ModelDriver {
  readonly provider = "claude-code" as const;
  readonly toolMode = "mcp" as const;

  async status(): Promise<ProviderStatus> {
    if (!(await which("claude"))) return { status: "not-installed", detail: "Install: npm i -g @anthropic-ai/claude-code" };
    const r = await execText("claude", ["auth", "status"]);
    let loggedIn = false;
    try {
      const j = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { loggedIn?: boolean; authMethod?: string };
      loggedIn = !!j.loggedIn;
      if (loggedIn) return { status: "ready", detail: j.authMethod ? `Signed in via ${j.authMethod}` : undefined };
    } catch {
      loggedIn = r.code === 0 && !/not logged in|logged out|no credentials/i.test(r.out);
    }
    return loggedIn ? { status: "ready" } : { status: "needs-signin", detail: "Run `claude` in a terminal and use /login." };
  }

  async listModels() {
    // Aliases: the Claude CLI maps each to the newest model of that tier your plan includes.
    const labels: Record<string, string> = { opus: "Opus (latest)", sonnet: "Sonnet (latest)", haiku: "Haiku (latest)" };
    return PROVIDERS["claude-code"].curatedModels.map((id) => ({ id, label: labels[id] }));
  }

  async *run(input: TurnInput): AsyncIterable<DriverEvent> {
    const last = input.messages.at(-1);
    if (!last || last.role !== "user") {
      yield { type: "error", message: "Last message must be from the user" };
      return;
    }
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // Isolate from the user's personal Claude Code hooks/settings: the Bot gets only our prompt.
      "--setting-sources",
      "",
      "--model",
      input.model,
      "--append-system-prompt",
      input.system,
    ];
    if (input.sessionId) args.push("--resume", input.sessionId);
    // Claude Code's own file tools may read anywhere but change files only inside Cadre's sandbox
    // folder (its working directory). Its shell stays off: everything else goes through our MCP
    // server, so every call outside the sandbox goes through Auto Review.
    const sandbox = claudeSandboxArgs(input.cwd);
    args.push("--tools", sandbox.tools);
    const allowed = [...sandbox.allowed, ...(input.mcpServers ?? []).map((s) => `mcp__${s.name}__*`)];
    if (allowed.length) args.push("--allowedTools", ...allowed);
    if (input.mcpServers?.length) {
      const dir = mkdtempSync(join(tmpdir(), "cadre-mcp-"));
      const cfg = {
        mcpServers: Object.fromEntries(
          input.mcpServers.map((s) => [
            s.name,
            s.url ? { type: "http", url: s.url } : { command: s.command, args: s.args ?? [], env: s.env ?? {} },
          ]),
        ),
      };
      const file = join(dir, "mcp.json");
      writeFileSync(file, JSON.stringify(cfg));
      args.push("--mcp-config", file, "--strict-mcp-config");
    }

    // When resuming, the CLI already holds the history: send only what arrived since its last
    // reply (one user message, or several user-side turns in a group chat). Otherwise, the full history.
    let prompt: string;
    if (input.sessionId) {
      const lastAssistant = input.messages.map((m) => m.role).lastIndexOf("assistant");
      const fresh = input.messages.slice(lastAssistant + 1);
      prompt = fresh.length <= 1 ? last.content : fresh.map((m) => m.content).join("\n\n");
    } else {
      prompt =
        input.messages.length === 1 ? last.content : input.messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
    }

    let sawText = false;
    let sessionId: string | undefined;
    const openTools = new Map<string, string>();

    const gen = spawnJsonl({ bin: "claude", args, stdin: prompt, cwd: input.cwd, signal: input.signal });
    for await (const line of gen) {
      if (!line.json) {
        if (line.stream === "stderr" && /error/i.test(line.raw)) yield { type: "status", text: line.raw };
        continue;
      }
      const ev = line.json as Record<string, unknown>;
      const t = ev.type as string;

      if (t === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
        sessionId = ev.session_id;
        yield { type: "session", sessionId };
        continue;
      }

      if (t === "stream_event") {
        const e = ev.event as Record<string, unknown>;
        if (e?.type === "content_block_delta") {
          const d = e.delta as Record<string, unknown>;
          if (d?.type === "text_delta" && typeof d.text === "string") {
            sawText = true;
            yield { type: "text-delta", text: d.text };
          } else if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
            yield { type: "reasoning-delta", text: d.thinking };
          }
        } else if (e?.type === "content_block_start") {
          const cb = e.content_block as Record<string, unknown>;
          if (cb?.type === "tool_use") openTools.set(String(cb.id), String(cb.name));
        }
        continue;
      }

      if (t === "assistant") {
        const msg = ev.message as { content?: Record<string, unknown>[] };
        for (const block of msg?.content ?? []) {
          if (block.type === "tool_use") {
            yield { type: "tool-call", id: String(block.id), name: String(block.name), input: block.input };
          } else if (block.type === "text" && !sawText && typeof block.text === "string") {
            // Partial messages disabled or unavailable: emit whole text once.
            yield { type: "text-delta", text: block.text };
          }
        }
        continue;
      }

      if (t === "user") {
        const msg = ev.message as { content?: Record<string, unknown>[] };
        for (const block of msg?.content ?? []) {
          if (block.type === "tool_result") {
            const id = String(block.tool_use_id);
            yield {
              type: "tool-result",
              id,
              name: openTools.get(id) ?? "tool",
              output: block.content,
              isError: block.is_error === true,
            };
          }
        }
        continue;
      }

      if (t === "result") {
        if (ev.is_error || ev.subtype !== "success") {
          yield { type: "error", message: String(ev.result ?? ev.error ?? ev.subtype ?? "Claude CLI error") };
          return;
        }
        const usage = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        yield { type: "done", usage: { inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens } };
        return;
      }
    }
    if (input.signal?.aborted) yield { type: "done", stopReason: "aborted" };
    else yield { type: "error", message: "Claude CLI exited without a result" };
  }
}

/** Claude Code built-ins for the sandbox: reads anywhere, edits only under `cwd` (`//` = absolute path). */
export function claudeSandboxArgs(cwd: string | undefined): { tools: string; allowed: string[] } {
  if (!cwd || !existsSync(cwd)) return { tools: "", allowed: [] };
  const root = cwd.replace(/\/+$/, "");
  return { tools: "Read,Glob,Grep,Edit,Write", allowed: [`Edit(/${root}/**)`] };
}
