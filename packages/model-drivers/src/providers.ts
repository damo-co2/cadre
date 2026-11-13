import type { ProviderId, ProviderKind } from "@grokbot/shared";

export interface ProviderMeta {
  id: ProviderId;
  kind: ProviderKind;
  label: string;
  blurb: string;
  envKey?: string;
  defaultBaseUrl?: string;
  defaultModel: string;
  /** Fallback list when live listing is unavailable. */
  curatedModels: string[];
  /** CLI binary name for kind=cli. */
  bin?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    id: "anthropic",
    kind: "api",
    label: "Anthropic",
    blurb: "Claude models via API key.",
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-opus-5-5",
    curatedModels: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  },
  openai: {
    id: "openai",
    kind: "api",
    label: "OpenAI",
    blurb: "GPT models via API key.",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-5.1",
    curatedModels: ["gpt-5.1", "gpt-5", "gpt-5-mini", "gpt-4.1"],
  },
  google: {
    id: "google",
    kind: "api",
    label: "Google AI",
    blurb: "Gemini models via AI Studio API key.",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    defaultModel: "gemini-2.5-pro",
    curatedModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  xai: {
    id: "xai",
    kind: "api",
    label: "xAI",
    blurb: "Grok models via API key.",
    envKey: "XAI_API_KEY",
    defaultModel: "grok-4",
    curatedModels: ["grok-4", "grok-4-fast", "grok-3"],
  },
  openrouter: {
    id: "openrouter",
    kind: "api",
    label: "OpenRouter",
    blurb: "Hundreds of models behind one key.",
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4.5",
    curatedModels: ["anthropic/claude-sonnet-4.5", "openai/gpt-5", "google/gemini-2.5-pro", "x-ai/grok-4"],
  },
  ollama: {
    id: "ollama",
    kind: "api",
    label: "Ollama (local)",
    blurb: "Models running on this computer. No key needed.",
    envKey: "OLLAMA_BASE_URL",
    defaultBaseUrl: "http://localhost:11434",
    defaultModel: "llama3.1",
    curatedModels: ["llama3.1", "qwen2.5", "gemma3"],
  },
  "claude-code": {
    id: "claude-code",
    kind: "cli",
    label: "Claude (subscription)",
    blurb: "Uses your Claude Pro/Max plan through the Claude Code CLI.",
    bin: "claude",
    defaultModel: "opus",
    curatedModels: ["opus", "sonnet", "haiku"],
  },
  codex: {
    id: "codex",
    kind: "cli",
    label: "ChatGPT (subscription)",
    blurb: "Uses your ChatGPT Plus/Pro plan through the Codex CLI.",
    bin: "codex",
    defaultModel: "gpt-5.6-sol",
    // Fallback only (live list comes from Codex's cache): models every current Codex version accepts.
    curatedModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  },
  "gemini-cli": {
    id: "gemini-cli",
    kind: "cli",
    label: "Gemini (subscription)",
    blurb: "Uses your Google account through the Gemini CLI. Experimental.",
    bin: "gemini",
    defaultModel: "gemini-2.5-pro",
    curatedModels: ["gemini-3.1-pro-preview", "gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  },
  copilot: {
    id: "copilot",
    kind: "cli",
    label: "GitHub Copilot (subscription)",
    blurb: "Uses your GitHub Copilot plan through the Copilot CLI. Experimental.",
    bin: "copilot",
    defaultModel: "auto",
    // Model names from GitHub's Copilot CLI docs; "auto" lets Copilot choose. Run /model in `copilot` for your plan's list.
    curatedModels: ["auto", "claude-haiku-4.5", "gpt-5.3-codex", "gpt-6-astra"],
  },
  opencode: {
    id: "opencode",
    kind: "cli",
    label: "OpenCode (free models)",
    blurb: "OpenCode's free models, plus any provider you signed in to in OpenCode (NVIDIA, Ollama Cloud…).",
    bin: "opencode",
    defaultModel: "opencode/big-pickle",
    curatedModels: ["opencode/big-pickle"],
  },
};
