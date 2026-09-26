import React, { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import Callout from "./Callout";
import Term from "./Term";
import { useT } from "../i18n";
import { tollRulesStrings } from "../i18n/strings/tollbooths";
import { common } from "../i18n/strings/common";
import { toMicros } from "../money";
import type { TollMethod, TollRouteInput } from "../api";

const METHODS: TollMethod[] = ["ANY", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

// ---------------------------------------------------------------------------
// PREVIEW-ONLY client-side route matcher. This mirrors the rules described in
// SPEC-v0.5 §2 (longest literal prefix wins, then exact over prefix, then a
// specific method over ANY) purely so the wizard/editor can show "what will
// a buyer pay" without importing the server's @moneyswitch/tollbooth package
// (which has node-only dependencies and cannot run in the browser). The real
// decision is always made server-side by packages/tollbooth's matchRoute().
// ---------------------------------------------------------------------------

function normalizePreviewPath(raw: string): string {
  let s = raw.trim();
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "") || "/";
  return s.toLowerCase();
}

interface CompiledPreviewRule {
  method: TollMethod;
  price: string;
  literalPrefixLength: number;
  exact: boolean;
  test: (path: string) => boolean;
}

function compilePreviewRule(r: TollRouteInput): CompiledPreviewRule {
  let pattern = (r.path_pattern || "").trim();
  if (pattern === "*") pattern = "/*";
  if (!pattern.startsWith("/")) pattern = "/" + pattern;
  pattern = pattern.toLowerCase();
  const isWildcard = pattern === "/*" || pattern.endsWith("/*");
  let prefix = isWildcard ? pattern.slice(0, -2) : pattern;
  if (prefix.length > 1) prefix = prefix.replace(/\/+$/, "");
  return {
    method: r.method,
    price: r.price,
    literalPrefixLength: prefix.length,
    exact: !isWildcard,
    test: (path) => {
      if (!isWildcard) return path === prefix;
      if (prefix === "" || prefix === "/") return true;
      return path === prefix || path.startsWith(prefix + "/");
    },
  };
}

function methodMatches(ruleMethod: TollMethod, method: string): boolean {
  return ruleMethod === "ANY" || ruleMethod === method;
}

export type PreviewDecision = { kind: "paid"; price: string } | { kind: "free" } | { kind: "deny" };

/** PREVIEW ONLY — see the block comment above. Not used by the real proxy. */
export function previewMatch(routes: TollRouteInput[], method: string, rawPath: string, defaultPrice: string | null): PreviewDecision {
  const path = normalizePreviewPath(rawPath);
  const candidates = routes
    .map(compilePreviewRule)
    .filter((c) => methodMatches(c.method, method) && c.test(path))
    .sort(
      (a, b) =>
        b.literalPrefixLength - a.literalPrefixLength ||
        Number(b.exact) - Number(a.exact) ||
        Number(b.method !== "ANY") - Number(a.method !== "ANY")
    );
  const best = candidates[0];
  if (best) return toMicros(best.price) > 0n ? { kind: "paid", price: best.price } : { kind: "free" };
  if (defaultPrice == null) return { kind: "deny" };
  return toMicros(defaultPrice) > 0n ? { kind: "paid", price: defaultPrice } : { kind: "free" };
}

function isValidPrice(v: string): boolean {
  if (!/^\d+(\.\d{1,6})?$/.test(v.trim())) return false;
  return true;
}

export type UnmatchedMode = "charge" | "free" | "deny";

export function unmatchedModeOf(defaultPrice: string | null): UnmatchedMode {
  if (defaultPrice == null) return "deny";
  return toMicros(defaultPrice) > 0n ? "charge" : "free";
}

export default function TollRulesEditor({
  routes,
  onRoutesChange,
  defaultPrice,
  onDefaultPriceChange,
  previewPaths,
}: {
  routes: TollRouteInput[];
  onRoutesChange: (routes: TollRouteInput[]) => void;
  defaultPrice: string | null;
  onDefaultPriceChange: (v: string | null) => void;
  /** [method, path] pairs to show in the live preview. */
  previewPaths?: Array<[string, string]>;
}) {
  const t = useT(tollRulesStrings);
  const tc = useT(common);
  const mode = unmatchedModeOf(defaultPrice);
  const [chargeAmount, setChargeAmount] = useState(mode === "charge" && defaultPrice ? defaultPrice : "0.01");

  function updateRule(i: number, patch: Partial<TollRouteInput>) {
    const next = routes.slice();
    next[i] = { ...next[i], ...patch };
    onRoutesChange(next);
  }

  function addRule() {
    onRoutesChange([...routes, { method: "POST", path_pattern: "/v1/example", price: "0.01", description: "" }]);
  }

  function removeRule(i: number) {
    onRoutesChange(routes.filter((_, idx) => idx !== i));
  }

  function setMode(m: UnmatchedMode) {
    if (m === "charge") onDefaultPriceChange(chargeAmount);
    else if (m === "free") onDefaultPriceChange("0");
    else onDefaultPriceChange(null);
  }

  const preview = useMemo(() => {
    const examples: Array<[string, string]> =
      previewPaths ?? (routes[0] ? [[routes[0].method === "ANY" ? "GET" : routes[0].method, routes[0].path_pattern.replace(/\*$/, "")]] : []);
    const withDefaults: Array<[string, string]> = [...examples, ["GET", "/health"] as [string, string], ["GET", "/anything-else"] as [string, string]].slice(0, 3);
    return withDefaults.map(([method, path]) => ({ method, path, decision: previewMatch(routes, method, path, defaultPrice) }));
  }, [routes, defaultPrice, previewPaths]);

  return (
    <div className="toll-rules-editor">
      <div className="field-row toll-rules-table-head">
        <div className="stat-label">{t("rulesTableTitle")}</div>
      </div>
      {routes.length > 0 && (
        <table className="toll-rules-table">
          <thead>
            <tr>
              <th>{t("colMethod")}</th>
              <th>{t("colPath")}</th>
              <th>{t("colPrice")}</th>
              <th>{t("colDescription")}</th>
              <th>{t("colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r, i) => {
              const priceOk = isValidPrice(r.price);
              return (
                <tr key={i}>
                  <td>
                    <select value={r.method} onChange={(e) => updateRule(i, { method: e.target.value as TollMethod })}>
                      {METHODS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input className="mono" value={r.path_pattern} onChange={(e) => updateRule(i, { path_pattern: e.target.value })} placeholder="/v1/chat/completions" />
                  </td>
                  <td>
                    <input
                      className={`mono ${priceOk ? "" : "is-invalid"}`}
                      value={r.price}
                      onChange={(e) => updateRule(i, { price: e.target.value })}
                      placeholder="0.01"
                      aria-invalid={!priceOk}
                    />
                    {toMicros(r.price) === 0n && priceOk && <div className="field-hint">{t("priceFree")}</div>}
                    {!priceOk && (
                      <div className="field-error" role="alert">
                        {t("invalidPrice")}
                      </div>
                    )}
                  </td>
                  <td>
                    <input value={r.description ?? ""} onChange={(e) => updateRule(i, { description: e.target.value })} />
                  </td>
                  <td>
                    <button type="button" className="btn small danger" onClick={() => removeRule(i)} aria-label={tc("cancel")}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <button type="button" className="btn small secondary" onClick={addRule}>
        {t("addRule")}
      </button>

      <div className="field toll-unmatched">
        <label>
          {t("unmatchedLabel")} <Term k="defaultPrice">?</Term>
        </label>
        <div className="btn-group">
          <button type="button" className={`btn small ${mode === "charge" ? "" : "secondary"}`} onClick={() => setMode("charge")}>
            {t("unmatchedCharge")}
          </button>
          <button type="button" className={`btn small ${mode === "free" ? "" : "secondary"}`} onClick={() => setMode("free")}>
            {t("unmatchedFree")}
          </button>
          <button type="button" className={`btn small ${mode === "deny" ? "" : "secondary"}`} onClick={() => setMode("deny")}>
            {t("unmatchedDeny")}
          </button>
        </div>
        {mode === "charge" && (
          <input
            className="mono"
            style={{ marginTop: 8, maxWidth: 140 }}
            value={chargeAmount}
            onChange={(e) => {
              setChargeAmount(e.target.value);
              onDefaultPriceChange(e.target.value);
            }}
            placeholder="0.01"
          />
        )}
      </div>

      <Callout tone="success">{t("protectionCallout")}</Callout>

      <div className="toll-preview">
        <div className="stat-label">{t("previewTitle")}</div>
        <ul className="toll-preview-list">
          {preview.map((p, i) => (
            <li key={i} className="mono">
              {p.method} {p.path} &rarr;{" "}
              {p.decision.kind === "paid" ? `${p.decision.price} USDC` : p.decision.kind === "free" ? t("previewFree") : t("previewDeny")}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
