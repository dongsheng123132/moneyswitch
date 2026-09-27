const MAINNET_CAIP2 = "eip155:143";
const MAINNET_EXPLORER = "https://monadvision.com/tx/";
const TESTNET_EXPLORER = "https://testnet.monadvision.com/tx/";

/** Build an explorer link for a tx hash, per which Monad network it settled on. */
export function explorerTxUrl(txHash: string, network: string | null | undefined): string {
  const base = network === MAINNET_CAIP2 ? MAINNET_EXPLORER : TESTNET_EXPLORER;
  return `${base}${txHash}`;
}
