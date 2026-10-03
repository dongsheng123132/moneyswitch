import express from "express";
import { x402ResourceServer } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/express";
import type { RoutesConfig } from "@x402/core/server";
import { TESTNET } from "@moneyswitch/x402";
import { parseUsdcToMicros } from "@moneyswitch/core";

export interface DemoSellerOptions {
  /** Receiving address for every paid route (must NOT equal MoneySwitch's wallet address). */
  payTo: string;
  /** x402 facilitator (the offline mock-facilitator in tests). */
  facilitatorUrl?: string;
  /** Registers test-only routes (GET /always-rejected). Off unless DEMO_SELLER_TEST_ROUTES=1 — e2e tests only. */
  testRoutes?: boolean;
}

/**
 * Builds the minimal x402 test seller as an Express app (not listening yet): a free route and a few
 * priced GET routes (plus one priced POST that echoes its JSON body). Used by ./index.ts
 * (env-driven `node dist/index.js`) and by the end-to-end tests.
 */
export function createDemoSellerApp(opts: DemoSellerOptions): express.Express {
  const PAY_TO = opts.payTo;
  const FACILITATOR_URL = opts.facilitatorUrl || TESTNET.facilitatorUrl;

  const scheme = new ExactEvmScheme();
  // Testnet USDC is not in the SDK's default asset table (SPEC §1 / PR #3570
  // unmerged), so a custom money parser must be registered to convert decimal
  // price strings ("0.01") into the atomic amount + asset + EIP-712 domain
  // extra, per https://docs.monad.xyz/guides/x402
  scheme.registerMoneyParser(async (amount) => {
    return {
      amount: parseUsdcToMicros(String(amount)).toString(),
      asset: TESTNET.usdcAddress,
      extra: { name: TESTNET.usdcDomainName, version: TESTNET.usdcDomainVersion },
    };
  });

  const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    TESTNET.caip2 as `${string}:${string}`,
    scheme
  );

  const routes: RoutesConfig = {
    "GET /premium-report": {
      accepts: { scheme: "exact", payTo: PAY_TO, price: "0.01", network: TESTNET.caip2 as `${string}:${string}` },
      description: "Premium report — normal payment",
    },
    "GET /deep-report": {
      accepts: { scheme: "exact", payTo: PAY_TO, price: "0.15", network: TESTNET.caip2 as `${string}:${string}` },
      description: "Deep report — priced above a typical approval_threshold to trigger APPROVAL_REQUIRED",
    },
    "GET /greedy": {
      accepts: { scheme: "exact", payTo: PAY_TO, price: "5.00", network: TESTNET.caip2 as `${string}:${string}` },
      description: "Greedy endpoint — priced above a typical per_request_limit",
    },
    // A priced POST with a JSON body (the approval flow hashes the request body, so tests need one).
    "POST /echo": {
      accepts: { scheme: "exact", payTo: PAY_TO, price: "0.01", network: TESTNET.caip2 as `${string}:${string}` },
      description: "Echo — 0.01 USDC per call, returns the JSON body it was sent",
    },
    // v0.5.2 test-only: amount "13" (0.000013 USDC) is a sentinel the
    // mock-facilitator (FORCE_VERIFY_REJECT_AMOUNT) always answers /verify
    // for with HTTP 400 — reproduces "seller returns 402 again after we
    // signed and paid" (real Monad-mainnet bug, insufficient_funds at the
    // facilitator). Only registered with opts.testRoutes (PAYMENT_REJECTED
    // e2e test), so a real facilitator can never settle it.
    ...(opts.testRoutes
      ? {
          "GET /always-rejected": {
            accepts: { scheme: "exact" as const, payTo: PAY_TO, price: "0.000013", network: TESTNET.caip2 as `${string}:${string}` },
            description: "Test-only: facilitator /verify always rejects this payment (400 insufficient_funds)",
          },
        }
      : {}),
  };

  const app = express();
  app.use(express.json());

  app.get("/free", (_req, res) => {
    res.json({ free: true, message: "no payment required" });
  });

  app.use(paymentMiddleware(routes, resourceServer));

  app.get("/premium-report", (_req, res) => {
    res.json({ report: "premium content", price: "0.01" });
  });
  app.get("/deep-report", (_req, res) => {
    res.json({ report: "deep content", price: "0.15" });
  });
  app.get("/greedy", (_req, res) => {
    res.json({ report: "should never be reached by a budgeted key", price: "5.00" });
  });
  app.post("/echo", (req, res) => {
    res.json({ echo: req.body ?? null, price: "0.01" });
  });
  if (opts.testRoutes) {
    app.get("/always-rejected", (_req, res) => {
      res.json({ report: "should never be reached — facilitator /verify always rejects this route" });
    });
  }

  return app;
}
