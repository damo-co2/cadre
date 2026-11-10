import type { ProviderId, ProviderInfo } from "@grokbot/shared";
import { PROVIDER_IDS } from "@grokbot/shared";
import { ApiDriver } from "./drivers/api.js";
import { ClaudeCodeDriver } from "./drivers/cli-claude.js";
import { CodexDriver } from "./drivers/cli-codex.js";
import { GeminiCliDriver } from "./drivers/cli-gemini.js";
import { OpenCodeDriver } from "./drivers/cli-opencode.js";
import { PROVIDERS } from "./providers.js";
import type { DriverEvent, ModelDriver, ProviderCredentials } from "./types.js";

export * from "./types.js";
export { PROVIDERS } from "./providers.js";
export { ApiDriver, ClaudeCodeDriver, CodexDriver, GeminiCliDriver, OpenCodeDriver };

export type CredentialsLookup = (provider: ProviderId) => ProviderCredentials;

/** Builds a driver per provider from stored credentials. Cheap to construct; no network at build time. */
export class DriverRegistry {
  constructor(private lookup: CredentialsLookup) {}

  get(provider: ProviderId): ModelDriver {
    if (this.lookup(provider).disabled) return new DisabledDriver(provider);
    return this.build(provider);
  }

  private build(provider: ProviderId): ModelDriver {
    switch (provider) {
      case "claude-code":
        return new ClaudeCodeDriver();
      case "codex":
        return new CodexDriver();
      case "gemini-cli":
        return new GeminiCliDriver();
      case "opencode":
        return new OpenCodeDriver();
      default:
        return new ApiDriver(provider, this.lookup(provider));
    }
  }

  async describe(provider: ProviderId): Promise<ProviderInfo> {
    const meta = PROVIDERS[provider];
    const creds = this.lookup(provider);
    const st = creds.disabled
      ? { status: "off" as const, detail: "Turned off. Cadre won't use it, even though it is signed in on this Mac." }
      : await this.build(provider).status();
    return {
      id: provider,
      kind: meta.kind,
      label: meta.label,
      blurb: meta.blurb,
      status: st.status,
      statusDetail: st.detail,
      disabled: !!creds.disabled,
      hasKey: meta.kind === "api" ? !!(creds.apiKey || (meta.envKey && process.env[meta.envKey])) : undefined,
      baseUrl: creds.baseUrl ?? meta.defaultBaseUrl,
      defaultModel: meta.kind === "cli" && !creds.disabled ? ((await this.build(provider).listModels().catch(() => []))[0]?.id ?? meta.defaultModel) : meta.defaultModel,
    };
  }

  async describeAll(): Promise<ProviderInfo[]> {
    return Promise.all(PROVIDER_IDS.map((p) => this.describe(p)));
  }
}

/** Stands in for a provider the user turned off: lists no models and refuses every turn. */
class DisabledDriver implements ModelDriver {
  readonly toolMode = "native" as const;
  constructor(readonly provider: ProviderId) {}
  async status() {
    return { status: "error" as const, detail: "Turned off" };
  }
  async listModels() {
    return [];
  }
  // eslint-disable-next-line require-yield
  async *run(): AsyncIterable<DriverEvent> {
    const label = PROVIDERS[this.provider].label;
    yield { type: "error", message: `${label} is turned off. Turn it on in Settings → Models, or give this Bot another model.` };
  }
}
