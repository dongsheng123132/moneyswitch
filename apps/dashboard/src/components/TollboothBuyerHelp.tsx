import React, { useState } from "react";
import { Link } from "react-router-dom";
import SecretNotice from "./SecretNotice";
import Callout from "./Callout";
import CopyButton from "./CopyButton";
import Snippet from "./Snippet";
import { useT } from "../i18n";
import { wizardStrings } from "../i18n/strings/tollbooths";
import { common } from "../i18n/strings/common";
import type { TollboothRow, AdminMeta } from "../api";
import { tollCurl402, tollBuyViaFetch, tollChannelBaseUrl, sellCommand, KEY_PLACEHOLDER, type CliSource } from "../snippets";

type Tab = "view" | "buy" | "channel";

function examplePath(tollbooth: TollboothRow): { method: string; path: string } {
  const r = tollbooth.routes.find((x) => x.path_pattern !== "*");
  if (!r) return { method: "GET", path: "/" };
  const path = r.path_pattern.replace(/\/\*$/, "").replace(/^\*$/, "/") || "/";
  return { method: r.method === "ANY" ? "GET" : r.method, path };
}

function hasV1Route(tollbooth: TollboothRow): boolean {
  return tollbooth.routes.some((r) => r.path_pattern.toLowerCase().startsWith("/v1"));
}

/**
 * "买家怎么调" block, shared by the wizard's completion screen and the toll
 * booth detail page (task instructions: put the shared rules editor + buyer
 * help in components so both places reuse the exact same copy).
 */
export default function TollboothBuyerHelp({ tollbooth, meta, cliSource }: { tollbooth: TollboothRow; meta: AdminMeta | null; cliSource: CliSource }) {
  const t = useT(wizardStrings);
  const tc = useT(common);
  const [tab, setTab] = useState<Tab>("view");
  const [showSell, setShowSell] = useState(false);

  const ex = examplePath(tollbooth);
  const exampleUrl = `${tollbooth.public_url}${ex.path}`;
  const buyerOrigin = meta?.public_base ?? window.location.origin;
  let hostPort = "";
  try {
    hostPort = new URL(tollbooth.public_url).host;
  } catch {
    hostPort = "";
  }
  const showChannelTab = hasV1Route(tollbooth);
  let localOnly = false;
  try {
    const h = new URL(tollbooth.public_url).hostname.replace(/^\[|\]$/g, "");
    localOnly = h === "localhost" || h === "::1" || h.startsWith("127.") || h === "0.0.0.0";
  } catch {
    localOnly = false;
  }

  return (
    <div className="toll-buyer-help">
      {localOnly && (
        <Callout tone="warn" title={t("localOnlyTitle")}>
          {t("localOnlyBody", { host: hostPort })}
        </Callout>
      )}
      <h3>{t("buyerHowTitle")}</h3>
      <div className="segmented">
        <button type="button" className={tab === "view" ? "active" : ""} onClick={() => setTab("view")}>
          {t("tabViewPrice")}
        </button>
        <button type="button" className={tab === "buy" ? "active" : ""} onClick={() => setTab("buy")}>
          {t("tabBuyFetch")}
        </button>
        {showChannelTab && (
          <button type="button" className={tab === "channel" ? "active" : ""} onClick={() => setTab("channel")}>
            {t("tabChannel")}
          </button>
        )}
      </div>

      {tab === "view" && (
        <div>
          <Snippet code={tollCurl402(exampleUrl)} />
          <p className="field-hint">{t("tabViewPriceNote")}</p>
        </div>
      )}

      {tab === "buy" && (
        <div>
          <Snippet code={tollBuyViaFetch(buyerOrigin, exampleUrl, KEY_PLACEHOLDER, ex.method)} />
          <SecretNotice compact>{t("tabBuyFetchNote")}</SecretNotice>
          <div style={{ marginTop: 10 }}>
            <Link className="btn small secondary" to={`/playground?mode=fetch&url=${encodeURIComponent(exampleUrl)}&method=${encodeURIComponent(ex.method)}`}>
              {t("tryInPlayground")}
            </Link>
          </div>
          {hostPort && (
            <p className="field-hint">
              {t("allowedHostsNote")} <code className="mono">{hostPort}</code> <CopyButton text={hostPort} className="icon-only" />
            </p>
          )}
        </div>
      )}

      {tab === "channel" && showChannelTab && (
        <div>
          <Snippet code={tollChannelBaseUrl(tollbooth.public_url)} />
          <p className="field-hint">{t("tabChannelNote")}</p>
        </div>
      )}

      <div className="toll-no-server">
        <button type="button" className="btn small ghost" onClick={() => setShowSell((s) => !s)} aria-expanded={showSell}>
          {t("noServerTitle")}
        </button>
        {showSell && (
          <div>
            <p className="field-hint">{t("noServerBody")}</p>
            <Snippet code={sellCommand(cliSource, tollbooth.upstream_url, tollbooth.default_price, tollbooth.pay_to, tollbooth.routes)} />
          </div>
        )}
      </div>
    </div>
  );
}
