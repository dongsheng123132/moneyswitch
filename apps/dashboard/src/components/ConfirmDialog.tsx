import React, { useEffect, useId, useRef } from "react";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";

/**
 * Small centered confirmation dialog (the legacy .modal styles): Esc or a
 * click on the backdrop cancels, focus starts on Cancel so a stray Enter
 * never confirms a destructive action, and returns to the opener on close.
 */
export default function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busy = false,
  danger = true,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  error?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT(common);
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancelRef.current();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={busy ? undefined : onCancel}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h2 id={titleId}>{title}</h2>
        <div className="confirm-body">{children}</div>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" ref={cancelRef} className="btn secondary" onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </button>
          <button type="button" className={`btn ${danger ? "danger" : ""}`} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
