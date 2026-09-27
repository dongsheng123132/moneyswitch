import Fastify from "fastify";
import { verifyTypedData } from "viem";
import { randomBytes } from "node:crypto";
import { TESTNET } from "@moneyswitch/x402";

/**
 * mock-facilitator: an offline stand-in for the real x402 facilitator, used
 * by T2 (`pnpm test:e2e`, SPEC §9). It speaks the exact HTTP wire protocol
 * expected by @x402/core's HTTPFacilitatorClient (POST /verify, POST
 * /settle, GET /supported) and performs REAL EIP-3009 signature
 * verification via viem's verifyTypedData — it does not hand-roll any
 * signature or 402 protocol logic. Settlement never touches a real chain:
 * it returns a deterministic `0xmock...` transaction hash and
 * `extra: { mock: true }` so the server/dashboard can flag it clearly.
 */

const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

interface Eip3009Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

interface ExactPayload {
  authorization: Eip3009Authorization;
  signature: `0x${string}`;
}

interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name?: string; version?: string; [k: string]: unknown };
}

interface PaymentPayload {
  x402Version: number;
  accepted: PaymentRequirements;
  payload: ExactPayload;
}

function chainIdFromNetwork(network: string): number {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new Error(`unsupported network format: ${network}`);
  return Number(m[1]);
}

async function verifyPayment(
  paymentPayload: PaymentPayload,
  requirements: PaymentRequirements
): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }> {
  const { authorization, signature } = paymentPayload.payload;
  const { name, version } = requirements.extra ?? {};
  if (!name || !version) {
    return { isValid: false, invalidReason: "missing extra.name/extra.version on requirements" };
  }
  if (requirements.scheme !== "exact") {
    return { isValid: false, invalidReason: "unsupported_scheme" };
  }
  if (authorization.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return { isValid: false, invalidReason: "payTo_mismatch" };
  }
  if (BigInt(authorization.value) !== BigInt(requirements.amount)) {
    return { isValid: false, invalidReason: "amount_mismatch" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (BigInt(authorization.validBefore) <= BigInt(now)) {
    return { isValid: false, invalidReason: "authorization_expired" };
  }
  if (BigInt(authorization.validAfter) > BigInt(now)) {
    return { isValid: false, invalidReason: "authorization_not_yet_valid" };
  }

  const chainId = chainIdFromNetwork(requirements.network);
  const domain = {
    name,
    version,
    chainId,
    verifyingContract: requirements.asset as `0x${string}`,
  };
  const message = {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  };

  const valid = await verifyTypedData({
    address: authorization.from,
    domain,
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message,
    signature,
  });

  if (!valid) {
    return { isValid: false, invalidReason: "invalid_signature" };
  }
  return { isValid: true, payer: authorization.from };
}

function fakeMockTxHash(): string {
  return "0xmock" + randomBytes(29).toString("hex");
}

/**
 * v0.5.2 test-only sentinel: an atomic amount ("13") no real demo-seller
 * route otherwise uses. Lets an e2e/unit test reproduce the "seller returns
 * 402 again after we paid" bug reported on Monad mainnet — a real
 * facilitator's /verify can 400 for reasons unrelated to signature validity
 * (e.g. insufficient_funds), which @x402/core's HTTPFacilitatorClient turns
 * into an `Error` that the resource server surfaces as another 402 with
 * `error: "Facilitator verify failed (400): ..."`. Only reproducible here by
 * actually answering /verify with a non-2xx status (isValid:false alone,
 * with a 200 status, is a different — already-handled — code path).
 */
export const FORCE_VERIFY_REJECT_AMOUNT = "13";

export function buildMockFacilitator() {
  const app = Fastify({ logger: false });

  app.post("/verify", async (req, reply) => {
    const body = req.body as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
    if (body.paymentRequirements?.amount === FORCE_VERIFY_REJECT_AMOUNT) {
      // See FORCE_VERIFY_REJECT_AMOUNT: a real facilitator's /verify returning
      // non-2xx (not just isValid:false) is what actually reproduces the bug.
      return reply.status(400).send({ isValid: false, invalidReason: "insufficient_funds" });
    }
    try {
      const result = await verifyPayment(body.paymentPayload, body.paymentRequirements);
      return reply.send(result);
    } catch (e) {
      return reply.status(400).send({
        isValid: false,
        invalidReason: e instanceof Error ? e.message : "verify_error",
      });
    }
  });

  app.post("/settle", async (req, reply) => {
    const body = req.body as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
    try {
      const result = await verifyPayment(body.paymentPayload, body.paymentRequirements);
      if (!result.isValid) {
        return reply.send({
          success: false,
          errorReason: result.invalidReason,
          network: body.paymentRequirements.network,
          transaction: "",
        });
      }
      return reply.send({
        success: true,
        transaction: fakeMockTxHash(),
        network: body.paymentRequirements.network,
        payer: result.payer,
        amount: body.paymentRequirements.amount,
        extra: { mock: true },
      });
    } catch (e) {
      return reply.status(400).send({
        success: false,
        errorReason: e instanceof Error ? e.message : "settle_error",
        network: body.paymentRequirements.network,
        transaction: "",
      });
    }
  });

  app.get("/supported", async (_req, reply) => {
    return reply.send({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: TESTNET.caip2,
          extra: { name: TESTNET.usdcDomainName, version: TESTNET.usdcDomainVersion },
        },
      ],
      extensions: [],
      signers: {},
    });
  });

  return app;
}

export async function startMockFacilitator(port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const app = buildMockFacilitator();
  await app.listen({ port, host: "127.0.0.1" });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => app.close(),
  };
}

// Allow `pnpm start` to run this directly.
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const port = Number(process.env.MOCK_FACILITATOR_PORT || 4099);
  startMockFacilitator(port).then(({ url }) => {
    console.log(`[mock-facilitator] listening at ${url}`);
  });
}
