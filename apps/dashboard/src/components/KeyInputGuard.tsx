import React, { useCallback, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { checkKeyInput, type KeyInputProblem } from "../secretGuard";
import { useT } from "../i18n";
import { threeThings } from "../i18n/strings/threeThings";
import "../styles/threeThings.css";

/**
 * SPEC-v0.5 §1 防呆 for MoneyKey / admin-token inputs: a pasted 0x address
 * (the public thing), private key or recovery phrase is rejected — the field
 * is cleared and the mix-up explained.
 *
 *   const guard = useKeyInputGuard();
 *   <input value={v} onChange={(e) => setV(guard.filter(e.target.value))} />
 *   {guard.message}
 */
export function useKeyInputGuard() {
  const [problem, setProblem] = useState<KeyInputProblem | null>(null);
  const filter = useCallback((raw: string): string => {
    const p = checkKeyInput(raw);
    setProblem(p);
    return p ? "" : raw;
  }, []);
  const reset = useCallback(() => setProblem(null), []);
  return { filter, reset, problem, message: problem ? <KeyGuardMessage problem={problem} /> : null };
}

export function KeyGuardMessage({ problem }: { problem: KeyInputProblem }) {
  const t = useT(threeThings);
  return (
    <div className="guard-blocked" role="alert">
      <ShieldAlert size={16} aria-hidden />
      <div>
        <div className="guard-blocked-title">{problem === "LOOKS_LIKE_ADDRESS" ? t("keyGuardAddressTitle") : t("guardBlockedTitle")}</div>
        <div>{t(`key_${problem}` as "key_LOOKS_LIKE_ADDRESS")}</div>
      </div>
    </div>
  );
}
