// The skill / install-prompt text is produced by @moneyswitch/skill (browser-safe, shared with the
// server's GET /skill.md). This file adds the few Dashboard-side helpers around it.
import { isValidBaseUrl, normalizeBaseUrl, renderInstallPrompt, type SkillAgent } from "@moneyswitch/skill";
import type { AdminMeta } from "./api";

export {
  renderSkill,
  renderInstallPrompt,
  AGENT_INFO,
  SKILL_AGENTS,
  SKILL_NAME,
  guessAgentFromName,
  type SkillAgent,
} from "@moneyswitch/skill";

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
export function buildInstallText(p: { baseUrl: string; key: string; keyName?: string | null; agent: SkillAgent }): InstallTextResult {
  if (!isValidBaseUrl(p.baseUrl)) return { text: null, display: null, error: "bad_url" };
  const key = p.key.trim();
  if (!key) return { text: null, display: null, error: "no_key" };
  if (!looksLikeMoneyKey(key)) return { text: null, display: null, error: "bad_key" };
  const text = renderInstallPrompt({ baseUrl: p.baseUrl, key, keyName: p.keyName, agent: p.agent });
  return { text, display: maskedForDisplay(text, key), error: null };
}
