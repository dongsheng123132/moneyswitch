import React, { useId, useState } from "react";
import { Info } from "lucide-react";
import { useT } from "../i18n";
import { glossary } from "../i18n/strings/glossary";

export type GlossaryKey = keyof typeof glossary.en;

/**
 * A label with a small (i) that explains a term on hover AND keyboard focus
 * (docs/ux-audit.md X-1). The explanation is wired with aria-describedby so
 * screen readers read it too.
 */
export default function Term({ k, children, className = "" }: { k: GlossaryKey; children?: React.ReactNode; className?: string }) {
  const t = useT(glossary);
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className={`term ${className}`}>
      {children}
      <span
        className="term-trigger"
        tabIndex={0}
        role="button"
        aria-describedby={id}
        aria-label="?"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        <Info size={12} strokeWidth={2.2} />
        <span id={id} role="tooltip" className={`term-tip ${open ? "open" : ""}`}>
          {t(k)}
        </span>
      </span>
    </span>
  );
}
