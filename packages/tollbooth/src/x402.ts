import {
  x402ResourceServer,
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  FacilitatorResponseError,
  getFacilitatorResponseError,
  withPrivateCacheControl,
} from "@x402/core/server";
import type { HTTPRequestContext, RouteConfig, HTTPAdapter } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { formatUsdc, parseUsdc } from "./money.js";

/**
 * SPEC-v0.5 §2 step 2/4/5 — the x402 side of a toll booth, built only from
 * the official SDK (@x402/core/server + @x402/evm), exactly like
 * apps/demo-seller: x402ResourceServer + HTTPFacilitatorClient +
 * ExactEvmScheme with a registerMoneyParser for testnet USDC. The 402
 * response, the PAYMENT-REQUIRED / PAYMENT-RESPONSE headers, verification and
 * settlement are all produced by the SDK; nothing here builds them by hand.
 */

export interface UsdcNetwork {
  /** CAIP-2 id, e.g. "eip155:10143". */
  caip2: string;
  usdcAddress: string;
  usdcDomainName: string;
  usdcDomainVersion: string;
  /** Human label for 402 bodies / CLI output. */
  label?: string;
}

/**
 * Monad testnet facts, env-overridable with the same variable names as
 * packages/x402/src/networks.ts (a server unit test asserts both stay equal).
 * Used by `moneyswitch sell`, which cannot depend on the AGPL server packages.
 */
export function monadTestnet(env: NodeJS.ProcessEnv = process.env): UsdcNetwork & { facilitatorUrl: string } {
  return {
    caip2: env.MONEYSWITCH_TESTNET_CAIP2 ?? "eip155:10143",
    usdcAddress: env.MONEYSWITCH_TESTNET_USDC_ADDRESS ?? "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    usdcDomainName: env.MONEYSWITCH_TESTNET_USDC_NAME ?? "USDC",
    usdcDomainVersion: env.MONEYSWITCH_TESTNET_USDC_VERSION ?? "2",
    facilitatorUrl: env.MONEYSWITCH_FACILITATOR_URL ?? "https://x402-facilitator.molandak.org",
    label: "Monad testnet",
  };
}

export interface TollResourceServer {
  resourceServer: x402ResourceServer;
  network: UsdcNetwork;
  /** Fetches the facilitator's /supported once (retried after a failure). */
  ensureInitialized(): Promise<void>;
}

