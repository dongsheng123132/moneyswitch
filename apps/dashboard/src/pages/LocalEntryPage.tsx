import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { defineMessages, useT } from "../i18n";

const messages = defineMessages({
  opening: "Opening your local wallet…",
  failed: "This launch link has expired or was already used. Double-click the desktop shortcut again.",
  login: "Sign in manually",
}, {
  opening: "正在打开本地钱包…",
  failed: "启动链接已过期或已使用，请重新双击桌面快捷方式。",
  login: "手动登录",
});

export default function LocalEntryPage() {
  const t = useT(messages);
  const { loginAdmin } = useAuth();
  const navigate = useNavigate();
  const [secret] = useState(() => window.location.hash.slice(1));
  const [failed, setFailed] = useState(false);
  const inFlight = useRef<Promise<boolean>>();
  useEffect(() => {
    let active = true;
    window.history.replaceState(null, "", "/local");
    if (!inFlight.current) inFlight.current = (async () => {
      if (!/^ms_setup_[A-Za-z0-9_-]+$/.test(secret)) throw new Error("invalid_link");
      const response = await fetch("/v1/local/claim", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ local_token: secret }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("expired_link");
      const result = await response.json();
      return loginAdmin(result.admin_token);
    })();
    inFlight.current.then(ok => { if (active) { if (ok) navigate("/wallet", { replace: true }); else setFailed(true); } }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [secret, loginAdmin, navigate]);
  return <main className="card" style={{ maxWidth: 520, margin: "80px auto" }}>
    <h1>MoneySwitch</h1><p role="status">{t(failed ? "failed" : "opening")}</p>
    {failed && <Link to="/login">{t("login")}</Link>}
  </main>;
}
