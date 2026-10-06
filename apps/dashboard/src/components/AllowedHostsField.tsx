import React from "react";
import { useT } from "../i18n";
import { keysStrings } from "../i18n/strings/keys";
import { TEST_PAYMENT_URL } from "../skillText";
import Callout from "./Callout";
import Term from "./Term";

/**
 * The hosts a new key may pay, with the ten-minute path's checkbox (SPEC.md §0): where the test payment is on offer (a testnet key on an
 * instance that enables the receiver's testnet) the test receiver's host can be added with one tick, checked by default.
 */
export default function AllowedHostsField({
  value,
  onChange,
  testAvailable,
  allowTest,
  onAllowTestChange,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The test payment endpoint is on offer for this key (see testPaymentAvailable). */
  testAvailable: boolean;
  allowTest: boolean;
  onAllowTestChange: (allow: boolean) => void;
}) {
  const t = useT(keysStrings);
  const testIncluded = testAvailable && allowTest;
  return (
    <div className="field">
      <label htmlFor="key-allowed-hosts">
        <Term k="allowedHosts">{t("allowedHostsLabel")}</Term>
      </label>
      <textarea id="key-allowed-hosts" rows={2} value={value} onChange={(e) => onChange(e.target.value)} placeholder={t("allowedHostsPlaceholder")} />
      <div className="field-hint">{t("allowedHostsHint")}</div>
      {testAvailable && (
        <label className="keys-test-endpoint">
          <input type="checkbox" checked={allowTest} onChange={(e) => onAllowTestChange(e.target.checked)} />
          <span>{t("testEndpointLabel", { url: TEST_PAYMENT_URL })}</span>
        </label>
      )}
      {testIncluded && <div className="field-hint">{t("testEndpointHint")}</div>}
      {value.trim() === "" && !testIncluded && <Callout tone="info">{t("allowedHostsHintEmpty")}</Callout>}
    </div>
  );
}
