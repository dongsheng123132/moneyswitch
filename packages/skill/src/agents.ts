/**
 * The agents we know how to install the skill into, and where each one looks
 * for skills.
 *
 * ONE KEY PER AGENT. The personalized skill contains that agent's own
 * MoneyKey, so it must be saved in a folder that only that agent loads.
 * `~/.agents/skills` is the cross-agent folder: Codex AND OpenClaw both read
 * it, and OpenClaw ranks it above its own `~/.openclaw/skills`, so a skill
 * saved there by one agent silently becomes every other reader's skill (and
 * key). Nothing below installs into it, and `AGENT_INFO[x].loads` lists what
 * each agent reads so a test can prove no agent's install folder is read by
 * another agent.
 *
 * Every location was checked against the tool's own documentation AND against
 * the installed tool on 2026-10-02 (probes run in throw-away HOME / CODEX_HOME
 * / HERMES_HOME directories):
 *
 *   codex       ~/.codex/skills/<name>/SKILL.md  ($CODEX_HOME/skills)
 *               codex-cli 0.156.1 `codex debug prompt-input` lists the roots
 *               $CODEX_HOME/skills, ~/.agents/skills and $CODEX_HOME/skills/.system;
 *               a skill written to $CODEX_HOME/skills/moneyswitch-pay/SKILL.md
 *               showed up as "r0/moneyswitch-pay/SKILL.md". Codex's own bundled
 *               skill-installer installs into $CODEX_HOME/skills. OpenClaw's
 *               docs say that folder "is not an OpenClaw skill root", unlike
 *               ~/.agents/skills, which Codex also reads (documented as its
 *               user-scope location) and which is therefore NOT used here.
 *   claude-code ~/.claude/skills/<name>/SKILL.md (Claude Code docs, personal
 *               skills; the folder exists and is populated on this machine)
 *   openclaw    <workspace>/skills/<name>/SKILL.md, default workspace
 *               ~/.openclaw/workspace. OpenClaw 2026.9.3 docs/tools/skills.md
 *               "Loading order": workspace skills (1, highest) > <workspace>/.agents/skills
 *               (2) > ~/.agents/skills (3) > <state-dir>/skills (4, the shared
 *               "managed" folder ~/.openclaw/skills). Probe: with the same skill
 *               in ~/.agents/skills and ~/.openclaw/skills OpenClaw logs "Skill
 *               precedence collision ... winner=agents-skills-personal"; adding
 *               <workspace>/skills makes the workspace copy win. A ClawHub
 *               install (`openclaw skills install`) lands in the workspace
 *               skills/ too (docs, "Install details"), so the personalized copy
 *               replaces the generic one in place instead of being outranked.
 *   hermes      $HERMES_HOME/skills/<name>/SKILL.md. hermes_constants.get_skills_dir()
 *               = get_hermes_home()/"skills"; the home is $HERMES_HOME, else
 *               %LOCALAPPDATA%\hermes on native Windows, else ~/.hermes (a
 *               profile sets its own HERMES_HOME). Probes: HERMES_HOME=<tmp>
 *               with <tmp>/skills/moneyswitch-pay/SKILL.md -> `hermes skills
 *               list` shows it as a local skill and none of ~/.hermes/skills;
 *               with HERMES_HOME unset on this Windows machine it lists
 *               %LOCALAPPDATA%\hermes\skills and not ~/.hermes/skills.
 *
 * Anything else gets a generic instruction instead of a guessed path.
 */
export type SkillAgent = "codex" | "claude-code" | "openclaw" | "hermes" | "other";

export const SKILL_AGENTS: readonly SkillAgent[] = ["codex", "claude-code", "openclaw", "hermes", "other"];

/** Directory (and Agent Skills `name`) of the skill. */
export const SKILL_NAME = "moneyswitch-pay";

/** Read by several agents. Never an install target: the key inside would reach every reader. */
export const SHARED_SKILLS_ROOT = "~/.agents/skills";

export interface AgentInfo {
  /** Human label, same in zh and en. */
  label: string;
  /** Verified skill file location (`~` = the user's home dir; `$VAR` where the agent resolves it itself), or null when unknown. */
  path: string | null;
  /** The same location spelled for Windows, when it differs from the `~` form. */
  windowsPath: string | null;
  /** Extra one-line hint appended after the path (English; the prompt is bilingual and keeps it short). */
  hint: string | null;
  /** The skills folder `path` sits in (the install folder), or null when unknown. */
  installRoot: string | null;
  /** Every skills folder this agent loads by default. Used to prove no agent loads another agent's install folder. */
  loads: readonly string[];
}

/** `<skills folder>/moneyswitch-pay/SKILL.md` */
const fileIn = (skillsRoot: string): string => `${skillsRoot}/${SKILL_NAME}/SKILL.md`;
/** `~/.x/skills` -> `%USERPROFILE%\.x\skills\moneyswitch-pay\SKILL.md` (segments are joined, never written as a backslash literal, so no escape can eat a character) */
const winFileIn = (skillsRoot: string): string =>
  ["%USERPROFILE%", ...skillsRoot.replace(/^~\//, "").split("/"), SKILL_NAME, "SKILL.md"].join("\\");

const CODEX_SKILLS = "~/.codex/skills";
const CLAUDE_SKILLS = "~/.claude/skills";
const OPENCLAW_WORKSPACE_SKILLS = "~/.openclaw/workspace/skills";
const OPENCLAW_MANAGED_SKILLS = "~/.openclaw/skills";
const HERMES_SKILLS = "$HERMES_HOME/skills";

export const AGENT_INFO: Record<SkillAgent, AgentInfo> = {
  codex: {
    label: "Codex",
    path: fileIn(CODEX_SKILLS),
    windowsPath: winFileIn(CODEX_SKILLS),
    hint: `or ${fileIn("$CODEX_HOME/skills")} if CODEX_HOME is set`,
    installRoot: CODEX_SKILLS,
    loads: [CODEX_SKILLS, SHARED_SKILLS_ROOT],
  },
  "claude-code": {
    label: "Claude Code",
    path: fileIn(CLAUDE_SKILLS),
    windowsPath: winFileIn(CLAUDE_SKILLS),
    hint: null,
    installRoot: CLAUDE_SKILLS,
    loads: [CLAUDE_SKILLS],
  },
  openclaw: {
    label: "OpenClaw",
    path: fileIn(OPENCLAW_WORKSPACE_SKILLS),
    windowsPath: winFileIn(OPENCLAW_WORKSPACE_SKILLS),
    hint:
      `this is the default OpenClaw workspace; if your agent uses another one, use <workspace>/skills/${SKILL_NAME}/SKILL.md there. ` +
      `Not ${OPENCLAW_MANAGED_SKILLS} (shared by all OpenClaw agents, and a workspace copy outranks it)`,
    installRoot: OPENCLAW_WORKSPACE_SKILLS,
    loads: [OPENCLAW_WORKSPACE_SKILLS, SHARED_SKILLS_ROOT, OPENCLAW_MANAGED_SKILLS],
  },
  hermes: {
    label: "Hermes",
    path: fileIn(HERMES_SKILLS),
    windowsPath: null,
    hint:
      "HERMES_HOME is ~/.hermes by default, " +
      ["%LOCALAPPDATA%", "hermes"].join("\\") +
      " on native Windows, and a Hermes profile has its own HERMES_HOME; use the one you are running with",
    installRoot: HERMES_SKILLS,
    loads: [HERMES_SKILLS],
  },
  other: {
    label: "Other",
    path: null,
    windowsPath: null,
    hint: null,
    installRoot: null,
    loads: [],
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
