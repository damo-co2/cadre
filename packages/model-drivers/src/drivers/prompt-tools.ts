import { randomUUID } from "node:crypto";
import type { DriverEvent, ToolDef, TurnInput } from "../types.js";

/**
 * Tool calling over plain text, for CLIs that cannot (yet) use our MCP server. The tool
 * catalogue goes into the system prompt; the model emits one call per reply inside
 * <<tool>>…<</tool>>; the driver executes it and resumes the CLI session with the result.
 */

export const TOOL_OPEN = "<<tool>>";
export const TOOL_CLOSE = "<</tool>>";
export const MAX_PROMPT_TOOL_STEPS = 30;

export function toolCatalogue(tools: ToolDef[]): string {
  if (!tools.length) return "";
  const lines = [
    "## Tools",
    `You can use tools. To call one, end your reply with exactly one block on its own line:`,
    `${TOOL_OPEN}{"name":"<tool name>","input":{...}}${TOOL_CLOSE}`,
    "Say nothing after the block. The result comes back in the next message; then continue (call another tool, or answer). Never invent results.",
    "When you are done, reply normally without a tool block.",
    "",
  ];
  for (const t of tools) {
    const schema = JSON.stringify(t.inputSchema).slice(0, 1200);
    lines.push(`- ${t.name}: ${t.description.slice(0, 400)}\n  input schema: ${schema}`);
  }
  return lines.join("\n");
}

export function extractToolCall(text: string): { before: string; call: { name: string; input: unknown } | null; raw: string | null } {
  const start = text.lastIndexOf(TOOL_OPEN);
  if (start < 0) return { before: text, call: null, raw: null };
  const end = text.indexOf(TOOL_CLOSE, start);
  const body = end < 0 ? text.slice(start + TOOL_OPEN.length) : text.slice(start + TOOL_OPEN.length, end);
  const before = text.slice(0, start).trimEnd();
  try {
    const parsed = JSON.parse(body.trim()) as { name?: string; input?: unknown };
    if (!parsed.name) return { before, call: null, raw: body };
    return { before, call: { name: parsed.name, input: parsed.input ?? {} }, raw: body };
  } catch {
    return { before, call: null, raw: body };
  }
}

export function formatToolResult(name: string, result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined)?.content;
  const text = Array.isArray(content)
    ? content.map((p) => (p.type === "text" ? p.text ?? "" : p.type === "image" ? "[image omitted in this transport: use browser_read_page/get_text instead]" : "")).join("\n")
    : typeof result === "string"
      ? result
      : JSON.stringify(result);
  const errored = (result as { isError?: boolean } | undefined)?.isError ? " (error)" : "";
  return `Tool result for ${name}${errored}:\n${text.slice(0, 30_000)}`;
}

/**
 * Drives one CLI turn with prompt-level tool calls. `runOnce` runs the CLI for a prompt (resuming
 * `sessionId` when set) and yields driver events plus the final assistant text.
 */
export async function* promptToolLoop(
  input: TurnInput,
  runOnce: (prompt: string, sessionId: string | undefined) => AsyncGenerator<DriverEvent, { text: string; sessionId: string | undefined }>,
  firstPrompt: string,
): AsyncIterable<DriverEvent> {
  let sessionId = input.sessionId;
  let prompt = firstPrompt;
  for (let step = 0; step < MAX_PROMPT_TOOL_STEPS; step++) {
    const gen = runOnce(prompt, sessionId);
    let text = "";
    let done: { text: string; sessionId: string | undefined } | null = null;
    let buffered = "";
    while (true) {
      const n = await gen.next();
      if (n.done) {
        done = n.value;
        break;
      }
      const ev = n.value;
      if (ev.type === "text-delta") {
        // Hold back text once a tool block starts so the raw JSON never reaches the transcript.
        buffered += ev.text;
        const idx = buffered.indexOf(TOOL_OPEN);
        if (idx < 0) {
          const keep = Math.max(0, buffered.length - TOOL_OPEN.length);
          const emitNow = buffered.slice(0, keep);
          if (emitNow) {
            text += emitNow;
            yield { type: "text-delta", text: emitNow };
          }
          buffered = buffered.slice(keep);
        }
        continue;
      }
      if (ev.type === "session") sessionId = ev.sessionId;
      // Before a card (tool call, reasoning, status) goes out, release held-back text that can't be
      // the start of a tool block, so text and cards keep their real order.
      if (ev.type !== "session" && ev.type !== "done" && buffered && buffered.indexOf(TOOL_OPEN) < 0) {
        const keep = partialPrefixLength(buffered, TOOL_OPEN);
        const emitNow = buffered.slice(0, buffered.length - keep);
        if (emitNow) {
          text += emitNow;
          yield { type: "text-delta", text: emitNow };
        }
        buffered = buffered.slice(buffered.length - keep);
      }
      if (ev.type === "error") {
        yield ev;
        return;
      }
      if (ev.type !== "done") yield ev;
    }
    sessionId = done?.sessionId ?? sessionId;
    const full = text + buffered;
    const { before, call, raw } = extractToolCall(full);
    const tail = before.slice(text.length);
    if (tail) yield { type: "text-delta", text: tail };
    if (!call) {
      if (raw) yield { type: "status", text: "Malformed tool call ignored." };
      yield { type: "done" };
      return;
    }
    const id = `call_${randomUUID().slice(0, 8)}`;
    yield { type: "tool-call", id, name: call.name, input: call.input };
    let result: unknown;
    try {
      result = input.executeTool ? await input.executeTool(call.name, call.input) : { isError: true, content: [{ type: "text", text: "No tool executor" }] };
    } catch (err) {
      result = { isError: true, content: [{ type: "text", text: (err as Error).message }] };
    }
    const isError = (result as { isError?: boolean })?.isError === true;
    yield { type: "tool-result", id, name: call.name, output: result, isError };
    if (input.signal?.aborted) {
      yield { type: "done", stopReason: "aborted" };
      return;
    }
    prompt = formatToolResult(call.name, result);
  }
  yield { type: "status", text: `Stopped after ${MAX_PROMPT_TOOL_STEPS} tool calls in one turn.` };
  yield { type: "done" };
}

/** Length of the longest suffix of `s` that is a proper prefix of `token`. */
function partialPrefixLength(s: string, token: string): number {
  for (let n = Math.min(s.length, token.length - 1); n > 0; n--) if (token.startsWith(s.slice(-n))) return n;
  return 0;
}
