import React, { useState } from "react";
import { Vault, Lock, Share2, EyeOff, CircleHelp } from "lucide-react";
import Drawer from "./Drawer";
import { useT } from "../i18n";
import { threeThings } from "../i18n/strings/threeThings";
import "../styles/threeThings.css";

/**
 * SPEC-v0.5 §1 — the "three things" explainer card:
 *   private key (never shown) · MoneyKey (secret, amber) · receiving address (public, green).
 */
export function ThreeThingsCard({ compact = false }: { compact?: boolean }) {
  const t = useT(threeThings);
  return (
    <section className={`three-things ${compact ? "compact" : ""}`} aria-labelledby="three-things-title">
      {!compact && (
        <header className="three-things-head">
          <h3 id="three-things-title">{t("title")}</h3>
          <p>{t("subtitle")}</p>
        </header>
      )}
      <div className="three-things-grid">
        <article className="thing thing-private">
          <div className="thing-illus" aria-hidden>
            <Vault size={26} strokeWidth={1.8} />
          </div>
          <div className="thing-badge">
            <EyeOff size={12} aria-hidden /> {t("neverShownBadge")}
          </div>
          <h4>{t("pkName")}</h4>
          <div className="thing-metaphor">{t("pkMetaphor")}</div>
          <div className="thing-who">{t("pkWho")}</div>
          <p>{t("pkBody")}</p>
        </article>
        <article className="thing thing-secret">
          <div className="thing-illus" aria-hidden>
            <Lock size={26} strokeWidth={1.8} />
          </div>
          <div className="thing-badge">
            <Lock size={12} aria-hidden /> {t("secretBadge")}
          </div>
          <h4>{t("mkName")}</h4>
          <div className="thing-metaphor">{t("mkMetaphor")}</div>
          <div className="thing-who">{t("mkWho")}</div>
          <p>{t("mkBody")}</p>
        </article>
        <article className="thing thing-public">
          <div className="thing-illus" aria-hidden>
            <Share2 size={26} strokeWidth={1.8} />
          </div>
          <div className="thing-badge">
            <Share2 size={12} aria-hidden /> {t("publicBadge")}
          </div>
          <h4>{t("addrName")}</h4>
          <div className="thing-metaphor">{t("addrMetaphor")}</div>
          <div className="thing-who">{t("addrWho")}</div>
          <p>{t("addrBody")}</p>
        </article>
      </div>
    </section>
  );
}

/** A small link-style button that opens the three-things card in a drawer. Usable on any page (incl. login). */
export function ThreeThingsButton({ className = "" }: { className?: string }) {
  const t = useT(threeThings);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn small ghost three-things-open ${className}`} onClick={() => setOpen(true)}>
        <CircleHelp size={14} aria-hidden /> {t("openButton")}
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title={t("title")} width={560}>
        <p className="muted" style={{ marginTop: 0 }}>
          {t("subtitle")}
        </p>
        <ThreeThingsCard compact />
      </Drawer>
    </>
  );
}
