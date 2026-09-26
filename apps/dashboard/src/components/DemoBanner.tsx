import React, { useEffect } from "react";
import { FlaskConical } from "lucide-react";
import { useDemoMode } from "../demoMode";
import { useT } from "../i18n";
import { demoStrings } from "../i18n/strings/demo";

/** Always-visible strip on every screen of the offline demo: "DEMO · simulated settlement, no real money". */
export default function DemoBanner() {
  const demo = useDemoMode();
  const t = useT(demoStrings);
  useEffect(() => {
    document.body.classList.toggle("ms-demo", demo);
    if (demo && !document.title.startsWith("DEMO")) document.title = `DEMO · ${document.title}`;
  }, [demo]);
  if (!demo) return null;
  return (
    <div className="demo-banner" role="note" data-testid="demo-banner">
      <FlaskConical size={14} aria-hidden />
      <strong className="demo-banner-tag">{t("bannerTag")}</strong>
      <span>{t("bannerText")}</span>
      <span className="demo-banner-exit">{t("bannerExit")}</span>
    </div>
  );
}
