import React, { useState } from "react";
import { useT, useLang, type Lang } from "../i18n";
import { common } from "../i18n/strings/common";
import { keysStrings } from "../i18n/strings/keys";
import { skillStrings } from "../i18n/strings/skill";
import type { Handoff } from "../keyHandoff";
import {
  claudeMcpCommand,
  codexToml,
  openaiBase,
  openaiPython,
  openaiNode,
  openaiCurl,
  newApiSnippet,
  employeeMessage,
  type CliSource,
} from "../snippets";
import CopyButton from "./CopyButton";
import SecretNotice from "./SecretNotice";
import Snippet from "./Snippet";
import Callout from "./Callout";
import SkillForAi from "./SkillForAi";

type OtherTab = "connect" | "claude" | "codex" | "openai" | "employee";

/**
 * The body of the Money Keys drawer once a secret exists (a new key, or the new
 * secret of "Reset secret and copy skill"): the key once, then HOW to give it to
 * an AI. The first and default way is the skill (one block of text for the AI);
 * the connect command, MCP, OpenAI-compatible and "message for a colleague"
 * snippets are the "other ways (advanced)".
 *
 * Mount it with `key={handoff.id}`: a new secret starts again on the skill tab.
 */
export default function KeyHandoff({
  handoff,
  skillBase,
  apiBase,
  src,
  firstModel,
  onTryPlayground,
  onDone,
  initialTopTab = "skill",
}: {
  handoff: Handoff;
  /** Address written into the skill (MONEYSWITCH_PUBLIC_URL, else the page origin). */
  skillBase: string;
  apiBase: string;
  src: CliSource;
  firstModel: string;
  onTryPlayground: () => void;
  onDone: () => void;
  /** Which way is shown first. Always "skill" in the app; a render test sets "other" to check the other ways are still there. */
  initialTopTab?: "skill" | "other";
}) {
  const t = useT(keysStrings);
  const ts = useT(skillStrings);
  const tc = useT(common);
  const { lang } = useLang();
  // The skill (paste one block into the AI) is the first and default way to hand a key over; the rest is "other ways".
  const [topTab, setTopTab] = useState<"skill" | "other">(initialTopTab);
  const [tab, setTab] = useState<OtherTab>("connect");
  const [employeeLang, setEmployeeLang] = useState<Lang | null>(null);

  return (
    <div>
      <div className="key-once-banner">{handoff.kind === "rotated" ? ts("rotatedBanner", { name: handoff.name }) : t("createdBanner")}</div>
      <SecretNotice>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>{t("keyFieldLabel")}</label>
          <div className="key-big">{handoff.key}</div>
          <CopyButton text={handoff.key} />
        </div>
      </SecretNotice>

      <div className="next-heading">{t("nextHeading")}</div>

      <div className="tabs skill-top-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={topTab === "skill"} className={`tab-btn ${topTab === "skill" ? "active" : ""}`} onClick={() => setTopTab("skill")}>
          {ts("tabSkill")}
          <span className="skill-reco">{ts("recommended")}</span>
        </button>
        <button type="button" role="tab" aria-selected={topTab === "other"} className={`tab-btn ${topTab === "other" ? "active" : ""}`} onClick={() => setTopTab("other")}>
          {ts("tabOther")}
        </button>
      </div>

      {topTab === "skill" && <SkillForAi baseUrl={skillBase} secret={handoff.key} keyName={handoff.name} />}

      {topTab === "other" && (
        <div>
          <p className="skill-other-intro">{ts("otherIntro")}</p>
          <div className="tabs">
            <button type="button" className={`tab-btn ${tab === "connect" ? "active" : ""}`} onClick={() => setTab("connect")}>
              {t("tabConnect")}
            </button>
            <button type="button" className={`tab-btn ${tab === "claude" ? "active" : ""}`} onClick={() => setTab("claude")}>
              {t("tabClaude")}
            </button>
            <button type="button" className={`tab-btn ${tab === "codex" ? "active" : ""}`} onClick={() => setTab("codex")}>
              {t("tabCodex")}
            </button>
            <button type="button" className={`tab-btn ${tab === "openai" ? "active" : ""}`} onClick={() => setTab("openai")}>
              {t("tabOpenai")}
            </button>
            <button type="button" className={`tab-btn ${tab === "employee" ? "active" : ""}`} onClick={() => setTab("employee")}>
              {t("tabEmployee")}
            </button>
          </div>

          {tab === "connect" && (
            <div>
              <Snippet title="Claude Code MCP" code={claudeMcpCommand(src, apiBase, handoff.key)} />
              {src.kind === "tarball" && <div className="connect-source-note">{t("sourceNoteTarball")}</div>}
              {src.kind === "local" && <div className="connect-source-note">{t("sourceNoteLocal")}</div>}
              {src.kind === "npm" && <Callout tone="info" title={t("sourceNoteNpmTitle")}>{t("sourceNoteNpm")}</Callout>}
            </div>
          )}
          {tab === "claude" && <Snippet title={t("tabClaude")} code={claudeMcpCommand(src, apiBase, handoff.key)} note={t("claudeNote")} />}
          {tab === "codex" && <Snippet title={t("tabCodex")} code={codexToml(src, apiBase, handoff.key)} note={t("codexNote")} />}
          {tab === "openai" && (
            <div>
              <Snippet title={t("baseUrlLabel")} code={openaiBase(apiBase)} />
              <Snippet title={t("apiKeyLabel")} code={handoff.key} />
              <Snippet title={t("pythonLabel")} code={openaiPython(apiBase, handoff.key, firstModel)} />
              <Snippet title={t("nodeLabel")} code={openaiNode(apiBase, handoff.key, firstModel)} />
              <Snippet title={t("curlLabel")} code={openaiCurl(apiBase, handoff.key, firstModel)} />
              <Snippet title={t("newApiLabel")} code={newApiSnippet(apiBase, handoff.key)} />
            </div>
          )}
          {tab === "employee" && (
            <div>
              <div className="field-hint employee-toggle">{t("employeeHint")}</div>
              <button
                type="button"
                className="btn small secondary employee-toggle"
                onClick={() => setEmployeeLang((employeeLang ?? lang) === "zh" ? "en" : "zh")}
              >
                {t("employeeToggleLang", { lang: (employeeLang ?? lang) === "zh" ? t("langEn") : t("langZh") })}
              </button>
              <Snippet
                code={employeeMessage(employeeLang ?? lang, {
                  origin: apiBase,
                  name: handoff.name || t("tabEmployee"),
                  key: handoff.key,
                  src,
                })}
              />
            </div>
          )}
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onTryPlayground}>
          {t("tryPlaygroundBtn")}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          {tc("done")}
        </button>
      </div>
    </div>
  );
}
