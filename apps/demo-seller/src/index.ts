import { TESTNET } from "@moneyswitch/x402";
import { createDemoSellerApp, assertOpenRouterModelAvailable, DEFAULT_UPSTREAM_MODEL } from "./app.js";

const PORT = Number(process.env.DEMO_SELLER_PORT || 4021);
const PAY_TO = process.env.DEMO_SELLER_PAY_TO;
const FACILITATOR_URL = process.env.DEMO_SELLER_FACILITATOR_URL || TESTNET.facilitatorUrl;
const DEMO_LLM_UPSTREAM_KEY = process.env.DEMO_LLM_UPSTREAM_KEY;
const DEMO_LLM_UPSTREAM_MODEL = process.env.DEMO_LLM_UPSTREAM_MODEL || DEFAULT_UPSTREAM_MODEL;

if (!PAY_TO) {
  console.error("[demo-seller] DEMO_SELLER_PAY_TO env var is required (must NOT equal MoneySwitch's wallet address)");
  process.exit(1);
}

const app = createDemoSellerApp({
  payTo: PAY_TO,
  facilitatorUrl: FACILITATOR_URL,
  upstreamKey: DEMO_LLM_UPSTREAM_KEY,
  upstreamModel: DEMO_LLM_UPSTREAM_MODEL,
  testRoutes: process.env.DEMO_SELLER_TEST_ROUTES === "1",
});

assertOpenRouterModelAvailable(DEMO_LLM_UPSTREAM_KEY, DEMO_LLM_UPSTREAM_MODEL)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[demo-seller] listening on :${PORT}, payTo=${PAY_TO}, facilitator=${FACILITATOR_URL}`);
    });
  })
  .catch((e) => {
    console.error(`[demo-seller] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
