import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { jsonSchema, streamText, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { ProviderId } from "@grokbot/shared";
import { PROVIDERS } from "../providers.js";
import type { DriverEvent, ModelDriver, ProviderCredentials, ProviderStatus, TurnInput } from "../types.js";

type ApiProviderId = Exclude<ProviderId, "claude-code" | "codex" | "gemini-cli" | "opencode">;

/**
 * One driver for every API-key provider, built on the Vercel AI SDK so streaming,
 * tool calling and message shapes are identical across vendors.
 */
export class ApiDriver implements ModelDriver {
  readonly toolMode = "native" as const;
  constructor(
    public readonly provider: ApiProviderId,
    private creds: ProviderCredentials,
  ) {}

  private get meta() {
    return PROVIDERS[this.provider];
  }

  private get apiKey(): string | null {
    return this.creds.apiKey ?? (this.meta.envKey ? (process.env[this.meta.envKey] ?? null) : null);
  }

  private get baseUrl(): string | undefined {
    return this.creds.baseUrl ?? this.meta.defaultBaseUrl ?? undefined;
  }

  async status(): Promise<ProviderStatus> {
    if (this.provider === "ollama") {
      try {
        const r = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
        return r.ok ? { status: "ready" } : { status: "error", detail: `Ollama returned ${r.status}` };
      } catch {
        return { status: "error", detail: "Ollama is not running. Start it with `ollama serve`." };
      }
    }
    return this.apiKey ? { status: "ready" } : { status: "needs-key" };
  }

  private model(modelId: string): LanguageModel {
    const apiKey = this.apiKey ?? undefined;
    switch (this.provider) {
      case "anthropic":
        return createAnthropic({ apiKey, baseURL: this.baseUrl })(modelId);
      case "openai":
        return createOpenAI({ apiKey, baseURL: this.baseUrl })(modelId);
      case "google":
        return createGoogleGenerativeAI({ apiKey, baseURL: this.baseUrl })(modelId);
      case "xai":
        return createXai({ apiKey, baseURL: this.baseUrl })(modelId);
      case "openrouter":
        return createOpenRouter({ apiKey, baseURL: this.baseUrl })(modelId);
      case "ollama":
        return createOpenAICompatible({
          name: "ollama",
          baseURL: `${this.baseUrl}/v1`,
          apiKey: "ollama",
        })(modelId);
    }
  }

  async listModels(): Promise<{ id: string; label?: string }[]> {
    const curated = this.meta.curatedModels.map((id) => ({ id }));
    try {
      const live = await this.fetchModels();
      if (live.length) return live;
    } catch {
      /* fall through to curated */
    }
    return curated;
  }

  private async fetchModels(): Promise<{ id: string; label?: string }[]> {
    const key = this.apiKey;
    const timeout = AbortSignal.timeout(4000);
    const asList = (ids: string[]) => ids.sort().map((id) => ({ id }));
    switch (this.provider) {
      case "anthropic": {
        if (!key) return [];
        const r = await fetch(`${this.baseUrl ?? "https://api.anthropic.com"}/v1/models?limit=100`, {
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
          signal: timeout,
        });
        const j = (await r.json()) as { data?: { id: string; display_name?: string }[] };
        return (j.data ?? []).map((m) => ({ id: m.id, label: m.display_name }));
      }
      case "openai": {
        if (!key) return [];
        const r = await fetch(`${this.baseUrl ?? "https://api.openai.com/v1"}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: timeout,
        });
        const j = (await r.json()) as { data?: { id: string }[] };
        return asList((j.data ?? []).map((m) => m.id).filter((id) => /^(gpt|o\d|chatgpt)/.test(id)));
      }
      case "google": {
        if (!key) return [];
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=100`, {
          signal: timeout,
        });
        const j = (await r.json()) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
        return (j.models ?? [])
          .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
          .map((m) => ({ id: m.name.replace(/^models\//, ""), label: m.displayName }));
      }
      case "xai": {
        if (!key) return [];
        const r = await fetch(`${this.baseUrl ?? "https://api.x.ai/v1"}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: timeout,
        });
        const j = (await r.json()) as { data?: { id: string }[] };
        return asList((j.data ?? []).map((m) => m.id));
      }
      case "openrouter": {
        const r = await fetch("https://openrouter.ai/api/v1/models", { signal: timeout });
        const j = (await r.json()) as { data?: { id: string; name?: string }[] };
        return (j.data ?? []).map((m) => ({ id: m.id, label: m.name })).sort((a, b) => a.id.localeCompare(b.id));
      }
      case "ollama": {
        const r = await fetch(`${this.baseUrl}/api/tags`, { signal: timeout });
        const j = (await r.json()) as { models?: { name: string }[] };
        return asList((j.models ?? []).map((m) => m.name));
      }
    }
  }

  async *run(input: TurnInput): AsyncIterable<DriverEvent> {
    const messages: ModelMessage[] = input.messages.map((m) => ({ role: m.role, content: m.content }));
    const tools: ToolSet = {};
    for (const t of input.tools ?? []) {
      tools[t.name] = tool({
        description: t.description,
        inputSchema: jsonSchema(t.inputSchema as never),
        execute: async (args: unknown) => {
          if (!input.executeTool) throw new Error(`No executor for tool ${t.name}`);
          return input.executeTool(t.name, args);
        },
        // Tool results are { content: [{type:"text"|"image"}] }; hand images to the model as media.
        toModelOutput: ({ output }) => {
          const content = (output as { content?: { type: string; text?: string; data?: string; mimeType?: string }[] } | undefined)?.content;
          if (!Array.isArray(content)) return { type: "json", value: output as never };
          return {
            type: "content",
            value: content.map((p) =>
              p.type === "image" && p.data
                ? { type: "image-data" as const, data: p.data, mediaType: p.mimeType ?? "image/png" }
                : { type: "text" as const, text: p.text ?? "" },
            ),
          };
        },
      });
    }

    const result = streamText({
      model: this.model(input.model),
      system: input.system,
      messages,
      tools: Object.keys(tools).length ? tools : undefined,
      abortSignal: input.signal,
      // Let the SDK loop over tool calls up to a sane bound (phase 3 replaces this with the runtime's own loop).
      stopWhen: ({ steps }) => steps.length >= 25,
    });

    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            yield { type: "text-delta", text: part.text };
            break;
          case "reasoning-delta":
            yield { type: "reasoning-delta", text: part.text };
            break;
          case "tool-call":
            yield { type: "tool-call", id: part.toolCallId, name: part.toolName, input: part.input };
            break;
          case "tool-result":
            yield { type: "tool-result", id: part.toolCallId, name: part.toolName, output: part.output };
            break;
          case "tool-error":
            yield {
              type: "tool-result",
              id: part.toolCallId,
              name: part.toolName,
              output: String((part.error as Error)?.message ?? part.error),
              isError: true,
            };
            break;
          case "error":
            yield { type: "error", message: errorMessage(part.error) };
            return;
          case "finish":
            yield {
              type: "done",
              stopReason: part.finishReason,
              usage: { inputTokens: part.totalUsage?.inputTokens, outputTokens: part.totalUsage?.outputTokens },
            };
            break;
          default:
            break;
        }
      }
    } catch (err) {
      if (input.signal?.aborted) {
        yield { type: "done", stopReason: "aborted" };
        return;
      }
      yield { type: "error", message: errorMessage(err) };
    }
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: string; responseBody?: string; statusCode?: number };
    const body = e.responseBody ? ` ${e.responseBody.slice(0, 400)}` : "";
    return `${e.message ?? String(err)}${body}`;
  }
  return String(err);
}
