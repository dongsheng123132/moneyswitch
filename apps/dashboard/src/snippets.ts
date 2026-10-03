// The Dashboard hands a key to an AI in exactly two formats: the skill (components/SkillForAi, text from
// skillText.ts / @moneyswitch/skill) and one raw HTTP example for POST /v1/fetch (below).
// Generated from the real origin; never hard-code a host or port here.

/** A paid URL to show in the raw HTTP example (any x402 endpoint the key is allowed to pay). */
export const EXAMPLE_PAID_URL = "https://example.com/paid";

export function restFetchCurl(origin: string, key: string, targetUrl: string = EXAMPLE_PAID_URL): string {
  return [
    `curl ${origin}/v1/fetch \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '{"url":"${targetUrl}","max_price":"0.05"}'`,
  ].join("\n");
}
