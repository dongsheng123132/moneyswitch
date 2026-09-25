import React, { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";

/**
 * Side drawer dialog: Esc closes, focus moves into the drawer on open (first
 * form field, else the close button) and returns to the opener on close
 * (docs/ux-audit.md X-3).
 */
export default function Drawer({
  open,
  onClose,
  title,
  children,
  width = 460,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: number;
}) {
  const t = useT(common);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select") ?? panel?.querySelector<HTMLElement>(".drawer-close");
    first?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div
        className="drawer"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t("close")}>
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}
