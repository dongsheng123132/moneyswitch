import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import type { PaymentRequirements } from "@x402/core/types";
import type { EvmTypedDataSigner } from "@moneyswitch/wallet";
import type { MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import {
  MoneySwitchError,
  ApprovalRequiredError,
  evaluateAndReserveInTransaction,
  settlePayment,
  failPayment,
  markUnknown,
  formatMicrosToUsdc,
  type MoneyKeyRow,
} from "@moneyswitch/core";
import { getActiveNetwork, SCHEME } from "./networks.js";

export interface PaidFetchInput {
  url: string;
  host: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  maxPrice?: bigint;
  approvalId?: string | null;
  /** v0.2 (SPEC-v0.2 §2 step 7): tagged onto the reserved payment row. */
  kind?: "fetch" | "chat";
  model?: string | null;
}

export interface PaidFetchResult {
  httpStatus: number;
  headers: Record<string, string>;
  body: string;
  payment: {
    amount: string;
    txHash: string | null;
    network: string;
    mock?: boolean;
  } | null;
  approvalId: string | null;
  /** v0.2: id of the payment row this call reserved/settled, or null if no payment was attempted. */
  paymentId: string | null;
}

/** Error codes our own onBeforePaymentCreation hook can abort with (closure-trusted, never parsed from response/error text). */
type OwnAbortCode =
  | "PER_REQUEST_LIMIT_EXCEEDED"
  | "MAX_PRICE_EXCEEDED"
  | "DAILY_BUDGET_EXCEEDED"
  | "TOTAL_BUDGET_EXCEEDED"
  | "APPROVAL_INVALID"
  | "KEY_INVALID"
  | "KEY_REVOKED"
  | "KEY_EXPIRED"
  | "PAYMENT_FAILED";

const RESPONSE_BODY_LIMIT_BYTES = 1024 * 1024; // 1MB
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Implements SPEC §6 steps 3-6: builds a fresh x402Client per request,
 * filters payment requirements to our configured scheme/network/asset,
 * gates the payment through the policy engine (single SQLite transaction,
 * signed before payment) via onBeforePaymentCreation, sends the request,
 * and reconciles the reservation to settled/failed/unknown afterwards using
 * the SDK's own header decoder (x402HTTPClient.processResponse) — no
 * hand-rolled 402/EIP-712 parsing.
 */
export async function performPaidFetch(
  db: MoneySwitchDb,
  sqlite: Database.Database,
  key: MoneyKeyRow,
  signer: EvmTypedDataSigner,
  input: PaidFetchInput
): Promise<PaidFetchResult> {
  const network = getActiveNetwork();
  let paymentId: string | null = null;
  let approvalIdUsed: string | null = null;
  let reservedAmount: bigint | null = null;

  // Trusted-only abort signal set by OUR hook below. Never derived from
  // parsing an error/response message string (those can be forged by
  // anything upstream — the seller, the facilitator, or a redirect target).
  let ownAbortCode: OwnAbortCode | null = null;
  let ownAbortApprovalId: string | null = null;

  const client = new x402Client()
    .register(network.caip2 as `${string}:${string}`, new ExactEvmScheme(signer as any))
    .registerPolicy((_version, reqs) =>
      reqs.filter(
        (r: PaymentRequirements) =>
          r.scheme === SCHEME &&
          r.network === network.caip2 &&
          r.asset.toLowerCase() === network.usdcAddress.toLowerCase()
      )
    )
    .onBeforePaymentCreation(async (ctx) => {
      const amount = BigInt(ctx.selectedRequirements.amount);
      try {
        const result = evaluateAndReserveInTransaction(sqlite, db, key, {
          url: input.url,
          host: input.host,
          method: input.method,
          body: input.body,
          network: ctx.selectedRequirements.network,
          asset: ctx.selectedRequirements.asset,
          payTo: ctx.selectedRequirements.payTo,
          amount,
          maxPrice: input.maxPrice,
          approvalId: input.approvalId,
          kind: input.kind,
          model: input.model,
        });
        paymentId = result.paymentId;
        approvalIdUsed = result.approvalId;
        reservedAmount = amount;
        return undefined;
      } catch (e) {
        if (e instanceof ApprovalRequiredError) {
          ownAbortApprovalId = e.approvalId;
          return { abort: true, reason: `APPROVAL_REQUIRED:${e.approvalId}` };
        }
        if (e instanceof MoneySwitchError) {
          ownAbortCode = e.code as OwnAbortCode;
          return { abort: true, reason: e.code };
        }
        ownAbortCode = "PAYMENT_FAILED";
        return { abort: true, reason: "PAYMENT_FAILED" };
      }
    });

  // SDK spend-control ceiling must be >= our own per_request_limit; our
  // policy engine is authoritative and runs first via onBeforePaymentCreation
  // — this is a non-conflicting outer guard, never set below our own limit.
  // The testnet USDC asset is not in the SDK's default-asset table (SPEC §1),
  // so it must be explicitly allow-listed with its own atomic cap.
  const dollarCeiling = "$" + formatMicrosToUsdc(key.perRequestLimit > 0n ? key.perRequestLimit : 1_000_000n);
  client.setSpendControls({
    maxAmountPerPayment: dollarCeiling,
    allowedAssets: [
      {
        network: network.caip2 as `${string}:${string}`,
        asset: network.usdcAddress,
        maxAmountPerPayment: key.perRequestLimit.toString(),
      },
    ],
  });

  const httpClient = new x402HTTPClient(client);

  // SECURITY: never follow redirects on the outbound (paid) request. If we
  // followed, a compromised/misbehaving allow-listed host could 302 to a
  // host outside allowed_hosts (or to MoneySwitch's own admin API) and both
  // the host allowlist and the SSRF guard — which only ever inspect
  // `input.url` — would be silently bypassed; worse, a 402 served from the
  // redirect target would get paid for a URL the policy engine never saw.
  // `redirect: "manual"` makes fetch return the raw 3xx (status + Location)
  // instead, which we pass straight back to the caller un-followed; the
  // Agent must explicitly call /v1/fetch again with the new URL so it goes
  // through host-allowlist + SSRF + policy checks again.
  const noRedirectFetch: typeof fetch = (fetchInput, init) =>
    fetch(fetchInput, { ...init, redirect: "manual" });
  const fetchWithPay = wrapFetchWithPayment(noRedirectFetch, httpClient);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchWithPay(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    if (paymentId) {
      markUnknown(db, paymentId, "UPSTREAM_ERROR");
    }
    if (ownAbortApprovalId) {
      throw new ApprovalRequiredError(ownAbortApprovalId);
    }
    if (ownAbortCode) {
      throw new MoneySwitchError(ownAbortCode);
    }
    const msg = e instanceof Error ? e.message : String(e);
    // The SDK's own outer spendControls ceiling (set to key.perRequestLimit)
    // can reject a requirement before our onBeforePaymentCreation hook even
    // runs when the price is far above the limit — same outcome as our own
    // PER_REQUEST_LIMIT_EXCEEDED check, just thrown one layer higher by the
    // SDK itself (not attacker-controlled text, so still fine to pattern-match).
    if (/spendControls/i.test(msg) || /maxAmountPerPayment/i.test(msg)) {
      throw new MoneySwitchError("PER_REQUEST_LIMIT_EXCEEDED");
    }
    if (/no.*payment.*requirement/i.test(msg) || /no schemes/i.test(msg)) {
      throw new MoneySwitchError("UNSUPPORTED_PAYMENT");
    }
    throw new MoneySwitchError("UPSTREAM_ERROR", msg);
  }
  clearTimeout(timeout);

  // Defense in depth: with redirect:"manual" this must always hold (fetch
  // never navigates away from the requested URL). Fail loudly rather than
  // silently returning a response for a different host than the one that
  // was authorized/paid-for, in case of a future regression.
  try {
    const requestedHost = new URL(input.url).host;
    const respHost = response.url ? new URL(response.url).host : requestedHost;
    if (respHost !== requestedHost) {
      throw new MoneySwitchError(
        "UPSTREAM_ERROR",
        `response host ${respHost} does not match requested host ${requestedHost}`
      );
    }
  } catch (e) {
    if (e instanceof MoneySwitchError) throw e;
    // response.url parsing failures are not security-relevant; ignore.
  }

  // Use the SDK's own decoder for status + settlement header, never hand-parsed.
  const parsed = await httpClient.processResponse(response.clone());
  let rawBody: string;
  if (typeof parsed.body === "string") {
    rawBody = parsed.body;
  } else if (parsed.body === undefined) {
    rawBody = await response.text().catch(() => "");
  } else {
    rawBody = JSON.stringify(parsed.body);
  }
  const body =
    rawBody.length > RESPONSE_BODY_LIMIT_BYTES ? rawBody.slice(0, RESPONSE_BODY_LIMIT_BYTES) : rawBody;

  const headers: Record<string, string> = {};
  // "location" is included (not followed) so a 3xx response's target is
  // visible to the caller, who must re-invoke /v1/fetch with it explicitly.
  const headerAllowlist = ["content-type", "content-length", "location"];
  for (const [k, v] of response.headers.entries()) {
    if (headerAllowlist.includes(k.toLowerCase())) headers[k] = v;
  }

  let payment: PaidFetchResult["payment"] = null;
  if (paymentId && reservedAmount != null) {
    if (parsed.paymentStatus === "settled" && parsed.header && "success" in parsed.header) {
      const settle = parsed.header as { success: boolean; transaction: string; extra?: Record<string, unknown> };
      if (settle.success) {
        settlePayment(db, paymentId, settle.transaction);
        payment = {
          amount: formatMicrosToUsdc(reservedAmount),
          txHash: settle.transaction,
          network: network.caip2,
          mock: Boolean(settle.extra?.mock),
        };
      } else {
        failPayment(db, paymentId, "PAYMENT_FAILED");
      }
    } else if (parsed.paymentStatus === "settle_failed") {
      failPayment(db, paymentId, "PAYMENT_FAILED");
    } else {
      // No settlement info at all (transport-level oddity after payment was
      // reserved): keep the reservation, mark unknown per SPEC §6 step 6.
      markUnknown(db, paymentId, "NO_SETTLE_HEADER");
    }
  }

  return {
    httpStatus: parsed.status,
    headers,
    body,
    payment,
    approvalId: approvalIdUsed,
    paymentId,
  };
}
