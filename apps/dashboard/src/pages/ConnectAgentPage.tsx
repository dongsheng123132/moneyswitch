import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Plug } from "lucide-react";
import { listChannels } from "../api";
import { usePolling } from "../usePolling";
import { useAdminMeta } from "../useAdminMeta";
import {
  useCliSource,
  connectCommand,
  statusCommand,
  claudeMcpCommand,
  codexToml,
  mcpJson,
  openaiBase,
  openaiPython,
  openaiNode,
  openaiCurl,
  restFetchCurl,
  restStatusCurl,
  newApiSnippet,
  maskKey,
  KEY_PLACEHOLDER,
} from "../snippets";
import Snippet from "../components/Snippet";
import SkillForAi from "../components/SkillForAi";
import Callout from "../components/Callout";
import Term from "../components/Term";
import { useT } from "../i18n";
import { connectStrings } from "../i18n/strings/connect";
import { skillStrings } from "../i18n/strings/skill";
import { skillBaseUrl } from "../skillText";
import "../styles/connect.css";

type Tab = "skill" | "mcp" | "openai" | "rest";

export default function ConnectAgentPage() {
  const t = useT(connectStrings);
  const ts = useT(skillStrings);
  const meta = useAdminMeta();
  const src = useCliSource(meta);
  const { data: channels } = usePolling(listChannels);

  const [rawKey, setRawKey] = useState("");
  // The skill (one paste into the AI) is the first way; MCP / OpenAI / REST are the other ways.
  const [tab, setTab] = useState<Tab>("skill");

  const origin = window.location.origin;
  const skillBase = skillBaseUrl(meta, origin);
  const key = rawKey.trim() || KEY_PLACEHOLDER;
  const displayKey = rawKey.trim() ? maskKey(rawKey.trim()) : KEY_PLACEHOLDER;

  const firstEnabledModel = (channels ?? []).find((c) => c.enabled)?.models?.[0];
  const model = firstEnabledModel || "moneyswitch-demo-chat";

  const restTargetUrl = meta?.demo_seller_url ? `${meta.demo_seller_url.replace(/\/+$/, "")}/premium-report` : "https://example.com/paid";

  return (
    <div>
      <div className="card connect-key-card">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div className="kpi-icon" style={{ marginBottom: 0 }}>
            <Plug size={16} />
          </div>
          <div style={{ fontWeight: 650, fontSize: 14 }}>{t("keyCardTitle")}</div>
        </div>
        <div className="connect-key-row">
          <input
            value={rawKey}
            onChange={(e) => setRawKey(e.target.value)}
            placeholder={KEY_PLACEHOLDER}
            aria-label={t("keyInputLabel")}
          />
        </div>
        <div className="connect-section-note" style={{ marginBottom: 0 }}>
          {t("keyInputLabel")} · {t("keyNote")}{" "}
          <Link to="/keys?new=1">{t("keyCreateLink")}</Link>
        </div>
      </div>

      {tab !== "skill" && src.kind === "tarball" && <Callout tone="info">{t("cliTarballNote")}</Callout>}
      {tab !== "skill" && src.kind === "local" && <Callout tone="info">{t("cliLocalNote")}</Callout>}
      {tab !== "skill" && src.kind === "npm" && (
        <Callout tone="warn" title={t("cliNpmWarnTitle")}>
          {t("cliNpmWarnBody")}
        </Callout>
      )}

      <div className="tabs skill-top-tabs" style={{ marginTop: 12, marginBottom: 16 }}>
        <button type="button" className={`tab-btn ${tab === "skill" ? "active" : ""}`} onClick={() => setTab("skill")}>
          {ts("tabSkill")}
          <span className="skill-reco">{ts("recommended")}</span>
        </button>
        <span className="skill-tabs-sep">{ts("tabOther")}</span>
        <button type="button" className={`tab-btn ${tab === "mcp" ? "active" : ""}`} onClick={() => setTab("mcp")}>
          {t("tabMcp")}
        </button>
        <button type="button" className={`tab-btn ${tab === "openai" ? "active" : ""}`} onClick={() => setTab("openai")}>
          {t("tabOpenai")}
        </button>
        <button type="button" className={`tab-btn ${tab === "rest" ? "active" : ""}`} onClick={() => setTab("rest")}>
          {t("tabRest")}
        </button>
      </div>

      {tab === "skill" && (
        <div className="card connect-section">
          <SkillForAi baseUrl={skillBase} secret={rawKey.trim()} showLostKeyHint />
        </div>
      )}

      {tab === "mcp" && (
        <div>
          <div className="card connect-section">
            <div className="connect-section-title">{t("oneLineTitle")}</div>
            <div className="connect-section-note">{t("oneLineBody")}</div>
            <Snippet title={t("previewLabel")} code={connectCommand(src, origin, key, false)} />
            <Snippet title={t("applyLabel")} code={connectCommand(src, origin, key, true)} />
            <Snippet title={t("statusLabel")} code={statusCommand(src, origin, key)} />
          </div>

          <div className="card connect-section">
            <div className="connect-section-title">{t("claudeManualTitle")}</div>
            <div className="connect-section-note">{t("claudeManualNote")}</div>
            <Snippet code={claudeMcpCommand(src, origin, key)} />
          </div>

          <div className="card connect-section">
            <div className="connect-section-title">{t("codexManualTitle")}</div>
            <div className="connect-section-note">{t("codexManualNote")}</div>
            <Snippet code={codexToml(src, origin, key)} />
          </div>

          <div className="card connect-section">
            <div className="connect-section-title">{t("mcpAnyTitle")}</div>
            <div className="connect-section-note">{t("mcpAnyNote")}</div>
            <Snippet code={mcpJson(src, origin, key)} />
          </div>
        </div>
      )}

      {tab === "openai" && (
        <div>
          <div className="card connect-section">
            <div className="connect-section-title">{t("openaiTitle")}</div>
            <table className="connect-fields-table">
              <tbody>
                <tr>
                  <td>{t("openaiBaseUrlLabel")}</td>
                  <td className="mono">{openaiBase(origin)}</td>
                </tr>
                <tr>
                  <td>{t("openaiKeyLabel")}</td>
                  <td className="mono">{displayKey}</td>
                </tr>
              </tbody>
            </table>
            <Snippet title="Python" code={openaiPython(origin, key, model)} />
            <Snippet title="Node" code={openaiNode(origin, key, model)} />
            <Snippet title="curl" code={openaiCurl(origin, key, model)} />
          </div>

          <div className="card connect-section">
            <div className="connect-section-title">{t("openaiOtherClientsTitle")}</div>
            <Snippet code={newApiSnippet(origin, key)} />
          </div>
        </div>
      )}

      {tab === "rest" && (
        <div>
          <div className="card connect-section">
            <div className="connect-section-title">{t("restTitle")}</div>
            <Snippet title={t("restFetchTitle")} code={restFetchCurl(origin, key, restTargetUrl)} />
            <Snippet title={t("restStatusTitle")} code={restStatusCurl(origin, key)} />
            <div className="connect-section-note">
              {t("restAllowedHostsNote")} <Term k="allowedHosts">allowedHosts</Term>
            </div>
          </div>

          <div className="card connect-section">
            <div className="connect-section-title">{t("restFieldsTitle")}</div>
            <table className="connect-fields-table">
              <tbody>
                <tr>
                  <td className="mono">{t("restFieldStatus")}</td>
                  <td>{t("restFieldStatusDesc")}</td>
                </tr>
                <tr>
                  <td className="mono">{t("restFieldCode")}</td>
                  <td>{t("restFieldCodeDesc")}</td>
                </tr>
                <tr>
                  <td className="mono">{t("restFieldPayment")}</td>
                  <td className="mono">{t("restFieldPaymentDesc")}</td>
                </tr>
                <tr>
                  <td className="mono">{t("restFieldApprovalId")}</td>
                  <td>{t("restFieldApprovalIdDesc")}</td>
                </tr>
                <tr>
                  <td className="mono">{t("restFieldRemainingToday")}</td>
                  <td>-</td>
                </tr>
                <tr>
                  <td className="mono">{t("restFieldRemainingTotal")}</td>
                  <td>-</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
