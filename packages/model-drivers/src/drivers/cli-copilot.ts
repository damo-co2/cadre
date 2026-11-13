import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEvent, ModelDriver, ProviderStatus, TurnInput } from "../types.js";
import { type JsonlLine, execText, spawnJsonl, transcriptPrompt, which } from "./cli-common.js";
import { PROVIDERS } from "../providers.js";

/**
 * Drives the GitHub Copilot CLI (`copilot -p … --output-format json`) on the user's Copilot plan.
 * Sessions: Cadre picks the session id itself (`--session-id <uuid>` creates it on the first turn and
 * resumes it after), because the CLI's JSON output doesn't document where it reports one.
 * Instructions: the CLI has no system-prompt flag, so Cadre's instructions go at the top of the first
 * prompt and again whenever they change; `--no-custom-instructions` keeps the workspace's AGENTS.md out.
 * Tools: Cadre's MCP server via `--additional-mcp-config`, allowed by server name. The CLI's own shell is
 * denied so every action goes through Cadre (and its Auto Review). Built-in GitHub MCP servers are off.
 * The JSONL event format isn't documented either, so parsing accepts the Copilot SDK's session event names
 * and falls back to plain stdout text.
 */
export class CopilotCliDriver implements ModelDriver {
  readonly provider = "copilot" as const;
  readonly toolMode = "mcp" as const;

