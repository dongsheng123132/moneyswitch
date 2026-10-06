import React from "react";
import { useT } from "../i18n";
import { keysStrings } from "../i18n/strings/keys";

/**
 * The approval PIN input (SPEC.md §3): 4-6 digits for the person who holds the key, empty for a random one. Digits only, at most six: the
 * field never holds anything the server would refuse for its shape. Used by the key form and by "Set confirmation code".
 */
export default function ApprovalPinField({
  id,
  value,
  onChange,
  error,
  hint = false,
}: {
  id: string;
  value: string;
  onChange: (pin: string) => void;
  error?: string;
  /** Under the field: what the code is for and that the AI never has it. */
  hint?: boolean;
}) {
  const t = useT(keysStrings);
  return (
    <div className="field">
      <label htmlFor={id}>{t("pinFieldLabel")}</label>
      <input
        id={id}
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={6}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
        placeholder={t("pinFieldPlaceholder")}
      />
      {hint && <div className="field-hint">{t("pinFieldHint")}</div>}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}
