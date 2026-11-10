import Fastify from "fastify";
import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  getAddress,
  http,
  keccak256,
  parseSignature,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { QDAY_TESTNET } from "@moneyswitch/x402";

/**
 * An x402 facilitator for QDay Aevum testnet.
 *
 * Why this exists: QDay publishes no x402 facilitator, and its official payment SDK is announced for Q1 2027. The chain
 * itself is ready for the exact-EVM scheme — tUSD8 (0x4565…3483, a transparent proxy onto 0xd6be…7597) implements EIP-3009
 * `transferWithAuthorization` / `authorizationState`, and its EIP-712 domain is `{name:"tUSD8",version:"2"}` (the pinned
 * domain separator is asserted in `packages/x402/test/qday-network.test.ts`). So the only missing piece is the server half:
 * verify a signed authorization off-chain, then submit it on-chain from a relayer that holds tQDAY for gas.
 *
 * The wire protocol is the one `@x402/core`'s `HTTPFacilitatorClient` speaks (POST /verify, POST /settle, GET /supported),
 * so the seller side needs no special casing: it points `facilitatorUrl` at this service. That is exactly what
 * `apps/demo-seller` already does when `DEMO_SELLER_NETWORK=eip155:44005`.
 *
 * Settlement is REAL: `transferWithAuthorization` is broadcast, and the response's `transaction` is the on-chain hash.
 * Nothing here ever holds funds — tUSD8 moves payer → `payTo` inside the token contract; the relayer only pays gas.
 */

/** QDay Aevum testnet as viem sees it. Chain IDs are not in viem's built-in list, so the chain object is spelled out. */
export const qdayAevum = {
  id: 44005,
  name: "QDay Aevum testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [QDAY_TESTNET.rpcUrl] } },
} as const;

/** Only the fragments this service calls; tUSD8 is otherwise a standard ERC-20 (6 decimals). */
const TUSD8_ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/**
 * QDayPayReceiver (contracts/src/QDayPayReceiver.sol): the optional on-chain payee.
 *
 * When a seller quotes `payTo` = this contract, settling with a raw token transfer would move the money but leave no
 * receipt and no business-level replay guard. Calling `pay(...)` instead makes the three steps one transaction: pull the
 * authorized tUSD8 in, forward it to the beneficiary, record the order id — all or nothing.
 */
