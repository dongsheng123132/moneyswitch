import { AGENT_INFO, SHARED_SKILLS_ROOT, SKILL_NAME, type SkillAgent } from "./agents.js";
import { renderSkill } from "./skill.js";
import { assertKey, normalizeBaseUrl } from "./validate.js";

export interface InstallPromptInput {
  baseUrl: string;
  key: string;
  keyName?: string | null;
  agent: SkillAgent;
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
  const skill = renderSkill({ baseUrl: base, key: input.key, keyName: input.keyName }).replace(/\n+$/, "");

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
    `[MoneySwitch${info.label === "Other" ? "" : " / " + info.label}] 给你付费能力 / Give yourself a payment ability`,
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
    "保存后只查询额度 / Then call GET " + base + "/v1/status with the key; do not make a payment during installation.",
    "正常只回复两句话：已接入；今日可用、单笔上限及审批线，尚未付款。Reply in at most two sentences: setup result, today's remaining budget, per-request limit, approval threshold, and no payment made. Omit file counts, directory audits and diagnostics unless blocked or asked.",
    "",
    "密钥保密 / The key is a secret: never repeat it in chat, never commit it to git, never send it anywhere but that server.",
    "",
    SKILL_BEGIN_MARKER,
    skill,
    SKILL_END_MARKER,
    "",
  ].join("\n");
}
