/**
 * The test payment of the ten-minute path (SPEC.md §0): on an instance that runs on a testnet, a key may be allowed to pay the
 * testnet receiver MoneySwitch runs (apps/demo-seller/receiver.mjs: one paid endpoint, 0.01 test USDC on Monad testnet, no real
 * value), and the install prompt then asks the AI to make exactly one payment to it and report the transaction hash.
 */
export const TEST_PAYMENT_URL = "https://app.moneyswitch.dev/x402-testnet/check";
/** What goes into a key's allowed hosts to permit TEST_PAYMENT_URL. */
export const TEST_PAYMENT_HOST = "app.moneyswitch.dev:443";
/** The only chain the receiver accepts. */
export const TEST_PAYMENT_NETWORK = "eip155:10143";
/** The price of the test endpoint in USDC (also the `max_price` the prompt tells the AI to send). */
export const TEST_PAYMENT_PRICE = "0.01";

/** The same matching rule as the server's host gate: an entry is the host:port or the bare host name. */
export function allowsTestPayment(allowedHosts: readonly string[] | null | undefined): boolean {
  return (allowedHosts ?? []).some((h) => {
    const entry = h.trim().toLowerCase();
    return entry === TEST_PAYMENT_HOST || entry === "app.moneyswitch.dev";
  });
}

export interface TestPaymentOffer {
  /** The key's allowed hosts. */
  allowedHosts: readonly string[];
  /** The instance's default network is a testnet. */
  testnet: boolean;
}

/** True only when the instance runs on a testnet AND the key may pay the test endpoint's host: nothing is ever offered on mainnet. */
export function offersTestPayment(offer: TestPaymentOffer | null | undefined): boolean {
  return Boolean(offer && offer.testnet === true && allowsTestPayment(offer.allowedHosts));
}
