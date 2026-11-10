import { z } from "zod";
import type { Store } from "@grokbot/db";
import type { ComputerService, ToolCallResult } from "@grokbot/sandbox";
import type { Bot, SecureFormField, SecureFormRequest, ServerEvent, VaultKind } from "@grokbot/shared";
import { APPROVAL_TTL_MS } from "@grokbot/shared";
import type { RuntimeToolSpec } from "./automation.js";

/**
 * Vault + Secure Form, Grok Bot style: a Bot can see which logins/cards/secrets exist and
 * ask for them to be used, but values are filled by the server and never reach the model.
 * Login lookup order: Vault first, then a Secure Form card the user fills in chat.
 */

const text = (t: string): ToolCallResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): ToolCallResult => ({ isError: true, content: [{ type: "text", text: t }] });

export class VaultTools {
  private waiters = new Map<string, (r: SecureFormRequest) => void>();

  constructor(
    private store: Store,
    private computer: ComputerService,
    private emit: (e: ServerEvent) => void,
  ) {}

  specs(): RuntimeToolSpec[] {
    const mk = (name: string, description: string, zodShape: Record<string, z.ZodTypeAny>): RuntimeToolSpec => ({
      name,
      description,
      zodShape,
      inputSchema: z.toJSONSchema(z.object(zodShape)) as Record<string, unknown>,
    });
    return [
      mk("vault_list", "List the user's saved logins, cards, contact info and secrets (titles, websites, usernames only; never the values).", {}),
      mk(
        "vault_fill",
        "Fill a secret from the Vault into a field on your screen without seeing it. Use for passwords, card numbers, security codes and API keys. Pick the item by id or title; pick the field by ref from browser_read_page.",
        {
          item: z.string().describe("Vault item id or title (case-insensitive)"),
          field: z.enum(["password", "number", "securityCode", "value", "username", "expiry", "nameOnCard", "billingAddress"]).describe("Which stored field to fill"),
          ref: z.string().optional().describe("Element ref from browser_read_page"),
          selector: z.string().optional().describe("CSS selector instead of ref"),
          submit: z.boolean().optional().describe("Press Enter after filling"),
        },
      ),
      mk(
        "shell_run_with_secrets",
        "Run a shell command with Vault secrets injected as environment variables (the values never appear in your context). Map env var names to Vault item ids/titles.",
        {
          command: z.string(),
          secrets: z.record(z.string(), z.string()).describe('e.g. {"LINEAR_API_KEY": "Linear token"}'),
          timeoutSec: z.number().int().min(1).max(600).optional(),
        },
      ),
      mk(
        "request_secret",
        "Ask the user for a password, one-time code, API key or card through a Secure Form card. You never see the value: it is saved to the Vault and you then use vault_fill / shell_run_with_secrets. Blocks until the user responds (up to 30 min).",
        {
          label: z.string().describe('Why you need it, e.g. "Sign in to Acme Portal" or "Linear API key"'),
          fields: z
            .array(z.object({ key: z.string(), label: z.string(), secret: z.boolean().default(true) }))
            .min(1)
            .max(6)
            .describe("Fields to collect; key is used as the stored field name (password, username, value, number, securityCode, expiry…)"),
          saveAs: z.enum(["login", "card", "secret"]).default("secret"),
          website: z.string().optional().describe("For logins: the site this is for"),
        },
      ),
    ];
  }

  isVaultTool(name: string): boolean {
    return this.specs().some((s) => s.name === name);
  }

