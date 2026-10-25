import React from "react";
import { ExternalLink } from "lucide-react";
import CopyButton from "./CopyButton";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";
import { useAdminMeta } from "../useAdminMeta";

export const EXPLORER_TX_BASE = "https://testnet.monadvision.com/tx/";
/**
 * Solana Devnet's CAIP-2 id (Solana mainnet is `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`). Used only as the pre-meta fallback: the admin
 * meta's `is_mainnet` is authoritative once it has loaded, so this list does not have to grow with every Solana cluster.
 */
export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

/** The Solana explorer URL for a transaction: mainnet is the explorer's default, Devnet has to name its cluster. */
export function solanaTxExplorerUrl(txHash: string, isMainnet: boolean): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(txHash)}${isMainnet ? "" : "?cluster=devnet"}`;
}

export function isMockTx(txHash: string | null | undefined): boolean {
  return Boolean(txHash && txHash.startsWith("0xmock"));
}

/**
 * tx hash cell: explorer link (real) or muted text (mock), always copyable. `network` (CAIP-2) picks the explorer of the chain the
 * payment was made on; without it (or when the server does not know that chain) the default network's explorer is used.
 */
export default function TxLink({ txHash, mock, network }: { txHash: string | null | undefined; mock?: boolean; network?: string | null }) {
  const t = useT(common);
  const meta = useAdminMeta();
  if (!txHash) return <span className="dim">-</span>;
  const short = `${txHash.slice(0, 8)}…${txHash.slice(-4)}`;
  const isMock = mock ?? isMockTx(txHash);
  const chain = network ? meta?.networks?.find((n) => n.network === network) : undefined;
  const explorerBase = chain?.explorer_base || meta?.explorer_base;
  const explorerTxBase = explorerBase ? `${explorerBase}/tx/` : EXPLORER_TX_BASE;
  // A Solana tx needs the cluster only when it is not mainnet; before the admin meta loads, the one known Devnet id is treated as Devnet.
  const solanaMainnet = chain ? chain.is_mainnet : network !== SOLANA_DEVNET_CAIP2;
  return (
    <span className="tx-cell">
      {isMock ? (
        <span className="mono dim" title={t("mockTxHint")}>
          {short}
        </span>
      ) : (
        <a className="mono" href={network?.startsWith("solana:") ? solanaTxExplorerUrl(txHash, solanaMainnet) : explorerTxBase + txHash} target="_blank" rel="noreferrer" title={t("viewTx")}>
          {short}
          <ExternalLink size={11} aria-hidden style={{ marginLeft: 3, verticalAlign: -1 }} />
        </a>
      )}
      <CopyButton text={txHash} className="icon-only" />
    </span>
  );
}
