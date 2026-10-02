/**
 * The agents we know how to install the skill into, and where each one looks
 * for skills.
 *
 * Every path below was checked against the tool's own documentation or an
 * installed copy (see the work report that introduced this package):
 *   codex       ~/.agents/skills/<name>/SKILL.md  (OpenAI's Codex docs, "Where
 *               Codex loads local skills": USER scope = $HOME/.agents/skills).
 *               Codex 0.156.1 also still loads ~/.codex/skills ($CODEX_HOME/skills):
 *               `codex debug prompt-input` lists both roots.
 *   claude-code ~/.claude/skills/<name>/SKILL.md  (Claude Code docs, personal
 *               skills: "~/.claude/skills/<skill-name>/SKILL.md")
 *   openclaw    ~/.openclaw/skills/<name>/SKILL.md (OpenClaw docs/tools/skills.md:
 *               "Managed / local skills: <state-dir>/skills", state dir defaults
 *               to ~/.openclaw; shared by all local agents)
 *   hermes      ~/.hermes/skills/<name>/SKILL.md  (Hermes CONTRIBUTING.md:
 *               "~/.hermes/skills/ - all active skills"; hermes_cli/AGENTS.md:
 *               skill commands scan ~/.hermes/skills/; `hermes skills list`
 *               shows the top-level ~/.hermes/skills/<name>/ skills as "local")
 * Anything else gets a generic instruction instead of a guessed path.
 */
export type SkillAgent = "codex" | "claude-code" | "openclaw" | "hermes" | "other";

export const SKILL_AGENTS: readonly SkillAgent[] = ["codex", "claude-code", "openclaw", "hermes", "other"];

/** Directory (and Agent Skills `name`) of the skill. */
export const SKILL_NAME = "moneyswitch-pay";

export interface AgentInfo {
  /** Human label, same in zh and en. */
  label: string;
  /** Verified skill file location (`~` = the user's home dir), or null when unknown. */
  path: string | null;
  /** The same location spelled for Windows, when it differs from the `~` form. */
  windowsPath: string | null;
  /** Extra one-line hint appended after the path (English; the prompt is bilingual and keeps it short). */
  hint: string | null;
}

/** `~/<dir>/skills/moneyswitch-pay/SKILL.md` */
const homePath = (dir: string): string => ["~", dir, "skills", SKILL_NAME, "SKILL.md"].join("/");
/** `%USERPROFILE%\<dir>\skills\moneyswitch-pay\SKILL.md` (joined, not written as a literal, so no backslash escape can eat a character) */
const winPath = (dir: string): string => ["%USERPROFILE%", dir, "skills", SKILL_NAME, "SKILL.md"].join("\\");

export const AGENT_INFO: Record<SkillAgent, AgentInfo> = {
  codex: {
    label: "Codex",
    path: homePath(".agents"),
    windowsPath: winPath(".agents"),
    hint: `Codex also reads ${homePath(".codex")}, or $CODEX_HOME/skills/...`,
  },
  "claude-code": {
    label: "Claude Code",
    path: homePath(".claude"),
    windowsPath: winPath(".claude"),
    hint: null,
  },
  openclaw: {
    label: "OpenClaw",
    path: homePath(".openclaw"),
    windowsPath: winPath(".openclaw"),
    hint: `use <workspace>/skills/${SKILL_NAME}/SKILL.md instead to give it to a single agent only`,
  },
  hermes: {
    label: "Hermes",
    path: homePath(".hermes"),
    windowsPath: winPath(".hermes"),
    hint: null,
  },
  other: {
    label: "Other",
    path: null,
    windowsPath: null,
    hint: null,
  },
};

export function isSkillAgent(v: unknown): v is SkillAgent {
  return typeof v === "string" && (SKILL_AGENTS as readonly string[]).includes(v);
}

/** Best-effort guess of the agent from a key name such as "Codex" or "my-claude-code"; null when unsure. */
export function guessAgentFromName(name: string | null | undefined): SkillAgent | null {
  const n = (name ?? "").toLowerCase();
  if (!n) return null;
  if (n.includes("codex")) return "codex";
  if (n.includes("claude")) return "claude-code";
  if (n.includes("openclaw") || n.includes("open-claw")) return "openclaw";
  if (n.includes("hermes")) return "hermes";
  return null;
}
