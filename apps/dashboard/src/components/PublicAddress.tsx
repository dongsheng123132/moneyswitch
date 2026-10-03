import React, { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Share2, QrCode } from "lucide-react";
import CopyButton from "./CopyButton";
import { useT } from "../i18n";
import { secretStrings } from "../i18n/strings/secrets";
import "../styles/secrets.css";

/**
 * The wallet address, always rendered the same way: green, share icon,
 * "Public: safe to share" - so users learn "green = shareable".
 */
export default function PublicAddress({
  address,
  label,
  showNote = true,
  qr = "toggle",
  size = "md",
}: {
  address: string;
  label?: React.ReactNode;
  showNote?: boolean;
  /** "toggle" = QR behind a button, "always" = QR shown, "never" = no QR. */
  qr?: "toggle" | "always" | "never";
  size?: "sm" | "md" | "lg";
}) {
  const t = useT(secretStrings);
  const [qrOpen, setQrOpen] = useState(qr === "always");
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <div className={`public-address size-${size}`}>
      <div className="public-address-head">
        <span className="public-badge">
          <Share2 size={12} aria-hidden /> {t("publicBadge")}
        </span>
        {label && <span className="public-address-label">{label}</span>}
      </div>
      <div className="public-address-row">
        <code className="public-address-value mono">{address}</code>
        <div className="public-address-actions">
          <CopyButton text={address} />
          {canShare && (
            <button type="button" className="btn small secondary" onClick={() => navigator.share({ text: address }).catch(() => undefined)}>
              <Share2 size={12} aria-hidden /> {t("shareAddress")}
            </button>
          )}
          {qr === "toggle" && (
            <button type="button" className="btn small secondary" onClick={() => setQrOpen((o) => !o)} aria-expanded={qrOpen}>
              <QrCode size={12} aria-hidden /> {qrOpen ? t("hideQr") : t("showQr")}
            </button>
          )}
        </div>
      </div>
      {qrOpen && qr !== "never" && (
        <div className="public-address-qr">
          <QRCodeSVG value={address} size={132} includeMargin bgColor="#ffffff" fgColor="#0b0d12" />
        </div>
      )}
      {showNote && <div className="public-address-note">{t("publicAddressNote")}</div>}
    </div>
  );
}
