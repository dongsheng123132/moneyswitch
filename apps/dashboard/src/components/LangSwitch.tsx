import React from "react";
import { Languages } from "lucide-react";
import { useLang } from "../i18n";

/** Top-right 中文 / EN switch. Remembers the choice in localStorage. */
export default function LangSwitch() {
  const { lang, setLang } = useLang();
  return (
    <div className="lang-switch" role="group" aria-label="Language / 语言">
      <Languages size={14} aria-hidden />
      <button type="button" className={lang === "zh" ? "active" : ""} aria-pressed={lang === "zh"} onClick={() => setLang("zh")}>
        中文
      </button>
      <button type="button" className={lang === "en" ? "active" : ""} aria-pressed={lang === "en"} onClick={() => setLang("en")}>
        EN
      </button>
    </div>
  );
}
