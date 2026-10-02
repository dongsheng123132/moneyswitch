import React, { useId, useMemo, useState } from "react";
import { useT } from "../i18n";
import { skillStrings } from "../i18n/strings/skill";
import { AGENT_INFO, SKILL_AGENTS, buildInstallText, guessAgentFromName, type SkillAgent } from "../skillText";
import CopyButton from "./CopyButton";
import SecretNotice from "./SecretNotice";
import Callout from "./Callout";
import "../styles/skill.css";

/**
 * The primary way to connect an agent: ONE block of text (a SKILL.md with this
 * server's address and this agent's own key, wrapped in a short install
 * instruction) to paste into Codex / Claude Code / OpenClaw / Hermes / ...
 *
 * The text is a secret (it contains the key): shown masked, copied in full,
 * inside the same amber SecretNotice every other key display uses.
 */
export default function SkillForAi({
  baseUrl,
  secret,
  keyName,
  showNudge = true,
  showLostKeyHint = false,
}: {
  baseUrl: string;
  /** The plaintext MoneyKey. Empty/invalid shows a hint instead of a copy button. */
  secret: string;
  keyName?: string | null;
  /** "One key per agent, name it after the agent" */
  showNudge?: boolean;
  /** Pages where the key may be a pasted/lost one: point at "Reset secret and copy skill". */
  showLostKeyHint?: boolean;
}) {
  const t = useT(skillStrings);
  const pickLabelId = useId();
  const [agent, setAgent] = useState<SkillAgent>(() => guessAgentFromName(keyName) ?? "codex");

  const built = useMemo(() => buildInstallText({ baseUrl, key: secret, keyName, agent }), [baseUrl, secret, keyName, agent]);
  const info = AGENT_INFO[agent];
  const agentLabel = agent === "other" ? t("agent_other") : info.label;

  return (
    <div className="skill-block">
      <div className="skill-title">{t("blockTitle")}</div>
      <div className="skill-body">{t("blockBody")}</div>
      {showNudge && <div className="skill-nudge">{t("nudge")}</div>}

      <div className="skill-pick-label" id={pickLabelId}>
        {t("pickAgent")}
      </div>
      <div className="preset-row skill-agents" role="radiogroup" aria-labelledby={pickLabelId}>
        {SKILL_AGENTS.map((a) => (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={agent === a}
            className={`preset-btn skill-agent-btn ${agent === a ? "is-active" : ""}`}
            onClick={() => setAgent(a)}
          >
            {t(`agent_${a}` as const)}
          </button>
        ))}
      </div>

      {built.text ? (
        <SecretNotice compact>
          <div className="skill-copy-wrap">
            <CopyButton
              big
              text={built.text}
              label={t("copyBtn", { agent: agentLabel })}
              copiedLabel={t("copiedBtn", { agent: agentLabel })}
            />
          </div>
        </SecretNotice>
      ) : (
        <Callout tone={built.error === "no_key" ? "info" : "warn"}>{built.error === "no_key" ? t("needKey") : t("badKey")}</Callout>
      )}

      {built.text && (
        <>
          <div className="skill-where">{info.path ? t("savedAt", { path: info.path }) : t("savedAtOther")}</div>
          <div className="skill-steps">
            <div className="skill-steps-title">{t("stepsTitle")}</div>
            <ol>
              <li>{t("step1")}</li>
              <li>{t("step2", { agent: agentLabel })}</li>
              <li>{t("step3")}</li>
            </ol>
          </div>
          <div className="skill-secret-hint">{t("secretHint")}</div>
          <details className="skill-preview">
            <summary>{t("previewTitle")}</summary>
            <pre className="code-block skill-preview-text">{built.display}</pre>
          </details>
        </>
      )}
      {showLostKeyHint && <div className="skill-lost">{t("lostKey")}</div>}
    </div>
  );
}
