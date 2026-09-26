import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import { useAuth } from "../auth";
import { getSetupStatus } from "../api";
import { useT } from "../i18n";
import { shellStrings } from "../i18n/strings/shell";
import LangSwitch from "../components/LangSwitch";
import Callout from "../components/Callout";
import Snippet from "../components/Snippet";

const RESET_CMD = "pnpm admin:reset-token -- --data-dir <MONEYSWITCH_DATA_DIR>";

export default function LoginPage() {
  const t = useT(shellStrings);
  const { loginAdmin, loginEmployee, loading, error, errorDetail } = useAuth();
  const [token, setToken] = useState("");
  const [reveal, setReveal] = useState(false);
  const [formatError, setFormatError] = useState(false);
  const [setupActive, setSetupActive] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    getSetupStatus()
      .then((s) => setSetupActive(s.setup_link_active))
      .catch(() => setSetupActive(false));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const candidate = token.trim();
    if (!candidate) return;
    setFormatError(false);
    if (candidate.startsWith("ms_admin_")) {
      if (await loginAdmin(candidate)) navigate("/", { replace: true });
      return;
    }
    if (candidate.startsWith("mk_live_")) {
      if (await loginEmployee(candidate)) navigate("/me", { replace: true });
      return;
    }
    setFormatError(true);
  }

  function errorText(): string | null {
    if (formatError) return t("login_err_format");
    if (!error) return null;
    switch (error) {
      case "admin_invalid":
        return t("login_err_admin");
      case "unreachable":
        return t("login_err_unreachable");
      case "KEY_INVALID":
        return t("login_err_KEY_INVALID");
      case "KEY_REVOKED":
        return t("login_err_KEY_REVOKED");
      case "KEY_EXPIRED":
        return t("login_err_KEY_EXPIRED");
      case "KEY_REVOKED_ANCESTOR":
        return t("login_err_KEY_REVOKED_ANCESTOR");
      case "KEY_EXPIRED_ANCESTOR":
        return t("login_err_KEY_EXPIRED_ANCESTOR");
      default:
        return t("login_err_generic", { message: errorDetail ?? error });
    }
  }
  const err = errorText();

  return (
    <div className="login-shell">
      <div className="login-topright">
        <LangSwitch />
      </div>
      <div className="login-stack">
        {setupActive && (
          <Callout tone="info" title={t("login_setupActiveTitle")}>
            {t("login_setupActiveBody")}
          </Callout>
        )}
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
                    setToken(e.target.value);
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
            <p>{t("login_whereAdmin")}</p>
            <p>{t("login_whereEmployee")}</p>
            <details className="login-lost">
              <summary>{t("login_lostTitle")}</summary>
              <p>{t("login_lostBody")}</p>
              <Snippet code={RESET_CMD} />
            </details>
          </div>
          <div className="login-footnote">USDC · Monad · x402</div>
        </div>
      </div>
    </div>
  );
}
