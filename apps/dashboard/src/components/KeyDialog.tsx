import React, { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";

const FOCUSABLE = "a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]";

/** Include only controls that can actually receive focus in the current form. */
function focusableControls(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
    if (element.tabIndex < 0 || element.matches(":disabled") || element.closest("[hidden], [inert]")) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
  });
}

/** A focused creation flow: a centered dialog with its own scroll area. */
export default function KeyDialog({
  open,
  onClose,
  title,
  children,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  busy?: boolean;
}) {
  const t = useT(common);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const previousPadding = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    if (scrollbarWidth > 0) {
      const padding = parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = `${padding + scrollbarWidth}px`;
    }
    document.body.style.overflow = "hidden";

    const controls = focusableControls(panel);
    const firstField = controls.find((element) => element.matches("input:not([type=radio]):not([type=checkbox]), textarea, select"));
    (firstField ?? controls[0] ?? panel).focus({ preventScroll: true });

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const current = focusableControls(panel!);
      const first = current[0];
      const last = current[current.length - 1];
      if (!first) {
        event.preventDefault();
        panel!.focus();
      } else if (event.shiftKey && (document.activeElement === first || !current.includes(document.activeElement as HTMLElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !current.includes(document.activeElement as HTMLElement))) {
        event.preventDefault();
        first.focus();
      }
    }

    function onFocusIn(event: FocusEvent) {
      if (event.target instanceof Node && !panel!.contains(event.target)) {
        (focusableControls(panel!)[0] ?? panel!).focus({ preventScroll: true });
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPadding;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="key-dialog-overlay" onClick={(event) => {
      if (event.target === event.currentTarget && !busyRef.current) onCloseRef.current();
    }}>
      <div
        className="key-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="key-dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="key-dialog-close" onClick={onClose} disabled={busy} aria-label={t("close")}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="key-dialog-body">{children}</div>
      </div>
    </div>
  );
}
