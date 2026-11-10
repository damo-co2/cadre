import { useEffect, useState } from "react";
import { api } from "./api";
import { useStore } from "./store";

const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude",
  codex: "ChatGPT",
  "gemini-cli": "Gemini",
  opencode: "OpenCode",
  anthropic: "Anthropic API",
  openai: "OpenAI API",
  google: "Google AI",
  xai: "xAI",
  openrouter: "OpenRouter",
  ollama: "Ollama",
};

/** "codex:gpt-5.6-sol" → "ChatGPT · gpt-5.6-sol". */
export function prettyModel(ref: string | null | undefined): string {
  if (!ref) return "none";
  const i = ref.indexOf(":");
  if (i < 0) return ref;
  const provider = ref.slice(0, i);
  const model = ref.slice(i + 1).replace(/^opencode\//, "");
  return `${PROVIDER_NAMES[provider] ?? provider} · ${model}`;
}

export interface EffectiveDefault {
  modelRef: string;
  source: "space" | "app" | "auto";
  spaceName: string | null;
}

/**
 * The model a Bot with no model of its own really gets in this space (space default → app
 * default → automatic pick). Refreshes when the app default, spaces or providers change.
 */
export function useDefaultModel(spaceId: string | null | undefined): EffectiveDefault | null {
  const appDefault = useStore((s) => s.settings.defaultModelRef);
  const spaces = useStore((s) => s.spaces);
  const [value, setValue] = useState<EffectiveDefault | null>(null);
  const spaceDefault = spaces.find((x) => x.id === spaceId)?.defaultModelRef ?? null;
  useEffect(() => {
    let live = true;
    void api
      .defaultModel(spaceId)
      .then((v) => live && setValue(v))
      .catch(() => live && setValue(null));
    return () => {
      live = false;
    };
  }, [spaceId, appDefault, spaceDefault]);
  return value;
}

/** Label for a model picker's "use the default" option, naming the model it resolves to. */
export function defaultLabel(d: EffectiveDefault | null, fallback = "Default"): string {
  if (!d) return fallback;
  const where = d.source === "space" ? `${d.spaceName ?? "space"} default` : d.source === "app" ? "app default" : "picked automatically";
  return `Default: ${prettyModel(d.modelRef)} (${where})`;
}
