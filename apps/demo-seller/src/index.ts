import { TESTNET } from "@moneyswitch/x402";
import { createDemoSellerApp } from "./app.js";

const PORT = Number(process.env.DEMO_SELLER_PORT || 4021);
const PAY_TO = process.env.DEMO_SELLER_PAY_TO;
const FACILITATOR_URL = process.env.DEMO_SELLER_FACILITATOR_URL || TESTNET.facilitatorUrl;

if (!PAY_TO) {
  console.error("[demo-seller] DEMO_SELLER_PAY_TO env var is required (must NOT equal MoneySwitch's wallet address)");
  process.exit(1);
}

const app = createDemoSellerApp({
  payTo: PAY_TO,
  facilitatorUrl: FACILITATOR_URL,
  testRoutes: process.env.DEMO_SELLER_TEST_ROUTES === "1",
});

app.listen(PORT, () => {
  console.log(`[demo-seller] listening on :${PORT}, payTo=${PAY_TO}, facilitator=${FACILITATOR_URL}`);
});
