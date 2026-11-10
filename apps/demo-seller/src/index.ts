import { TESTNET, getNetwork, type NetworkConfig } from "@moneyswitch/x402";
import { createDemoSellerApp } from "./app.js";

const PORT = Number(process.env.DEMO_SELLER_PORT || 4021);
const PAY_TO = process.env.DEMO_SELLER_PAY_TO;
/** DEMO_SELLER_NETWORK=eip155:44005 quotes QDay Aevum (tUSD8) instead of Monad testnet (USDC). */
const NETWORK: NetworkConfig = process.env.DEMO_SELLER_NETWORK
  ? getNetwork(process.env.DEMO_SELLER_NETWORK.trim())
  : TESTNET;
const FACILITATOR_URL = process.env.DEMO_SELLER_FACILITATOR_URL || NETWORK.facilitatorUrl;

if (!PAY_TO) {
  console.error("[demo-seller] DEMO_SELLER_PAY_TO env var is required (must NOT equal MoneySwitch's wallet address)");
  process.exit(1);
}

const app = createDemoSellerApp({
  payTo: PAY_TO,
  facilitatorUrl: FACILITATOR_URL,
  network: NETWORK,
  testRoutes: process.env.DEMO_SELLER_TEST_ROUTES === "1",
});

app.listen(PORT, () => {
  console.log(`[demo-seller] listening on :${PORT}, network=${NETWORK.caip2} (${NETWORK.label}), asset=${NETWORK.usdcAddress}, payTo=${PAY_TO}, facilitator=${FACILITATOR_URL}`);
});