export function createTollResourceServer(opts: { facilitatorUrl: string; network: UsdcNetwork }): TollResourceServer {
  const scheme = new ExactEvmScheme();
  // Testnet USDC is not in the SDK's default asset table — same parser as
  // apps/demo-seller (decimal "0.01" → atomic amount + asset + EIP-712 domain).
  scheme.registerMoneyParser(async (amount) => ({
    amount: parseUsdc(String(amount)).toString(),
    asset: opts.network.usdcAddress,
    extra: { name: opts.network.usdcDomainName, version: opts.network.usdcDomainVersion },
  }));
  const facilitator = new HTTPFacilitatorClient({ url: opts.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register(opts.network.caip2 as `${string}:${string}`, scheme);
  let init: Promise<void> | null = null;
  return {
    resourceServer,
    network: opts.network,
    ensureInitialized() {
      if (!init) {
        init = resourceServer.initialize().catch((e) => {
          init = null;
          throw e;
        });
      }
      return init;
    },
  };
}

export interface TollOffer {
  /** Display name of the toll booth. */
  name: string;
  payTo: string;
  /** micro-USDC, > 0. */
  price: bigint;
  network: UsdcNetwork;
  /** Human description of what is being bought (route description or a default). */
  description: string;
  /** Public URL of the resource being bought. */
  resourceUrl?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Friendly JSON body for an unpaid call (the protocol data itself is in the SDK's PAYMENT-REQUIRED header). */
export function unpaidBody(offer: TollOffer): Record<string, unknown> {
  const price = formatUsdc(offer.price);
  return {
    error: "payment_required",
    message: `This API costs ${price} USDC per call (x402). Pay with an x402 client — e.g. a MoneySwitch MoneyKey via /v1/fetch — and retry.`,
    toll_booth: offer.name,
    price_usdc: price,
    pay_to: offer.payTo,
    network: offer.network.caip2,
    asset: offer.network.usdcAddress,
    description: offer.description,
    settlement: "You are only charged if the service answers with 2xx/3xx. Errors are never charged.",
  };
}

/** Minimal static paywall page for humans opening the URL in a browser (all dynamic text escaped). */
export function paywallHtml(offer: TollOffer): string {
  const price = escapeHtml(formatUsdc(offer.price));
  const name = escapeHtml(offer.name);
  const payTo = escapeHtml(offer.payTo);
  const desc = escapeHtml(offer.description);
  const net = escapeHtml(offer.network.label ?? offer.network.caip2);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} · 402 Payment Required</title>
<style>body{font:15px/1.6 system-ui,sans-serif;background:#0f1115;color:#e6e8ee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:560px;padding:32px;border:1px solid #2a2f3a;border-radius:14px;background:#161a22}h1{font-size:20px;margin:0 0 8px}.price{font-size:28px;font-weight:700}.addr{font-family:ui-monospace,monospace;word-break:break-all;color:#4ade80;background:#0f2a1a;border:1px solid #1f5130;border-radius:8px;padding:8px 10px}.muted{color:#9aa3b2;font-size:13px}</style></head>
<body><main><h1>${name}</h1><p class="muted">${desc}</p><p class="price">${price} USDC <span class="muted">/ call · ${net}</span></p>
<p>This is a paid API for AI agents (x402). An agent with a wallet pays per call; the money goes to this public receiving address:</p><p class="addr">${payTo}</p>
<p>这是一个按次收费的 API（x402），给 AI 用：AI 每次调用付 ${price} USDC，钱直接进上面这个公开的收款地址。只有服务正常返回（2xx/3xx）才会扣款。</p>
<p class="muted">Powered by MoneySwitch toll booth · You are only charged when the service answers successfully.</p></main></body></html>`;
}

export function buildRouteConfig(offer: TollOffer): RouteConfig {
  return {
    accepts: {
      scheme: "exact",
      payTo: offer.payTo,
      price: formatUsdc(offer.price),
      network: offer.network.caip2 as `${string}:${string}`,
    },
    description: offer.description,
    ...(offer.resourceUrl ? { resource: offer.resourceUrl } : {}),
    mimeType: "application/json",
    unpaidResponseBody: async () => ({ contentType: "application/json", body: unpaidBody(offer) }),
    customPaywallHtml: paywallHtml(offer),
  };
}

/** Informational payer address from an x402 payment header (EIP-3009 `authorization.from`), via the SDK's own decoder. */
export function payerFromPaymentHeader(header: string | undefined | null): string | null {
  if (!header) return null;
  try {
    const payload = decodePaymentSignatureHeader(header) as { payload?: { authorization?: { from?: string } } };
    const from = payload?.payload?.authorization?.from;
    return typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from) ? from : null;
  } catch {
    return null;
  }
}

/**
 * Rejects the same payment header while it is being served (and for a while
 * after it settled), so one signature cannot make the upstream do the work
 * twice before the facilitator notices the reused nonce.
 */
export class ReplayGuard {
  private inflight = new Set<string>();
  private done = new Map<string, number>();
  constructor(private ttlMs = 15 * 60_000) {}
  begin(header: string): boolean {
    const now = Date.now();
    for (const [k, t] of this.done) if (now - t > this.ttlMs) this.done.delete(k);
    if (this.inflight.has(header) || this.done.has(header)) return false;
    this.inflight.add(header);
    return true;
  }
  end(header: string, settled: boolean): void {
    this.inflight.delete(header);
    if (settled) this.done.set(header, Date.now());
  }
}

export interface HandlerResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export type PaidFlowOutcome =
  /** No/invalid payment: SDK 402 (or other SDK payment error). Upstream not called. */
  | "payment_required"
  /** Upstream answered 2xx/3xx and the facilitator settled. */
  | "settled"
  /** Upstream answered 4xx/5xx → verified payment cancelled, never settled. */
  | "upstream_failed"
  /** Upstream threw (timeout / unreachable / too large) → never settled. */
  | "upstream_error"
  /** Upstream succeeded but the facilitator refused to settle → buyer gets the SDK's failure response, not the content. */
  | "settle_failed"
  /** Facilitator unreachable / erroring. */
  | "facilitator_error";

export interface PaidFlowResult {
  outcome: PaidFlowOutcome;
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
  upstreamStatus?: number;
  transaction?: string;
  payer?: string | null;
  amount?: string;
  network?: string;
  errorReason?: string;
}

function toBody(body: unknown, isHtml?: boolean): Buffer | string {
  if (isHtml) return String(body ?? "");
  if (Buffer.isBuffer(body)) return body;
  return JSON.stringify(body ?? {});
}

/**
 * Framework-agnostic version of what @x402/express's paymentMiddleware does,
 * for the Fastify server: processHTTPRequest → (verified) run the handler →
 * status >= 400: cancel, never settle → otherwise processSettlement and attach
 * the SDK's settlement headers. Every protocol artifact comes from the SDK.
 */
export async function runPaidRequest(opts: {
  toll: TollResourceServer;
  route: RouteConfig;
  adapter: HTTPAdapter;
  path: string;
  method: string;
  handler: () => Promise<HandlerResult>;
}): Promise<PaidFlowResult> {
  const httpServer = new x402HTTPResourceServer(opts.toll.resourceServer, opts.route);
  const paymentHeader = opts.adapter.getHeader("payment-signature") || opts.adapter.getHeader("x-payment");
  const context: HTTPRequestContext = {
    adapter: opts.adapter,
    path: opts.path,
    decodedPath: opts.path,
    method: opts.method,
    paymentHeader,
  };
  const facilitatorFailure = (e: unknown): PaidFlowResult => {
    const fe = getFacilitatorResponseError(e);
    const message = fe?.message ?? (e instanceof Error ? e.message : "facilitator error");
    return {
      outcome: "facilitator_error",
      status: 502,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "FACILITATOR_ERROR", message }),
      errorReason: message,
    };
  };

  try {
    await opts.toll.ensureInitialized();
  } catch (e) {
    return facilitatorFailure(e);
  }

  let result;
  try {
    result = await httpServer.processHTTPRequest(context);
  } catch (e) {
    return facilitatorFailure(e);
  }

  if (result.type === "no-payment-required") {
    // Cannot happen for a single catch-all RouteConfig, but never serve for free by accident.
    return {
      outcome: "payment_required",
      status: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "TOLLBOOTH_MISCONFIGURED" }),
    };
  }
  if (result.type === "payment-error") {
    const r = result.response;
    return {
      outcome: "payment_required",
      status: r.status,
      headers: { ...(r.isHtml ? { "content-type": "text/html; charset=utf-8" } : { "content-type": "application/json" }), ...r.headers },
      body: toBody(r.body, r.isHtml),
    };
  }

  const { cancellationDispatcher, beforeHandlerSettlement, paymentPayload, paymentRequirements, declaredExtensions } = result;
  const payer = payerFromPaymentHeader(paymentHeader);
  const amount = formatUsdc(BigInt(paymentRequirements.amount));
  const network = paymentRequirements.network;

  let upstream: HandlerResult;
  try {
    upstream = await opts.handler();
  } catch (error) {
    const cancel = await cancellationDispatcher.cancel({ reason: "handler_threw", error }).catch(() => undefined);
    const failureHeaders = httpServer.createFailurePathSettlementHeaders(cancel, beforeHandlerSettlement, paymentPayload, null) ?? {};
    const code = (error as { code?: string })?.code ?? "UPSTREAM_ERROR";
    const status = code === "UPSTREAM_TIMEOUT" ? 504 : 502;
    return {
      outcome: "upstream_error",
      status,
      headers: { "content-type": "application/json", ...failureHeaders },
      body: JSON.stringify({ error: code, message: (error as Error)?.message ?? String(error), charged: false }),
      payer,
      amount,
      network,
      errorReason: code,
    };
  }

  if (upstream.status >= 400) {
    // SPEC-v0.5 §2 step 4: only 2xx/3xx are settled. The buyer keeps the money.
    const cancel = await cancellationDispatcher
      .cancel({ reason: "handler_failed", responseStatus: upstream.status })
      .catch(() => undefined);
    const failureHeaders = httpServer.createFailurePathSettlementHeaders(cancel, beforeHandlerSettlement, paymentPayload, null) ?? {};
    return {
      outcome: "upstream_failed",
      status: upstream.status,
      headers: { ...upstream.headers, ...failureHeaders },
      body: upstream.body,
      upstreamStatus: upstream.status,
      payer,
      amount,
      network,
      errorReason: `UPSTREAM_${upstream.status}`,
    };
  }

  let settle;
  try {
    settle = await httpServer.processSettlement(
      paymentPayload,
      paymentRequirements,
      declaredExtensions,
      { request: context, responseBody: upstream.body, responseHeaders: upstream.headers },
      undefined,
      beforeHandlerSettlement
    );
  } catch (e) {
    if (e instanceof FacilitatorResponseError) {
      const f = facilitatorFailure(e);
      return { ...f, upstreamStatus: upstream.status, payer, amount, network };
    }
    return {
      outcome: "settle_failed",
      status: 402,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      upstreamStatus: upstream.status,
      payer,
      amount,
      network,
      errorReason: e instanceof Error ? e.message : "settlement error",
    };
  }
  if (!settle.success) {
    const r = settle.response;
    return {
      outcome: "settle_failed",
      status: r.status,
      headers: { ...(r.isHtml ? { "content-type": "text/html; charset=utf-8" } : { "content-type": "application/json" }), ...r.headers },
      body: toBody(r.body, r.isHtml),
      upstreamStatus: upstream.status,
      payer: settle.payer ?? payer,
      amount,
      network,
      errorReason: settle.errorReason,
    };
  }
  return {
    outcome: "settled",
    status: upstream.status,
    headers: {
      ...upstream.headers,
      ...settle.headers,
      "cache-control": withPrivateCacheControl(upstream.headers["cache-control"] ?? null),
    },
    body: upstream.body,
    upstreamStatus: upstream.status,
    transaction: settle.transaction,
    payer: settle.payer ?? payer,
    amount,
    network: settle.network ?? network,
  };
}

export { parseUsdc, formatUsdc };
