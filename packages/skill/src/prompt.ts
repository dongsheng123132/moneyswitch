import { AGENT_INFO, SKILL_NAME, type SkillAgent } from "./agents.js";
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
    "请把下面 BEGIN 和 END 之间的全部内容，原样保存为你自己的 skill 文件，路径：",
    "Save everything between the BEGIN and END markers, verbatim, as your own skill file at:",
    "",
    ...where,
    "",
    "如果无法写入该位置，请把路径和内容展示给我，由我手动保存。",
    "If you cannot write there, show me the path and the content instead.",
    "",
    "保存后，用 skill 里的 key 调用 GET " + base + "/v1/status，告诉我剩余额度。",
    "Then call GET " + base + "/v1/status with the key from the skill and tell me the remaining budget.",
    "",
    "这是一把密钥：不要在聊天里复述它，不要提交到 git，不要发给除该服务器以外的任何地址。",
    "The key is a secret: never repeat it in chat, never commit it to git, never send it anywhere but that server.",
    "",
    SKILL_BEGIN_MARKER,
    skill,
    SKILL_END_MARKER,
    "",
  ].join("\n");
}
