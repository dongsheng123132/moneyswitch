import React, { useEffect, useState } from "react";
import { useT } from "./i18n";

export function Pill({ tone, children, title }: { tone: "green" | "yellow" | "red" | "gray" | "accent"; children: React.ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function money(v: string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2)}`;
}

export function CopyButton({ text, small }: { text: string; small?: boolean }) {
  const t = useT();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(id);
  }, [done]);
  return (
    <button
      type="button"
      className={`btn btn-ghost ${small ? "btn-xs" : "btn-sm"}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setDone(true));
      }}
    >
      {done ? t("copied") : t("copy")}
    </button>
  );
}

export function Switch({ checked, disabled, onChange, label, testId }: { checked: boolean; disabled?: boolean; onChange: () => void; label: string; testId?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      className={`switch ${checked ? "on" : ""}`}
      disabled={disabled}
      onClick={onChange}
    >
      <span className="switch-knob" />
    </button>
  );
}

export function Field({ label, hint, children, error }: { label: string; hint?: React.ReactNode; children: React.ReactNode; error?: string | null }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Callout({ tone, children }: { tone: "info" | "warn" | "error" | "ok"; children: React.ReactNode }) {
  return <div className={`callout callout-${tone}`}>{children}</div>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden />;
}
