import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import { useAuth } from "../auth";
import { claimSetupToken, getSetupStatus } from "../api";
import { LANDING_PATH, safeNextPath, setupTokenFromHash } from "../authRedirect";
import { useT } from "../i18n";
import { shellStrings } from "../i18n/strings/shell";
import LangSwitch from "../components/LangSwitch";
import Callout from "../components/Callout";
import Snippet from "../components/Snippet";
import { useKeyInputGuard } from "../components/KeyInputGuard";

// SPEC.md §2: a lost token is replaced by a command run on the server itself (by the user that runs the service). The same code answers
// all three: the npm package, the Docker image (WORKDIR /app, MONEYSWITCH_DATA_DIR=/data) and a source checkout.
const RESET_NPM = "moneyswitch-server reset-admin-token --data-dir <data directory>";
const RESET_DOCKER = "docker compose exec server node /app/dist/cli.js reset-admin-token";
const RESET_SOURCE = "pnpm admin:reset-token -- --data-dir <data directory>";

/** One claim per setup token, however often the page mounts (React StrictMode runs effects twice in development; the token works once). */
const claims = new Map<string, Promise<string>>();
function claimOnce(setupToken: string): Promise<string> {
  let claim = claims.get(setupToken);
  if (!claim) {
    claim = claimSetupToken(setupToken);
    claims.set(setupToken, claim);
  }
  return claim;
}

export default function LoginPage() {
  const t = useT(shellStrings);
  const { loginAdmin, loading, error } = useAuth();
  const keyGuard = useKeyInputGuard();
  const [token, setToken] = useState("");
  const [reveal, setReveal] = useState(false);
  const [formatError, setFormatError] = useState(false);
  const [setupActive, setSetupActive] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimFailed, setClaimFailed] = useState(false);
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const next = safeNextPath(search.get("next")) ?? LANDING_PATH;
  // The one-time link of the first start (".../login#ms_setup_…"): the token is in the fragment, so it never reaches the server's logs.
  const setupToken = useMemo(() => setupTokenFromHash(window.location.hash), []);

  useEffect(() => {
    getSetupStatus()
      .then((s) => setSetupActive(s.setup_link_active))
      .catch(() => setSetupActive(false));
  }, []);

  useEffect(() => {
    if (!setupToken) return;
    let alive = true;
    setClaiming(true);
    claimOnce(setupToken)
      .then(async (adminToken) => {
        window.history.replaceState(null, "", window.location.pathname + window.location.search); // the one-time token leaves the address bar
        const ok = await loginAdmin(adminToken);
        if (alive && ok) navigate(next, { replace: true });
      })
      .catch(() => alive && setClaimFailed(true))
      .finally(() => alive && setClaiming(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupToken]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const candidate = token.trim();
    if (!candidate) return;
    setFormatError(false);
    if (!candidate.startsWith("ms_admin_")) {
      setFormatError(true);
      return;
    }
    if (await loginAdmin(candidate)) navigate(next, { replace: true });
  }

  const err = formatError ? t("login_err_format") : error === "admin_invalid" ? t("login_err_admin") : error ? t("login_err_unreachable") : null;

  return (
    <div className="login-shell">
      <div className="login-topright">
        <LangSwitch />
      </div>
      <div className="login-stack">
        {setupActive && !setupToken && (
          <Callout tone="info" title={t("login_setupActiveTitle")}>
            {t("login_setupActiveBody")}
          </Callout>
        )}
        {claiming && <Callout tone="info">{t("login_claiming")}</Callout>}
        {claimFailed && <Callout tone="warn">{t("login_claimFailed")}</Callout>}
        <div className="card login-card">
          <div className="login-brand">
            <div className="brand-mark">M</div>
            <div>
              <h1>MoneySwitch</h1>
            </div>
          </div>
          <p className="login-tagline">{t("login_tagline")}</p>
          <form onSubmit={onSubmit} noValidate>
            <div className="field">
              <label htmlFor="login-token">{t("login_label")}</label>
              <div className="input-with-action">
                <input
                  id="login-token"
                  type={reveal ? "text" : "password"}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(e) => {
                    setToken(keyGuard.filter(e.target.value));
                    setFormatError(false);
                  }}
                  placeholder={t("login_placeholder")}
                  aria-invalid={Boolean(err)}
                  aria-describedby={err ? "login-error" : undefined}
                />
                <button type="button" className="input-action" onClick={() => setReveal((r) => !r)} aria-label={reveal ? t("login_hide") : t("login_show")}>
                  {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {keyGuard.message}
            </div>
            {err && (
              <div id="login-error">
                <Callout tone="error">{err}</Callout>
              </div>
            )}
            <button className="btn big" type="submit" disabled={loading || !token.trim()}>
              {loading ? t("login_submitting") : t("login_submit")}
            </button>
          </form>

          <div className="login-help">
            <div className="login-help-title">{t("login_whereTitle")}</div>
            <p>{t("login_where")}</p>
            <details className="login-lost">
              <summary>{t("login_lostTitle")}</summary>
              <p>{t("login_lostBody")}</p>
              <Snippet title={t("login_lostNpm")} code={RESET_NPM} />
              <Snippet title={t("login_lostDocker")} code={RESET_DOCKER} />
              <Snippet title={t("login_lostSource")} code={RESET_SOURCE} />
            </details>
          </div>
          <div className="login-footnote">USDC · x402</div>
        </div>
      </div>
    </div>
  );
}
