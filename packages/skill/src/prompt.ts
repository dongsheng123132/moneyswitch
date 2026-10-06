import { AGENT_INFO, SHARED_SKILLS_ROOT, SKILL_NAME, type SkillAgent } from "./agents.js";
import { renderSkill } from "./skill.js";
import { offersTestPayment, TEST_PAYMENT_PRICE, TEST_PAYMENT_URL, type TestPaymentOffer } from "./testpay.js";
import { assertKey, normalizeBaseUrl } from "./validate.js";

export interface InstallPromptInput {
  baseUrl: string;
  key: string;
  keyName?: string | null;
  agent: SkillAgent;
  /**
   * The ten-minute path: when this is a testnet key on an instance that enables the receiver's testnet and the key may pay the testnet receiver, the prompt asks the AI for one test
   * payment after the status call and for its transaction hash. Anything else (no offer, mainnet, the host not allowed) leaves the prompt as it
   * always was: no payment during installation.
   */
  testPayment?: TestPaymentOffer | null;
  /** The key's network type (SPEC.md §1): written into the skill and the first line. null / undefined = a key from before network modes: nothing is said. */
  networkMode?: "testnet" | "mainnet" | null;
}

export const SKILL_BEGIN_MARKER = `-----BEGIN MONEYSWITCH SKILL (${SKILL_NAME}/SKILL.md)-----`;
export const SKILL_END_MARKER = "-----END MONEYSWITCH SKILL-----";

/**
 * The one text the user pastes into their agent: a short zh+en instruction
 * followed by the personalized SKILL.md between clear BEGIN/END markers.
 */
export function renderInstallPrompt(input: InstallPromptInput): string {
  const base = normalizeBaseUrl(input.baseUrl);
  assertKey(input.key);
  const info = AGENT_INFO[input.agent] ?? AGENT_INFO.other;
  const skill = renderSkill({ baseUrl: base, key: input.key, keyName: input.keyName, networkMode: input.networkMode }).replace(/\n+$/, "");
  const testPay = offersTestPayment(input.testPayment);
  const networkNote =
    input.networkMode === "mainnet"
      ? " · 主网，真 USDC，真钱 / mainnet: real USDC, real money"
      : input.networkMode === "testnet" || testPay
        ? " · 测试网，测试 USDC 无真实价值 / testnet: test USDC with no real value"
        : "";

  const where: string[] = [];
  if (info.path) {
    where.push(`    ${info.path}`);
    if (info.windowsPath) where.push(`    (Windows: ${info.windowsPath}; ~ is the user's home directory)`);
    if (info.hint) where.push(`    (${info.hint})`);
  } else {
    where.push(`    ${SKILL_NAME}/SKILL.md  inside your skills directory (one folder named ${SKILL_NAME}, one file named exactly SKILL.md)`);
    where.push("    (If you have no skills directory, keep the text in your persistent memory or standing instructions instead.)");
  }

  return [
    `[MoneySwitch${info.label === "Other" ? "" : " / " + info.label}] 给你付费能力 / Give yourself a payment ability` + networkNote,
    "",
    "请原样保存为你自己的 skill / Save everything between the BEGIN and END markers, verbatim, at:",
    "",
    ...where,
    "",
    `已有同名私有 skill 就留底后原子替换，勿扫描其他 AI 的目录。Replace this agent's existing ${SKILL_NAME} atomically (back up first); do not search unrelated agents' folders.`,
    `勿写入共用目录（如 ${SHARED_SKILLS_ROOT}），共用旧版保留原样。Never save it in a folder that other agents share (for example ${SHARED_SKILLS_ROOT}); leave shared copies unchanged.`,
    "",
    "无法写入则只报告目标路径和原因，勿复述密钥。If you cannot write there, report the path and blocker, without the key.",
    "",
    ...(testPay
      ? [
          `保存后先查询额度，再做一笔测试付款（${TEST_PAYMENT_PRICE} 测试 USDC，无真实价值）/ Then call GET ${base}/v1/status with the key, then make ONE test payment (${TEST_PAYMENT_PRICE} test USDC, no real value): POST ${base}/v1/fetch with {"url":"${TEST_PAYMENT_URL}","method":"GET","max_price":"${TEST_PAYMENT_PRICE}"}. Do it once; if it fails, say why and stop: never retry it or pay another way.`,
          "正常只回复三行：是否已接入；测试付款的 tx_hash；今日剩余额度（remaining_today）。Reply in at most three short lines: setup result; the test payment's tx_hash; today's remaining budget (remaining_today). Omit file counts, directory audits and diagnostics unless blocked or asked.",
        ]
      : [
          "保存后只查询额度 / Then call GET " + base + "/v1/status with the key; do not make a payment during installation.",
          "正常只回复两行：是否已接入（尚未付款）；今日可用、单笔上限、审批线。Reply in at most two short lines: setup result (no payment made); today's remaining budget, per-request limit and approval threshold. Omit file counts, directory audits and diagnostics unless blocked or asked.",
        ]),
    "",
    "密钥保密 / The key is a secret: never repeat it in chat, never commit it to git, never send it anywhere but that server.",
    "",
    SKILL_BEGIN_MARKER,
    skill,
    SKILL_END_MARKER,
    "",
  ].join("\n");
}
