import { useCallback } from "react";
import { useLang, useT } from "./index";
import { common } from "./strings/common";

/** Localized "5m ago"/"5 分钟前". */
export function useRelativeTime(): (iso: string, now?: Date) => string {
  const t = useT(common);
  const { lang } = useLang();
  return useCallback(
    (iso: string, now: Date = new Date()) => {
      const diffSec = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
      if (diffSec < 5) return t("justNow");
      if (diffSec < 60) return t("secondsAgo", { n: diffSec });
      const min = Math.round(diffSec / 60);
      if (min < 60) return t("minutesAgo", { n: min });
      const hr = Math.round(min / 60);
      if (hr < 24) return t("hoursAgo", { n: hr });
      const day = Math.round(hr / 24);
      if (day < 30) return t("daysAgo", { n: day });
      return new Date(iso).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US");
    },
    [t, lang]
  );
}

/** Localized absolute date-time. */
export function useDateTime(): (iso: string) => string {
  const { lang } = useLang();
  return useCallback((iso: string) => new Date(iso).toLocaleString(lang === "zh" ? "zh-CN" : "en-US", { hour12: false }), [lang]);
}
