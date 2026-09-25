import React from "react";
import { ExternalLink } from "lucide-react";
import CopyButton from "./CopyButton";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";

export const EXPLORER_TX_BASE = "https://testnet.monadvision.com/tx/";

export function isMockTx(txHash: string | null | undefined): boolean {
  return Boolean(txHash && txHash.startsWith("0xmock"));
}

/** tx hash cell: explorer link (real) or muted text (mock), always copyable (docs/ux-audit.md D-4). */
export default function TxLink({ txHash, mock }: { txHash: string | null | undefined; mock?: boolean }) {
  const t = useT(common);
  if (!txHash) return <span className="dim">-</span>;
  const short = `${txHash.slice(0, 8)}…${txHash.slice(-4)}`;
  const isMock = mock ?? isMockTx(txHash);
  return (
    <span className="tx-cell">
      {isMock ? (
        <span className="mono dim" title={t("mockTxHint")}>
          {short}
        </span>
      ) : (
        <a className="mono" href={EXPLORER_TX_BASE + txHash} target="_blank" rel="noreferrer" title={t("viewTx")}>
          {short}
          <ExternalLink size={11} aria-hidden style={{ marginLeft: 3, verticalAlign: -1 }} />
        </a>
      )}
      <CopyButton text={txHash} className="icon-only" />
    </span>
  );
}