  async status(): Promise<ProviderStatus> {
    const bin = await which("copilot");
    if (!bin) return { status: "not-installed", detail: "Install: npm i -g @github/copilot (or brew install --cask copilot-cli), then run `copilot login`." };
    if (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return { status: "ready", detail: `Copilot CLI at ${bin} (token from the environment)` };
    // `copilot login` stores its token in the keychain under "copilot-cli". This only checks the item exists.
    const kc = process.platform === "darwin" ? await execText("security", ["find-generic-password", "-s", "copilot-cli"]).catch(() => ({ code: 1, out: "" })) : { code: 1, out: "" };
    if (kc.code === 0) return { status: "ready", detail: `Copilot CLI at ${bin}` };
    return { status: "needs-signin", detail: "Run `copilot login` in a terminal." };
  }

  async listModels() {
    const labels: Record<string, string> = { auto: "Auto (Copilot picks)" };
    return PROVIDERS.copilot.curatedModels.map((id) => ({ id, label: labels[id] ?? id }));
  }

  async *run(input: TurnInput): AsyncIterable<DriverEvent> {
    const last = input.messages.at(-1);
    if (!last || last.role !== "user") {
      yield { type: "error", message: "Last message must be from the user" };
      return;
    }
    const resuming = !!input.sessionId && isUuid(input.sessionId);
    const sessionId = resuming ? input.sessionId! : randomUUID();
    if (!resuming) yield { type: "session", sessionId };

    const dir = mkdtempSync(join(tmpdir(), "cadre-copilot-"));
    try {
      const servers: Record<string, unknown> = {};
      for (const m of input.mcpServers ?? []) {
        const name = m.name === "computer" ? "cadre" : `cadre_${m.name}`.replace(/[^\w-]/g, "_");
        servers[name] = m.url
          ? { type: "http", url: m.url, tools: ["*"] }
          : { type: "local", command: m.command, args: m.args ?? [], env: m.env ?? {}, tools: ["*"] };
      }
      const args = [
        "-p",
        copilotPrompt(input, sessionId, resuming),
        "--output-format",
        "json",
        "--session-id",
        sessionId,
        "--no-color",
        "--no-ask-user",
        "--no-custom-instructions",
        "--disable-builtin-mcps",
        "--deny-tool=shell",
      ];
      if (input.model && input.model !== "auto") args.push("--model", input.model);
      const names = Object.keys(servers);
      if (names.length) {
        const file = join(dir, "mcp.json");
        writeFileSync(file, JSON.stringify({ mcpServers: servers }));
        args.push("--additional-mcp-config", `@${file}`, `--allow-tool=${names.join(",")}`);
      }
      const gen = spawnJsonl({ bin: "copilot", args, cwd: input.cwd, env: { COPILOT_AUTO_UPDATE: "false" }, signal: input.signal });
      let ok = false;
      for await (const ev of parseCopilotStream(gen, input.signal)) {
        if (ev.type === "done") ok = true;
        yield ev;
      }
      if (ok) sentInstructions.set(sessionId, input.system);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Instructions last sent per Copilot session, so resumed turns resend them only when they changed. */
const sentInstructions = new Map<string, string>();

/** First turn: instructions + the conversation so far. Resumed: only what arrived since the last reply. */
export function copilotPrompt(input: TurnInput, sessionId: string, resuming: boolean): string {
  const instructions = input.system?.trim() ? `<instructions>\n${input.system.trim()}\n</instructions>\n\n` : "";
  if (!resuming) return `${instructions}${transcriptPrompt("", input.messages).trim()}`;
  const lastAssistant = input.messages.map((m) => m.role).lastIndexOf("assistant");
  const fresh = input.messages.slice(lastAssistant + 1).map((m) => m.content).join("\n\n");
  const changed = sentInstructions.get(sessionId) !== input.system;
  return `${changed ? `(Your instructions were updated.)\n${instructions}` : ""}${fresh}`;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Copilot JSONL → driver events. Accepts the Copilot SDK's session event names (assistant.message_delta,
 * assistant.message, tool.execution_start/complete, session.error) and close variants; any non-JSON
 * stdout is kept as the reply when no structured text arrived.
 */
export async function* parseCopilotStream(gen: AsyncGenerator<JsonlLine, { code: number | null }>, signal?: AbortSignal): AsyncGenerator<DriverEvent> {
  const toolNames = new Map<string, string>();
  let emitted = "";
  let plain = "";
  let stderr = "";
  let failed: string | null = null;
  while (true) {
    const n = await gen.next();
    if (n.done) {
      if (signal?.aborted) {
        yield { type: "done", stopReason: "aborted" };
        return;
      }
      if (!emitted && plain.trim() && !failed) {
        yield { type: "text-delta", text: plain.trim() };
        emitted = plain;
      }
      if (failed) yield { type: "error", message: failed };
      else if (n.value.code && !emitted) yield { type: "error", message: stderr.trim().split("\n").slice(-3).join("\n") || `Copilot CLI exited with code ${n.value.code}` };
      else yield { type: "done" };
      return;
    }
    const line = n.value;
    if (line.json === undefined || typeof line.json !== "object" || line.json === null) {
      if (line.stream === "stderr") stderr = `${stderr}\n${line.raw}`.slice(-4000);
      else plain += `${line.raw}\n`;
      continue;
    }
    const ev = line.json as Record<string, unknown>;
    const data = (ev.data && typeof ev.data === "object" ? ev.data : ev) as Record<string, unknown>;
    const type = String(ev.type ?? "");
    if (/message[._]delta$/.test(type) || type === "assistant.delta") {
      const delta = str(data.deltaContent) ?? str(data.delta) ?? str(data.content) ?? "";
      if (delta) {
        emitted += delta;
        yield { type: "text-delta", text: delta };
      }
    } else if (type === "assistant.message" || type === "message" || type === "assistant") {
      if (data.role && data.role !== "assistant") continue;
      const full = str(data.content) ?? str(data.text) ?? "";
      // A whole message repeats what streamed before it: emit only the new tail.
      const tail = full.startsWith(emitted) ? full.slice(emitted.length) : emitted ? "" : full;
      if (tail) {
        emitted += tail;
        yield { type: "text-delta", text: tail };
      }
    } else if (/tool[._]execution[._]start$/.test(type) || type === "tool_use" || type === "tool.call") {
      const id = String(data.toolCallId ?? data.tool_call_id ?? data.id ?? Math.random());
      const name = String(data.toolName ?? data.tool_name ?? data.name ?? "tool").replace(/^cadre(_\w+)?[-_]{1,2}/, "");
      toolNames.set(id, name);
      yield { type: "tool-call", id, name, input: data.arguments ?? data.input ?? data.parameters ?? {} };
    } else if (/tool[._]execution[._](complete|end)$/.test(type) || type === "tool_result" || type === "tool.result") {
      const id = String(data.toolCallId ?? data.tool_call_id ?? data.id ?? "");
      const result = data.result as { content?: unknown } | undefined;
      const err = data.error as { message?: string } | string | undefined;
      const isError = data.success === false || !!err;
      yield { type: "tool-result", id, name: toolNames.get(id) ?? String(data.toolName ?? "tool"), output: typeof err === "string" ? err : (err?.message ?? result?.content ?? data.output ?? ""), isError };
    } else if (/(^|\.)error$/.test(type)) {
      if (data.severity !== "warning") failed = str(data.message) ?? str((data.error as { message?: string } | undefined)?.message) ?? "Copilot CLI error";
    }
  }
}
