import type { ProviderId } from "@grokbot/shared";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** JSON-schema tool definition exposed to API models. CLI drivers get tools via MCP (phase 2). */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerConfig {
  name: string;
  /** Remote HTTP/SSE server url or local stdio command. */
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface TurnInput {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  mcpServers?: McpServerConfig[];
  /** Opaque driver session handle from a previous turn (e.g. Claude Code session id). */
  sessionId?: string;
  cwd?: string;
  signal?: AbortSignal;
  /** Called by the driver when a tool call needs executing (API drivers only). */
  executeTool?: (name: string, input: unknown) => Promise<unknown>;
}

export type DriverEvent =
  | { type: "session"; sessionId: string }
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; name: string; output: unknown; isError?: boolean }
  | { type: "status"; text: string }
  | { type: "done"; usage?: { inputTokens?: number; outputTokens?: number }; stopReason?: string }
  | { type: "error"; message: string };

export interface ProviderStatus {
  status: "ready" | "needs-key" | "needs-signin" | "not-installed" | "error";
  detail?: string;
}

export interface ModelDriver {
  readonly provider: ProviderId;
  /**
   * How this driver receives tools: "native" (API tool calling), "mcp" (the CLI connects to our
   * MCP server) or "prompt" (tool specs go in the prompt and calls are parsed from the output).
   */
  readonly toolMode: "native" | "mcp" | "prompt";
  status(): Promise<ProviderStatus>;
  listModels(): Promise<{ id: string; label?: string }[]>;
  run(input: TurnInput): AsyncIterable<DriverEvent>;
}

export interface ProviderCredentials {
  apiKey: string | null;
  baseUrl: string | null;
  /** Turned off by the user: the registry hands out a driver that refuses every turn. */
  disabled?: boolean;
}
