// The skill / install-prompt text is produced by @moneyswitch/skill (browser-safe, shared with the
// server's GET /skill.md). This file adds the few Dashboard-side helpers around it.
import { TEST_PAYMENT_HOST, TEST_PAYMENT_NETWORK, isValidBaseUrl, normalizeBaseUrl, renderInstallPrompt, type SkillAgent, type TestPaymentOffer } from "@moneyswitch/skill";
import type { AdminMeta, NetworkMode } from "./api";

export {
  renderSkill,
  renderInstallPrompt,
  AGENT_INFO,
  SKILL_AGENTS,
  SKILL_NAME,
  TEST_PAYMENT_HOST,
  TEST_PAYMENT_URL,
  guessAgentFromName,
  type SkillAgent,
} from "@moneyswitch/skill";

/**
 * The ten-minute path (SPEC.md §0, §6): is the test payment on offer for a key of this network type? Only for a testnet key, and only
 * when the instance enables Monad testnet (the one chain the test receiver accepts); a mainnet key (or one from before network modes,
 * which could pay on a mainnet) never gets it, whatever else the instance enables. Unknown (meta not loaded) counts as no.
 */
export function testPaymentAvailable(meta: Pick<AdminMeta, "networks"> | null | undefined, networkMode: NetworkMode | null | undefined): boolean {
  if (!meta || networkMode !== "testnet") return false;
  return (meta.networks ?? []).some((n) => n.network === TEST_PAYMENT_NETWORK);
}

/** The hosts a new key gets: what was typed plus, when it is on offer and ticked, the test receiver's host. No duplicates (any letter case). */
export function withTestHost(typed: string[], include: boolean): string[] {
  const hosts = typed.map((h) => h.trim()).filter(Boolean);
  if (include && !hosts.some((h) => h.toLowerCase() === TEST_PAYMENT_HOST)) hosts.push(TEST_PAYMENT_HOST);
  return hosts;
}

/**
 * Base URL to put in a skill: MONEYSWITCH_PUBLIC_URL when the operator set one
 * (admin meta says so), else the origin the Dashboard was opened from.
 *
 * Never throws: it runs while a page renders, and a throw there unmounts the
 * whole app. An origin the skill renderer refuses (for example a host name with
 * an underscore such as http://moneyswitch_srv:4020, or a trailing dot) is
 * returned as it is; buildInstallText() then reports it as "bad_url" and
 * SkillForAi shows a warning, while the rest of the page keeps working.
 */
export function skillBaseUrl(meta: Pick<AdminMeta, "public_base" | "public_base_from_env"> | null | undefined, origin: string): string {
  if (meta?.public_base_from_env && meta.public_base && isValidBaseUrl(meta.public_base)) return normalizeBaseUrl(meta.public_base);
  return isValidBaseUrl(origin) ? normalizeBaseUrl(origin) : String(origin ?? "").trim();
}

/** True for something that can be a MoneyKey as far as the skill renderer is concerned. */
export function looksLikeMoneyKey(s: string): boolean {
  return /^mk_live_[A-Za-z0-9]{8,}$/.test(s.trim());
}

/** Masks the secret for on-screen display; the copied text keeps it. */
export function maskedForDisplay(text: string, key: string): string {
  if (!key) return text;
  const masked = key.length > 16 ? `${key.slice(0, 12)}${"•".repeat(8)}${key.slice(-4)}` : "•".repeat(8);
  return text.split(key).join(masked);
}

export interface InstallTextResult {
  /** The full text to copy (contains the key), or null when the inputs cannot produce one. */
  text: string | null;
  /** The same text with the key masked, for display. */
  display: string | null;
  error: "no_key" | "bad_key" | "bad_url" | null;
}

/**
 * Builds the install text for the Dashboard, turning renderer exceptions into a small error code.
 * The address is checked first: it does not depend on the key, and no key can fix it.
 */
export function buildInstallText(p: {
  baseUrl: string;
  key: string;
  keyName?: string | null;
  agent: SkillAgent;
  testPayment?: TestPaymentOffer | null;
  networkMode?: NetworkMode | null;
}): InstallTextResult {
  if (!isValidBaseUrl(p.baseUrl)) return { text: null, display: null, error: "bad_url" };
  const key = p.key.trim();
  if (!key) return { text: null, display: null, error: "no_key" };
  if (!looksLikeMoneyKey(key)) return { text: null, display: null, error: "bad_key" };
  const text = renderInstallPrompt({ baseUrl: p.baseUrl, key, keyName: p.keyName, agent: p.agent, testPayment: p.testPayment, networkMode: p.networkMode });
  return { text, display: maskedForDisplay(text, key), error: null };
}
