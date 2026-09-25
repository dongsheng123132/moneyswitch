import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Tiny i18n layer (docs/ux-audit.md A-13).
 *
 * - Two languages: "zh" and "en". Default follows the browser
 *   (navigator.languages), the user's explicit choice is remembered in
 *   localStorage and wins afterwards.
 * - All copy lives under src/i18n/strings/*.ts, one file per area, each built
 *   with defineMessages(en, zh). The zh object is typed against the en keys,
 *   so a missing translation is a compile error, not a runtime blank.
 * - `{name}` placeholders are interpolated by t(key, { name }).
 */
export type Lang = "zh" | "en";

const LANG_STORAGE_KEY = "moneyswitch_lang";

export interface Messages<K extends string> {
  en: Record<K, string>;
  zh: Record<K, string>;
}

export function defineMessages<T extends Record<string, string>>(en: T, zh: Record<keyof T, string>): Messages<Extract<keyof T, string>> {
  return { en, zh } as Messages<Extract<keyof T, string>>;
}

export function detectBrowserLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // storage unavailable — fall through to navigator
  }
  const langs = typeof navigator !== "undefined" ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  for (const l of langs) {
    const lower = (l || "").toLowerCase();
    if (lower.startsWith("zh")) return "zh";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
}

const LangContext = createContext<LangState>({ lang: "en", setLang: () => undefined });

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => detectBrowserLang());
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, l);
    } catch {
      // ignore
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);
  const value = useMemo(() => ({ lang, setLang }), [lang, setLang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangState {
  return useContext(LangContext);
}

export type TFunction<K extends string> = (key: K, vars?: Record<string, string | number>) => string;

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Returns t() bound to the current language for one message bundle. */
export function useT<K extends string>(messages: Messages<K>): TFunction<K> {
  const { lang } = useLang();
  return useCallback(
    (key: K, vars?: Record<string, string | number>) => interpolate(messages[lang][key] ?? messages.en[key] ?? key, vars),
    [lang, messages]
  );
}
