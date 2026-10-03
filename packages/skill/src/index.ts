// Browser-safe on purpose: no node: imports, no process/Buffer, no I/O.
// The Dashboard bundles this file and the server imports the same code, so the
// text an operator copies and the text GET /skill.md serves cannot drift.
export { renderSkill, SKILL_DESCRIPTION, type RenderSkillInput } from "./skill.js";
export { renderInstallPrompt, SKILL_BEGIN_MARKER, SKILL_END_MARKER, type InstallPromptInput } from "./prompt.js";
export {
  AGENT_INFO,
  SKILL_AGENTS,
  SKILL_NAME,
  SHARED_SKILLS_ROOT,
  isSkillAgent,
  guessAgentFromName,
  type AgentInfo,
  type SkillAgent,
} from "./agents.js";
export { normalizeBaseUrl, isValidBaseUrl } from "./validate.js";
export {
  TEST_PAYMENT_URL,
  TEST_PAYMENT_HOST,
  TEST_PAYMENT_NETWORK,
  TEST_PAYMENT_PRICE,
  allowsTestPayment,
  offersTestPayment,
  type TestPaymentOffer,
} from "./testpay.js";
