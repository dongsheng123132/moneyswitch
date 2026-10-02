import React from "react";
import { useAuth } from "../../auth";
import { useT } from "../../i18n";
import { employeeStrings } from "../../i18n/strings/employee";
import {
  useCliSource,
  connectCommand,
  statusCommand,
  openaiBase,
  claudeMcpCommand,
  codexToml,
  maskKey,
} from "../../snippets";
import Snippet from "../../components/Snippet";
import Callout from "../../components/Callout";
import SkillForAi from "../../components/SkillForAi";
import { skillStrings } from "../../i18n/strings/skill";
import { skillBaseUrl } from "../../skillText";

export default function EmployeeConnectPage() {
  const { employeeKey } = useAuth();
  const key = employeeKey ?? "";
  const origin = window.location.origin;
  const src = useCliSource();
  const t = useT(employeeStrings);
  const ts = useT(skillStrings);

  const previewCmd = connectCommand(src, origin, key, false);
  const applyCmd = connectCommand(src, origin, key, true);
  const checkCmd = statusCommand(src, origin, key);
  const base = openaiBase(origin);
  const claudeCmd = claudeMcpCommand(src, origin, key);
  const codexSnippet = codexToml(src, origin, key);
  const masked = maskKey(key);

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 650, fontSize: 14, marginBottom: 4 }}>{t("connectIntroTitle")}</div>
        <div className="stat-sub">{t("connectIntroBody")}</div>
      </div>

      {/* The skill is the first way: the logged-in key holder already has their key, so the text carries their real key. */}
      <div className="card connect-section">
        <div className="card-header">
          <h3>{ts("employeeTitle")}</h3>
        </div>
        <div className="connect-section-body">{ts("employeeBody")}</div>
        <SkillForAi baseUrl={skillBaseUrl(null, origin)} secret={key} showNudge={false} />
      </div>

      <div className="card connect-section">
        <div className="card-header">
          <h3>{t("section1Title")}</h3>
        </div>
        <div className="connect-section-body">{t("section1Body")}</div>

        {src.kind === "npm" && <Callout tone="warn">{t("npmUnavailableWarn")}</Callout>}

        <div className="connect-subhead">{t("previewLabel")}</div>
        <Snippet code={previewCmd} display={previewCmd.replace(key, masked)} />

        <div className="connect-subhead">{t("applyLabel")}</div>
        <Snippet code={applyCmd} display={applyCmd.replace(key, masked)} />

        <div className="connect-subhead">{t("checkTitle")}</div>
        <Snippet code={checkCmd} display={checkCmd.replace(key, masked)} />
      </div>

      <div className="card connect-section">
        <div className="card-header">
          <h3>{t("section2Title")}</h3>
        </div>
        <div className="connect-section-body">{t("section2Body")}</div>
        <div className="field">
          <label>{t("baseUrlLabel")}</label>
          <Snippet code={base} />
        </div>
        <div className="field">
          <label>{t("apiKeyLabel")}</label>
          <Snippet code={key} display={masked} />
        </div>
      </div>

      <div className="card connect-section">
        <div className="card-header">
          <h3>{t("section3Title")}</h3>
        </div>
        <div className="connect-subhead">{t("claudeCodeLabel")}</div>
        <Snippet code={claudeCmd} display={claudeCmd.replace(key, masked)} note={t("claudeCodeNote")} />

        <div className="connect-subhead">{t("codexLabel")}</div>
        <Snippet code={codexSnippet} display={codexSnippet.replace(key, masked)} note={t("codexNote")} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>{t("keySafetyTitle")}</h3>
        </div>
        <div className="stat-sub">{t("keySafetyBody")}</div>
      </div>
    </div>
  );
}
