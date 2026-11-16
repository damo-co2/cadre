/**
 * Backup models: when a Bot's main model runs out of credit or hits its plan's usage limit, the turn is
 * retried on the Bot's backup model, and the main model is skipped for a while so every turn doesn't fail first.
 */
export const OUT_OF_CREDIT_COOLDOWN_MS = 30 * 60_000;

// Provider wording for "no credit / quota / usage left" (API keys and subscription CLIs). Plain per-minute
// rate limits ("rate_limit_error", "Too many requests") are not here: those pass, so the main model is kept.
const OUT_OF_CREDIT = [
  /credit balance is too low/i,
  /insufficient[_ ]?(quota|credits?|funds|balance)/i,
  /exceeded your (current )?(quota|monthly|weekly|daily)/i,
  /quota[_ ]?(exceeded|exhausted)/i,
  /resource[_ ]?exhausted/i,
  /(out of|no|not enough) (remaining )?credits?/i,
  /credits? (have |has )?(run|ran) out/i,
  /usage limit/i,
  /(weekly|monthly|daily|5-hour|five-hour|session) limit (reached|hit|exceeded)/i,
  /you'?ve hit your( \w+)? limit/i,
  /limit reached\|\d+/i, // Claude Code: "Claude AI usage limit reached|<epoch>"
  /payment required|\b402\b/i,
  /billing (hard )?limit|check your (plan and )?billing/i,
  /premium requests?.*(allowance|limit|quota)|(allowance|quota).*premium requests?/i,
];

export function isOutOfCredit(message: string | null | undefined): boolean {
  return !!message && OUT_OF_CREDIT.some((re) => re.test(message));
}
