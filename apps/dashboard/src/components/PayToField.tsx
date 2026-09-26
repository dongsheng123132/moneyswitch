import React, { useId, useState } from "react";
import { ShieldAlert } from "lucide-react";
import Callout from "./Callout";
import PublicAddress from "./PublicAddress";
import { checkPayTo, type PayToErrorCode } from "../secretGuard";
import { useT } from "../i18n";
import { threeThings } from "../i18n/strings/threeThings";
import "../styles/threeThings.css";

export interface PayToValue {
  /** "wallet" = this MoneySwitch's own wallet (send no pay_to); "external" = `address`. */
  mode: "wallet" | "external";
  address: string;
}

const SECRET_CODES: PayToErrorCode[] = ["LOOKS_LIKE_MONEYKEY", "LOOKS_LIKE_ADMIN_TOKEN", "LOOKS_LIKE_PRIVATE_KEY", "LOOKS_LIKE_MNEMONIC"];

/** The pay_to to send to the API (undefined = wallet default), or an error code. */
export function resolvePayTo(v: PayToValue, walletAddress: string | null): { ok: true; payTo: string | undefined } | { ok: false; code: PayToErrorCode | "NO_WALLET" } {
  if (v.mode === "wallet") return walletAddress ? { ok: true, payTo: undefined } : { ok: false, code: "NO_WALLET" };
  const c = checkPayTo(v.address);
  return c.ok ? { ok: true, payTo: c.address } : { ok: false, code: c.code };
}

/**
 * SPEC-v0.5 §1 — "where does the money go?" field.
 *  - default: this MoneySwitch wallet (receives and pays), shown green/public;
 *  - external: any address the user owns, with the "MoneySwitch can't spend
 *    it for you" warning;
 *  - pasting a MoneyKey / admin token / private key / recovery phrase is
 *    blocked: the field is cleared on the spot and the mistake is explained.
 */
export default function PayToField({
  value,
  onChange,
  walletAddress,
  serverError,
}: {
  value: PayToValue;
  onChange: (v: PayToValue) => void;
  walletAddress: string | null;
  /** Error code returned by the server (INVALID_PAY_TO reason), shown under the field. */
  serverError?: string | null;
}) {
  const t = useT(threeThings);
  const inputId = useId();
  const [blocked, setBlocked] = useState<PayToErrorCode | null>(null);
  const [touched, setTouched] = useState(false);

  function setAddress(raw: string) {
    const c = checkPayTo(raw);
    if (!c.ok && SECRET_CODES.includes(c.code)) {
      // Never keep a secret in the field (or in React state that might be submitted).
      setBlocked(c.code);
      onChange({ mode: "external", address: "" });
      return;
    }
    setBlocked(null);
    onChange({ mode: "external", address: raw });
  }

  const check = value.mode === "external" && value.address.trim() !== "" ? checkPayTo(value.address) : null;
  const showError = check && !check.ok && (touched || value.address.trim().length >= 42);
  const serverCode = serverError && !blocked ? serverError : null;

  return (
    <div className="payto-field">
      <div className="payto-options" role="radiogroup" aria-label={t("payToLabel")}>
        <label className={`payto-option ${value.mode === "wallet" ? "selected" : ""}`}>
          <input
            type="radio"
            name={`${inputId}-mode`}
            checked={value.mode === "wallet"}
            onChange={() => {
              setBlocked(null);
              onChange({ mode: "wallet", address: value.address });
            }}
          />
          <div>
            <div className="payto-option-title">{t("payToUseWallet")}</div>
            <div className="payto-option-hint">{t("payToUseWalletHint")}</div>
          </div>
        </label>
        {value.mode === "wallet" &&
          (walletAddress ? (
            <PublicAddress address={walletAddress} qr="never" size="sm" />
          ) : (
            <Callout tone="warn">{t("payToNoWallet")}</Callout>
          ))}
        <label className={`payto-option ${value.mode === "external" ? "selected" : ""}`}>
          <input
            type="radio"
            name={`${inputId}-mode`}
            checked={value.mode === "external"}
            onChange={() => onChange({ mode: "external", address: value.address })}
          />
          <div>
            <div className="payto-option-title">{t("payToUseExternal")}</div>
          </div>
        </label>
      </div>

      {value.mode === "external" && (
        <div className="field payto-external">
          <label htmlFor={inputId}>{t("payToLabel")}</label>
          <input
            id={inputId}
            className={`mono payto-input ${check?.ok ? "is-valid" : ""} ${showError || blocked ? "is-invalid" : ""}`}
            value={value.address}
            placeholder={t("payToPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
            onBlur={() => {
              setTouched(true);
              if (check?.ok && check.address !== value.address) onChange({ mode: "external", address: check.address });
            }}
            aria-invalid={Boolean(showError || blocked)}
          />
          {blocked && (
            <div className="guard-blocked" role="alert">
              <ShieldAlert size={16} aria-hidden />
              <div>
                <div className="guard-blocked-title">{t("guardBlockedTitle")}</div>
                <div>{t(`pay_${blocked}` as "pay_LOOKS_LIKE_MONEYKEY")}</div>
                <div className="guard-blocked-sub">{t("guardCleared")}</div>
              </div>
            </div>
          )}
          {!blocked && showError && check && !check.ok && (
            <div className="field-error" role="alert">
              {t(`pay_${check.code}` as "pay_EMPTY")}
            </div>
          )}
          {!blocked && serverCode && (
            <div className="field-error" role="alert">
              {serverCode.startsWith("LOOKS_LIKE") || serverCode in PAY_CODES ? t(`pay_${serverCode}` as "pay_EMPTY") : serverCode}
            </div>
          )}
          {check?.ok && (
            <>
              <PublicAddress address={check.address} qr="never" size="sm" showNote={false} />
              <Callout tone="warn">{t("payToExternalWarn")}</Callout>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const PAY_CODES: Record<string, true> = {
  LOOKS_LIKE_MONEYKEY: true,
  LOOKS_LIKE_ADMIN_TOKEN: true,
  LOOKS_LIKE_PRIVATE_KEY: true,
  LOOKS_LIKE_MNEMONIC: true,
  EMPTY: true,
  NOT_AN_ADDRESS: true,
  BAD_CHECKSUM: true,
  ZERO_ADDRESS: true,
};
