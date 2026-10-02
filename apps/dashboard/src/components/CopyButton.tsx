import React, { useState } from "react";
import { Copy, Check } from "lucide-react";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";

/**
 * Copy-to-clipboard button. `className="icon-only"` renders a compact icon
 * button (still labelled for screen readers). Feedback text is localized and
 * announced via aria-live.
 */
export default function CopyButton({
  text,
  className = "",
  label,
  copiedLabel,
  big = false,
}: {
  text: string;
  className?: string;
  label?: string;
  /** Text shown for a moment after copying (default: the localized "Copied"). */
  copiedLabel?: string;
  /** Large primary variant, for the one action a view is about. */
  big?: boolean;
}) {
  const t = useT(common);
  const [copied, setCopied] = useState(false);
  const iconOnly = className.split(" ").includes("icon-only");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for environments without clipboard permission.
      const el = document.createElement("textarea");
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const shown = copied ? copiedLabel ?? t("copied") : label ?? t("copy");
  return (
    <button
      type="button"
      className={`btn ${big ? "big" : "small secondary"} copy-btn ${copied ? "is-copied" : ""} ${className}`}
      onClick={copy}
      aria-label={iconOnly ? shown : undefined}
      title={iconOnly ? shown : undefined}
    >
      {copied ? <Check size={big ? 16 : 12} aria-hidden /> : <Copy size={big ? 16 : 12} aria-hidden />}
      {!iconOnly && <span aria-live="polite">{shown}</span>}
    </button>
  );
}