export const RECEIVER_ABI = [
  {
    type: "function",
    name: "pay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "bytes32" },
      { name: "from", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

export const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface Eip3009Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface ExactPayload {
  authorization: Eip3009Authorization;
  signature: Hex;
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name?: string; version?: string;[k: string]: unknown };
}

export interface PaymentPayload {
  x402Version: number;
  accepted: PaymentRequirements;
  payload: ExactPayload;
}

/**
 * The three chain reads verification needs. Injected so the unit tests can exercise every refusal path with no RPC
 * (and no anvil), while production uses the real QDay node. `null` means "the chain could not answer" — which must never
 * be read as "fine": callers treat it explicitly.
 */
export interface ChainReader {
  authorizationState(from: Address, nonce: Hex): Promise<boolean | null>;
  balanceOf(owner: Address): Promise<bigint | null>;
  /** Latest block timestamp in seconds — the clock `validBefore` is compared against on-chain. */
  timestamp(): Promise<number>;
}

export interface FacilitatorOptions {
  /** JSON-RPC of QDay Aevum (default: the network config's RPC). */
  rpcUrl?: string;
  /** tUSD8 address (default: the network config's asset). */
  asset?: string;
  /** CAIP-2 network this facilitator serves; anything else is refused. */
  network?: string;
  /** Key that broadcasts settlements and pays tQDAY gas. Optional for read-only/verification-only mode. */
  relayerKey?: Hex;
  /** Injected clock, seconds. Used only when the chain cannot answer. Tests pin it so windows are deterministic. */
  now?: () => number;
  /** Address of the deployed QDayPayReceiver; when a quote's payTo is this contract, /settle calls pay() instead. */
  receiverAddress?: Address;
  /** Overrides the chain reads (tests). */
  reader?: ChainReader;
}

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: Address;
}

export interface SettleResult {
  success: boolean;
  transaction: string;
  network: string;
  payer?: Address;
  amount?: string;
  errorReason?: string;
  /** Chain facts the dashboard/skill can show without a second call. */
  extra?: Record<string, unknown>;
}

export interface QDayFacilitator {
  app: ReturnType<typeof Fastify>;
  relayerAddress: Address | null;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResult>;
  close(): Promise<void>;
}

function atomic(raw: string | undefined): bigint | null {
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return null;
  return BigInt(raw);
}

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/** Builds the chain reader over a real node. Every failure degrades to `null`, never to a silent "all good". */
function defaultReader(
  publicClient: ReturnType<typeof createPublicClient>,
  asset: Address
): ChainReader {
  return {
    async authorizationState(from, nonce) {
      return await publicClient
        .readContract({ address: asset, abi: TUSD8_ABI, functionName: "authorizationState", args: [from, nonce] })
        .catch(() => null);
    },
    async balanceOf(owner) {
      return await publicClient
        .readContract({ address: asset, abi: TUSD8_ABI, functionName: "balanceOf", args: [owner] })
        .catch(() => null);
    },
    async timestamp() {
      const block = await publicClient.getBlock({ blockTag: "latest" });
      return Number(block.timestamp);
    },
  };
}

export function createQDayFacilitator(options: FacilitatorOptions = {}): QDayFacilitator {
  const network = options.network ?? QDAY_TESTNET.caip2;
  const asset = (options.asset ?? QDAY_TESTNET.usdcAddress) as Address;
  const rpcUrl = options.rpcUrl ?? QDAY_TESTNET.rpcUrl;
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));

  const account: PrivateKeyAccount | null = options.relayerKey ? privateKeyToAccount(options.relayerKey) : null;
  const publicClient = createPublicClient({ chain: qdayAevum, transport: http(rpcUrl) });
  const walletClient = account ? createWalletClient({ account, chain: qdayAevum, transport: http(rpcUrl) }) : null;
  const reader = options.reader ?? defaultReader(publicClient, asset);
  const receiver = options.receiverAddress ? getAddress(options.receiverAddress) : null;

  /** Settlement already in flight or landed for this nonce — a retried POST /settle must not double-broadcast. */
  const settled = new Map<string, string>();

  const app = Fastify({ logger: false });

  async function verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<VerifyResult> {
    if (requirements.scheme !== "exact") return { isValid: false, invalidReason: "unsupported_scheme" };
    if (requirements.network !== network) {
      return { isValid: false, invalidReason: `unsupported_network: ${requirements.network}` };
    }
    if (!sameAddress(requirements.asset, asset)) {
      return { isValid: false, invalidReason: "unsupported_asset" };
    }
    if (payload.x402Version !== 2) return { isValid: false, invalidReason: "unsupported_x402_version" };

    const { authorization, signature } = payload.payload ?? ({} as ExactPayload);
    if (!authorization || typeof signature !== "string") {
      return { isValid: false, invalidReason: "malformed_payload" };
    }
    const value = atomic(authorization.value);
    const amount = atomic(requirements.amount);
    if (value === null || amount === null) return { isValid: false, invalidReason: "malformed_amount" };
    if (value === 0n) return { isValid: false, invalidReason: "zero_amount" };
    if (value !== amount) return { isValid: false, invalidReason: "amount_mismatch" };
    try {
      getAddress(authorization.from);
      getAddress(authorization.to);
    } catch {
      return { isValid: false, invalidReason: "malformed_address" };
    }
    if (!sameAddress(authorization.to, requirements.payTo)) {
      return { isValid: false, invalidReason: "payTo_mismatch" };
    }
    if (sameAddress(authorization.from, requirements.payTo)) {
      return { isValid: false, invalidReason: "payer_is_payee" };
    }

    // The token's own EIP-712 domain, not the seller's claims: a seller that quotes a wrong name/version would produce a
    // signature the token rejects at settlement, and the payer would look at fault.
    const domain = {
      name: QDAY_TESTNET.usdcDomainName,
      version: QDAY_TESTNET.usdcDomainVersion,
      chainId: qdayAevum.id,
      verifyingContract: asset,
    };
    if (requirements.extra?.name !== undefined && requirements.extra.name !== domain.name) {
      return { isValid: false, invalidReason: "token_name_mismatch" };
    }
    if (requirements.extra?.version !== undefined && requirements.extra.version !== domain.version) {
      return { isValid: false, invalidReason: "token_version_mismatch" };
    }

    let now: number;
    try {
      now = await reader.timestamp();
    } catch {
      now = clock();
    }
    const validAfter = BigInt(authorization.validAfter);
    const validBefore = BigInt(authorization.validBefore);
    if (validBefore <= BigInt(now)) return { isValid: false, invalidReason: "authorization_expired" };
    if (validAfter > BigInt(now)) return { isValid: false, invalidReason: "authorization_not_yet_valid" };

    const valid = await verifyTypedData({
      address: authorization.from,
      domain,
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value,
        validAfter,
        validBefore,
        nonce: authorization.nonce,
      },
      signature,
    }).catch(() => false);
    if (!valid) return { isValid: false, invalidReason: "invalid_signature" };

    // Replaying a used authorization is the one failure the token can still throw at settlement time; catching it here
    // keeps the seller's 402 body meaningful instead of surfacing an opaque revert.
    const used = await reader.authorizationState(authorization.from, authorization.nonce);
    if (used === true) return { isValid: false, invalidReason: "authorization_already_used" };

    // Balance is advisory: an unreachable RPC must not turn a valid payment into a refusal (SPEC behaviour for buyers is
    // the same). The token is the authority at settlement.
    const balance = await reader.balanceOf(authorization.from);
    if (balance !== null && balance < value) {
      return { isValid: false, invalidReason: "insufficient_funds" };
    }

    return { isValid: true, payer: authorization.from };
  }

  async function settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<SettleResult> {
    const nonceKey = `${payload.payload?.authorization?.from ?? "?"}:${payload.payload?.authorization?.nonce ?? "?"}`;
    const previous = settled.get(nonceKey);
    if (previous) {
      // Idempotent retry: the authorization may only be spent once, so answer with the transaction that already spent it.
      return {
        success: true,
        transaction: previous,
        network,
        payer: payload.payload.authorization.from,
        amount: requirements.amount,
        extra: { replay: true },
      };
    }

    const verdict = await verify(payload, requirements);
    if (!verdict.isValid) {
      return { success: false, transaction: "", network, errorReason: verdict.invalidReason ?? "verify_failed" };
    }
    if (!walletClient || !account) {
      return { success: false, transaction: "", network, errorReason: "relayer_not_configured" };
    }

    const authorization = payload.payload.authorization;
    const signature = parseSignature(payload.payload.signature);
    const value = BigInt(authorization.value);
    // viem's parsed signature keeps v as a bigint; the ABI's uint8 takes a number.
    const v = signature.v === undefined ? (signature.yParity === 1 ? 28 : 27) : Number(signature.v);

    // A quote paid to the receiver contract must be settled THROUGH it, not by a bare token transfer: that is what makes
    // the receipt and the order-id guard atomic with the money movement.
    const toReceiver = receiver !== null && sameAddress(requirements.payTo, receiver);
    // Business idempotency: the seller may pin its own order id in extra.orderId; otherwise the authorization's nonce
    // (unique per signature) is the on-chain key, which at least makes the same authorization unspendable twice.
    const orderId = (() => {
      const supplied = requirements.extra?.orderId;
      if (typeof supplied === "string" && /^0x[0-9a-fA-F]{64}$/.test(supplied)) return supplied as Hex;
      return keccak256(encodePacked(["address", "bytes32"], [authorization.from, authorization.nonce]));
    })();

    try {
      // Two shapes because the ABI differs: pay() through the receiver, or a bare EIP-3009 transfer to the seller.
      const hash = toReceiver && receiver
        ? await walletClient.writeContract({
            address: receiver,
            abi: RECEIVER_ABI,
            functionName: "pay",
            args: [
              orderId,
              authorization.from,
              value,
              BigInt(authorization.validAfter),
              BigInt(authorization.validBefore),
              authorization.nonce,
              v,
              signature.r,
              signature.s,
            ],
            chain: qdayAevum,
            account,
          })
        : await walletClient.writeContract({
            address: asset,
            abi: TUSD8_ABI,
            functionName: "transferWithAuthorization",
            args: [
              authorization.from,
              authorization.to,
              value,
              BigInt(authorization.validAfter),
              BigInt(authorization.validBefore),
              authorization.nonce,
              v,
              signature.r,
              signature.s,
            ],
            chain: qdayAevum,
            account,
          });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        return { success: false, transaction: hash, network, errorReason: "transaction_reverted" };
      }
      settled.set(nonceKey, hash);
      return {
        success: true,
        transaction: hash,
        network,
        payer: authorization.from,
        amount: requirements.amount,
        extra: {
          chainId: qdayAevum.id,
          asset,
          payTo: requirements.payTo,
          ...(toReceiver && receiver ? { receiver, orderId } : {}),
          explorer: `${QDAY_TESTNET.explorerBase}/tx/${hash}`,
          blockNumber: receipt.blockNumber.toString(),
        },
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A gas-starved relayer is an operator problem, not a payer problem: say which one it is.
      return {
        success: false,
        transaction: "",
        network,
        errorReason: /insufficient funds|gas/i.test(message) ? "relayer_out_of_gas" : `settle_failed: ${message.slice(0, 200)}`,
      };
    }
  }

  app.post("/verify", async (req, reply) => {
    const body = req.body as { paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements };
    if (!body?.paymentPayload || !body?.paymentRequirements) {
      return reply.status(400).send({ isValid: false, invalidReason: "malformed_request" });
    }
    try {
      return reply.send(await verify(body.paymentPayload, body.paymentRequirements));
    } catch (e) {
      return reply.status(400).send({ isValid: false, invalidReason: e instanceof Error ? e.message : "verify_error" });
    }
  });

  app.post("/settle", async (req, reply) => {
    const body = req.body as { paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements };
    if (!body?.paymentPayload || !body?.paymentRequirements) {
      return reply
        .status(400)
        .send({ success: false, errorReason: "malformed_request", network, transaction: "" });
    }
    try {
      return reply.send(await settle(body.paymentPayload, body.paymentRequirements));
    } catch (e) {
      return reply
        .status(400)
        .send({ success: false, errorReason: e instanceof Error ? e.message : "settle_error", network, transaction: "" });
    }
  });

  app.get("/supported", async (_req, reply) =>
    reply.send({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network,
          extra: { name: QDAY_TESTNET.usdcDomainName, version: QDAY_TESTNET.usdcDomainVersion },
        },
      ],
      extensions: [],
      // @x402/core's HTTPFacilitatorClient validates this shape strictly; the mock facilitator it normally talks to answers
      // with an empty object here, so keep it empty rather than inventing a key the validator may reject.
      signers: {},
    })
  );

  /** Demo/ops aid: is the relayer able to pay gas at all, and how much tQDAY does it hold? */
  app.get("/health", async (_req, reply) => {
    const relay = account?.address ?? null;
    const gas = relay ? await publicClient.getBalance({ address: relay }).catch(() => null) : null;
    return reply.send({
      ok: true,
      network,
      asset,
      chainId: qdayAevum.id,
      rpcUrl,
      relayer: relay,
      relayerTQDAY: gas === null ? null : gas.toString(),
      receiver,
      settling: Boolean(walletClient),
    });
  });

  return {
    app,
    relayerAddress: account?.address ?? null,
    verify,
    settle,
    close: () => app.close(),
  };
}
