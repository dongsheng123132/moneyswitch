import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { App } from "./App";
import { detectLang, LangContext, saveLang, useT, type Lang } from "./i18n";
import { Spinner } from "./ui";
import "./styles.css";

/**
 * Boot: take the one-time token from the URL fragment, remove it from the
 * address bar/history immediately, exchange it for the httpOnly session
 * cookie, then render. Without a token we try the existing cookie.
 */
function Boot() {
  const t = useT();
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [hadToken, setHadToken] = useState(false);

  useEffect(() => {
    const token = window.location.hash.replace(/^#/, "");
    if (token) {
      setHadToken(true);
      window.history.replaceState(null, "", window.location.pathname);
    }
    (async () => {
      if (token) {
        try {
          await api("POST", "/api/session", { token });
        } catch {
          // fall through: maybe we already have a cookie from this browser session
        }
      }
      try {
        await api("GET", "/api/state");
        setPhase("ready");
      } catch {
        setPhase("failed");
      }
    })();
  }, []);

  if (phase === "loading")
    return (
      <div className="center-screen">
        <Spinner /> <span className="muted">{t("loginTitle")}</span>
      </div>
    );
  if (phase === "failed")
    return (
      <div className="center-screen">
        <div className="panel login-failed" data-testid="login-failed">
          <h2>{t("loginFailedTitle")}</h2>
          <p className="muted">{hadToken ? t("loginFailedBody") : t("loginNoToken")}</p>
          <pre className="cmd">moneyswitch ui</pre>
        </div>
      </div>
    );
  return <App />;
}

function Root() {
  const [lang, setLangState] = useState<Lang>(() => detectLang());
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);
  return (
    <LangContext.Provider
      value={{
        lang,
        setLang: (l) => {
          saveLang(l);
          setLangState(l);
        },
      }}
    >
      <Boot />
    </LangContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