  /** The runtime hands over the active turn so the card can land in the right message. */
  async call(
    bot: Bot,
    name: string,
    input: unknown,
    turn: { conversationId: string; messageId: string; signal?: AbortSignal; pushPart: (p: { type: "secure-form"; requestId: string }) => void } | null,
  ): Promise<ToolCallResult> {
    const spec = this.specs().find((s) => s.name === name);
    if (!spec) return fail(`Unknown tool ${name}`);
    const parsed = z.object(spec.zodShape).safeParse(input ?? {});
    if (!parsed.success) return fail(`Invalid input for ${name}: ${parsed.error.message}`);
    const a = parsed.data as Record<string, unknown>;

    switch (name) {
      case "vault_list": {
        const items = this.store.vault.list();
        if (!items.length) return text("The Vault is empty. Ask the user to add items in Settings → Vault, or use request_secret.");
        return text(
          items
            .map((i) => {
              const extra =
                i.kind === "login"
                  ? `${i.website ?? ""} ${i.username ? `user=${i.username}` : ""}`
                  : i.kind === "card"
                    ? `•••• ${i.last4 ?? "????"} ${i.expiry ?? ""} ${i.nameOnCard ?? ""}`
                    : i.kind === "contact"
                      ? JSON.stringify(i.contact ?? {})
                      : "";
              return `[${i.id.slice(0, 8)}] ${i.kind}: "${i.title}" ${extra.trim()}${i.hints ? ` — hint: ${i.hints}` : ""}`;
            })
            .join("\n"),
        );
      }
      case "vault_fill": {
        const item = this.find(String(a.item));
        if (!item) return fail(`No Vault item matching "${a.item}". Use vault_list.`);
        const field = String(a.field);
        const value = this.fieldValue(item.id, field);
        if (!value) return fail(`Vault item "${item.title}" has no ${field}.`);
        if (!a.ref && !a.selector) return fail("Pass ref (from browser_read_page) or selector.");
        return this.computer.fillSecret(bot.id, { ref: a.ref as string | undefined, selector: a.selector as string | undefined }, value, {
          submit: !!a.submit,
        });
      }
      case "shell_run_with_secrets": {
        const env: Record<string, string> = {};
        for (const [envName, ref] of Object.entries(a.secrets as Record<string, string>)) {
          if (!/^[A-Z_][A-Z0-9_]*$/i.test(envName)) return fail(`Invalid env var name ${envName}`);
          const item = this.find(ref);
          if (!item) return fail(`No Vault item matching "${ref}" for ${envName}.`);
          const value = this.fieldValue(item.id, "value") ?? this.fieldValue(item.id, "password");
          if (!value) return fail(`Vault item "${item.title}" has no secret value.`);
          env[envName] = value;
        }
        return this.computer.callTool(bot.id, "shell_run", { command: a.command, timeoutSec: a.timeoutSec, _env: env }, { signal: turn?.signal });
      }
      case "request_secret": {
        if (!turn) return fail("request_secret only works during a conversation turn.");
        const fields = (a.fields as SecureFormField[]).map((f) => ({ key: f.key, label: f.label, secret: f.secret !== false }));
        const req = this.store.secureForms.create({
          conversationId: turn.conversationId,
          botId: bot.id,
          messageId: turn.messageId,
          label: String(a.label),
          fields,
          saveAs: a.saveAs as VaultKind,
          expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
        });
        this.emit({ type: "secureform.requested", request: req });
        turn.pushPart({ type: "secure-form", requestId: req.id });
        this.emit({ type: "bot.status", botId: bot.id, status: "needs-attention" });
        const website = a.website as string | undefined;
        const done = await new Promise<SecureFormRequest | null>((resolve) => {
          this.waiters.set(req.id, (r) => resolve(r));
          const t = setTimeout(() => {
            const r = this.store.secureForms.resolve(req.id, "expired");
            if (r) this.finish(r);
          }, APPROVAL_TTL_MS);
          turn.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve(null);
            },
            { once: true },
          );
        });
        this.emit({ type: "bot.status", botId: bot.id, status: "working" });
        if (!done) return fail("Stopped before the user responded.");
        if (done.status !== "filled" || !done.vaultItemId) return fail(done.status === "expired" ? "The Secure Form expired." : "The user declined to provide it.");
        const item = this.store.vault.get(done.vaultItemId);
        if (item && website && !item.website) this.store.vault.update(item.id, { website });
        return text(`Saved to the Vault as "${item?.title ?? done.label}" [${done.vaultItemId.slice(0, 8)}]. Use vault_fill or shell_run_with_secrets with it; you cannot read the value.`);
      }
    }
    return fail(`Unhandled tool ${name}`);
  }

  /** Called by the API route when the user submits the card. */
  fill(id: string, values: Record<string, string>, title?: string): SecureFormRequest | undefined {
    const req = this.store.secureForms.get(id);
    if (!req || req.status !== "pending") return req;
    const item = this.store.vault.create({
      kind: req.saveAs,
      title: title?.trim() || req.label,
      username: values.username,
      password: values.password ?? (req.saveAs === "login" ? values.value : undefined),
      number: values.number,
      securityCode: values.securityCode,
      expiry: values.expiry,
      nameOnCard: values.nameOnCard,
      value: values.value ?? values.token ?? values.apiKey ?? values.code ?? (req.saveAs === "secret" ? Object.values(values)[0] : undefined),
      hints: `Provided via Secure Form for: ${req.label}`,
    });
    this.emit({ type: "vault.updated", item });
    const resolved = this.store.secureForms.resolve(id, "filled", item.id);
    if (resolved) this.finish(resolved);
    return resolved;
  }

  cancel(id: string): SecureFormRequest | undefined {
    const resolved = this.store.secureForms.resolve(id, "cancelled");
    if (resolved) this.finish(resolved);
    return resolved;
  }

  private finish(r: SecureFormRequest) {
    this.emit({ type: "secureform.resolved", request: r });
    const w = this.waiters.get(r.id);
    this.waiters.delete(r.id);
    w?.(r);
  }

  private find(ref: string) {
    const items = this.store.vault.list();
    const needle = ref.trim().toLowerCase();
    return (
      items.find((i) => i.id === ref || i.id.startsWith(ref)) ??
      items.find((i) => i.title.toLowerCase() === needle) ??
      items.find((i) => i.title.toLowerCase().includes(needle) || (i.website ?? "").toLowerCase().includes(needle))
    );
  }

  private fieldValue(id: string, field: string): string | undefined {
    const item = this.store.vault.get(id);
    if (!item) return undefined;
    if (field === "username") return item.username ?? undefined;
    if (field === "expiry") return item.expiry ?? undefined;
    if (field === "nameOnCard") return item.nameOnCard ?? undefined;
    const s = this.store.vault.secretsOf(id);
    return (s as Record<string, string | undefined>)[field];
  }
}
