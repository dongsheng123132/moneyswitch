import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import type { PaymentRequirements } from "@x402/core/types";
import type { EvmTypedDataSigner } from "@moneyswitch/wallet";
import type { MoneySwitchDb } from "@moneyswitch/db";
import { callerDeadlineDispatcher } from "@moneyswitch/net";
import type Database from "better-sqlite3";
import {
  MoneySwitchError,
  ApprovalRequiredError,
  evaluateAndReserveInTransaction,
  settlePayment,
  failPayment,
  markUnknown,
  recordPaymentAuthorization,
  formatMicrosToUsdc,
  resolveRequestBody,
  type MoneyKeyRow,
} from "@moneyswitch/core";
import { getActiveNetwork, getEnabledNetworks, SCHEME } from "./networks.js";

export interface PaidFetchInput {
  url: string;
  host: string;
  method: string;
  headers?: Record<string, string>;
  /**
   * Request body. A string is sent verbatim; anything else is sent as JSON
   * (with content-type application/json unless `headers` sets one) — see
   * encodeRequestBody in @moneyswitch/core. An approval's body hash binds to
   * exactly these wire bytes.
   */
  body?: unknown;
  maxPrice?: bigint;
  approvalId?: string | null;
  /** v0.2 (SPEC-v0.2 §2 step 7): tagged onto the reserved payment row. */
  kind?: "fetch" | "chat";
  model?: string | null;
}

/**
 * Whether money left the wallet because of this call.
 *   yes   — a settlement was confirmed (seller/facilitator reported success);
 *   no    — definitely nothing was signed or charged;
 *   maybe — a payment authorization was signed and sent but the outcome is
 *           unknown (it may still settle). Retrying risks paying twice.
 */
export type Charged = "yes" | "no" | "maybe";

/** We signed a payment, then lost the response. The caller must NOT retry automatically. */
export type PaymentUnknownCode = "TIMEOUT_AFTER_PAYMENT" | "UPSTREAM_ERROR_AFTER_PAYMENT";

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
  /**
   * v0.5.2: set when we signed and sent a payment but the seller answered
   * 402 AGAIN (e.g. its facilitator's /verify rejected it — insufficient
   * funds, bad signature, etc), or its PAYMENT-RESPONSE said success:false
   * (it could not confirm the settlement — see SETTLE_NOT_CONFIRMED below;
   * any transaction hash it reported is kept on the row). The reservation is
   * kept `unknown` (see markUnknown(..., "PAYMENT_REJECTED") below), not
   * failed/released: the signed EIP-3009 authorization stays valid until
   * validBefore and could still be settled by the seller later; reconcile.ts
   * releases it after expiry if it was never used on-chain. `charged` is
   * "maybe" in both cases.
   */
  paymentRejected: { reason: string | null } | null;
  /** Whether this call cost money; see Charged. */
  charged: Charged;
  /**
   * Set when a payment was signed and the paid request then timed out or
   * failed, so we have NO response from the seller (httpStatus/headers/body are
   * empty and `payment.txHash` is null). The payments row is `unknown` with
   * error_code = code and its budget stays reserved until reconcile resolves it
   * on-chain.
   */
  paymentUnknown: { code: PaymentUnknownCode; detail: string } | null;
  /**
   * Set when settlement was confirmed from the response headers (the payments
   * row is `settled` with its tx hash, `payment` is populated) but reading the
   * response body then failed or timed out. The money is spent; the content
   * is lost. Callers report UPSTREAM_BODY_INCOMPLETE.
   */
  bodyIncomplete: { detail: string } | null;
}

const REJECTION_REASON_MAX_LEN = 300;

/**
 * Best-effort extraction of the seller's stated rejection reason from a 402
 * response. Untrusted, seller-controlled text — never used for any logic
 * decision, only surfaced to the caller for debugging. Strips control chars
 * and truncates defensively before it ever reaches a log or HTTP response.
 */
function extractRejectionReason(parsedBody: unknown, rawBody: string): string | null {
  let candidate: unknown;
  if (parsedBody && typeof parsedBody === "object" && "error" in (parsedBody as Record<string, unknown>)) {
    candidate = (parsedBody as Record<string, unknown>).error;
  } else if (typeof rawBody === "string" && rawBody.length > 0) {
    try {
      const asJson = JSON.parse(rawBody);
      if (asJson && typeof asJson === "object" && "error" in asJson) {
        candidate = (asJson as Record<string, unknown>).error;
      }
    } catch {
      // not JSON; nothing to extract.
    }
  }
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  // eslint-disable-next-line no-control-regex
  const stripped = candidate.replace(/[\x00-\x1F\x7F]/g, "");
  return stripped.length > REJECTION_REASON_MAX_LEN ? stripped.slice(0, REJECTION_REASON_MAX_LEN) : stripped;
}

/** Short, control-char-free description of a transport error, for the human-readable reason only (never parsed). */
function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // eslint-disable-next-line no-control-regex
  const stripped = msg.replace(/[\x00-\x1F\x7F]/g, " ").trim();
  return stripped.length > 200 ? stripped.slice(0, 200) : stripped;
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

/** Probe phase: from the call start until a payment authorization is signed. */
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
/**
 * Paid phase: from the moment a payment is signed until the response BODY has
 * been fully read. Much longer than the probe phase on purpose: once we have
 * signed, the seller may legitimately take minutes (a slow LLM), and giving up
 * early does not stop it from settling — it only makes us lose the answer we
 * paid for (and, worse, look retryable).
 */
export const DEFAULT_PAID_TIMEOUT_MS = 300_000;
/** setTimeout's ceiling; larger values fire immediately, which would silently abort every request. */
const MAX_TIMER_MS = 2_147_483_647;

/** A positive finite number of ms within the timer range, else the fallback. Never returns 0/NaN/Infinity — a timeout must not be disable-able. */
export function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 1 || n > MAX_TIMER_MS) return fallback;
  return Math.floor(n);
}

/** Reads MONEYSWITCH_PROBE_TIMEOUT_MS / MONEYSWITCH_PAID_TIMEOUT_MS (per call, so tests and operators can change them). */
export function resolvePaidFetchTimeouts(env: NodeJS.ProcessEnv = process.env): { probeMs: number; paidMs: number } {
  return {
    probeMs: parseTimeoutMs(env.MONEYSWITCH_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS),
    paidMs: parseTimeoutMs(env.MONEYSWITCH_PAID_TIMEOUT_MS, DEFAULT_PAID_TIMEOUT_MS),
  };
}

/**
 * Implements SPEC §6 steps 3-6: builds a fresh x402Client per request,
 * filters payment requirements to our configured scheme/network/asset,
 * gates the payment through the policy engine (single SQLite transaction,
 * signed before payment) via onBeforePaymentCreation, sends the request,
 * and reconciles the reservation to settled/failed/unknown afterwards using
 * the SDK's own header decoder (x402HTTPClient) — no hand-rolled 402/EIP-712
 * parsing.
 *
 * Deadlines are two-phase (see DEFAULT_PROBE_TIMEOUT_MS / DEFAULT_PAID_TIMEOUT_MS):
 * one AbortController covers the unpaid probe and the paid retry, but its timer
 * is re-armed with the paid deadline the moment a payment is signed, and stays
 * armed until the response body is fully read.
 *
 * Once a payment is signed this function never throws for transport problems:
 * it returns a result (`paymentUnknown`, `bodyIncomplete`) that carries the
 * payment facts, so callers cannot accidentally report a retryable error for a
 * call that may already have cost money.
 */
export async function performPaidFetch(
  db: MoneySwitchDb,
  sqlite: Database.Database,
  key: MoneyKeyRow,
  signer: EvmTypedDataSigner,
  input: PaidFetchInput
): Promise<PaidFetchResult> {
  const networks = getEnabledNetworks();
  let network = getActiveNetwork();
  const { probeMs, paidMs } = resolvePaidFetchTimeouts();
  let paymentId: string | null = null;
  let approvalIdUsed: string | null = null;
  let reservedAmount: bigint | null = null;

  // Trusted-only abort signal set by OUR hook below. Never derived from
  // parsing an error/response message string (those can be forged by
  // anything upstream — the seller, the facilitator, or a redirect target).
  let ownAbortCode: OwnAbortCode | null = null;
  // v0.4: limit scope/prefix of our own policy denial (SPEC-v0.4 §A), carried
  // alongside the code so the route can report limit_scope/limit_key_prefix.
  let ownAbortLimit: MoneySwitchError["limit"] = undefined;
  let ownAbortApprovalId: string | null = null;

  // --- two-phase deadline -------------------------------------------------
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Set only by OUR timer firing (trusted, like ownAbortCode): distinguishes a
  // deadline abort (TIMEOUT_AFTER_PAYMENT) from any other transport error.
  let timedOut = false;
  // True once the payment authorization is signed and about to be sent — the
  // point of no return after which a lost response means "maybe charged".
  let signed = false;
  // True when the probe deadline expired before the payment could be sent (see
  // the two hooks below). Nothing was sent, so this is an ordinary upstream
  // timeout with charged "no" — never "payment_unknown".
  let deadlineBeforeSend = false;
  const armTimer = (ms: number) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  const disarmTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  // Set from the response headers, BEFORE the body is read (see below).
  let settledPayment: NonNullable<PaidFetchResult["payment"]> | null = null;
  // The seller's PAYMENT-RESPONSE said success:false: it could not (or could not yet) confirm the settlement.
  let settleUnconfirmed: { reason: string | null } | null = null;

  // The wallet refused to sign because it was replaced or locked after this request took its signer (WALLET_CHANGED).
  // Nothing was signed, so the reservation must be RELEASED (failed), never held as `unknown` like a transport error.
  let signerRefused = false;
  const guardedSigner: EvmTypedDataSigner = {
    address: signer.address,
    async signTypedData(msg) {
      try {
        return await signer.signTypedData(msg);
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code === "WALLET_CHANGED") signerRefused = true;
        throw e;
      }
    },
  };

  const client = new x402Client();
  for (const enabled of networks) {
    client.register(enabled.caip2 as `${string}:${string}`, new ExactEvmScheme(guardedSigner as any));
  }
  client.registerPolicy((_version, reqs) =>
      reqs.filter(
        (r: PaymentRequirements) =>
          r.scheme === SCHEME &&
          networks.some((n) => r.network === n.caip2 && r.asset.toLowerCase() === n.usdcAddress.toLowerCase())
      )
    )
    .onBeforePaymentCreation(async (ctx) => {
      network = networks.find((n) => n.caip2 === ctx.selectedRequirements.network)!;
      // The probe deadline may already have expired: @x402/fetch swallows an
      // aborted read of the 402 body and carries on with the PAYMENT-REQUIRED
      // header, so we can get here after the controller was aborted. Reserve
      // nothing and sign nothing — the paid request could not be sent anyway
      // (its signal is already aborted).
      if (timedOut || controller.signal.aborted) {
        deadlineBeforeSend = true;
        return { abort: true, reason: "PROBE_DEADLINE_EXPIRED" };
      }
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
          ownAbortLimit = e.limit;
          return { abort: true, reason: e.code };
        }
        ownAbortCode = "PAYMENT_FAILED";
        return { abort: true, reason: "PAYMENT_FAILED" };
      }
    })
    // v0.5 (unknown-payment reconciliation): captures the signed EIP-3009
    // authorization's (from, nonce, validBefore) on the just-reserved payments
    // row, before the request is even sent. If the seller never sends back a
    // settle header (e.g. its own upstream 500s), the row stays `unknown`
    // with these fields set, and reconcileUnknownPayments can later ask the
    // USDC contract on-chain whether that authorization was ever used.
    // Non-EIP-3009 payloads (e.g. a future permit2 fallback) have no
    // `authorization` field and are silently left uncaptured — nothing to
    // reconcile them against on-chain via authorizationState() anyway.
    //
    // This hook is also the "payment signed" point of the two-phase deadline:
    // when it completes the payload is handed back to the SDK and sent, so from
    // here on a lost response means the payment MAY have settled.
    .onAfterPaymentCreation(async (context) => {
      // The probe deadline fired while we were reserving / signing. fetch() with
      // an already-aborted signal rejects without sending a byte, so this
      // signature never leaves the process: release the reservation instead of
      // reporting a possibly-paid call. (Checked and acted on synchronously —
      // no await between this check and `signed = true` below — so the timer
      // cannot slip in between.)
      if (timedOut || controller.signal.aborted) {
        deadlineBeforeSend = true;
        if (paymentId) {
          try {
            failPayment(db, paymentId, "ABORTED_BEFORE_SEND");
          } catch {
            // Best effort: the row is at worst still `reserved` (also counted, never reconciled).
          }
        }
        return;
      }
      if (paymentId) {
        const payload = context.paymentPayload?.payload as
          | { authorization?: { from?: unknown; nonce?: unknown; validBefore?: unknown } }
          | undefined;
        const authorization = payload?.authorization;
        if (
          authorization &&
          typeof authorization.from === "string" &&
          typeof authorization.nonce === "string" &&
          (typeof authorization.validBefore === "string" || typeof authorization.validBefore === "number")
        ) {
          const validBefore = Number(authorization.validBefore);
          if (Number.isFinite(validBefore)) {
            recordPaymentAuthorization(db, paymentId, {
              from: authorization.from,
              nonce: authorization.nonce,
              validBefore,
            });
          }
        }
      }
      signed = true;
      armTimer(paidMs);
    });

  // SDK spend-control ceiling must be >= our own per_request_limit; our
  // policy engine is authoritative and runs first via onBeforePaymentCreation
  // — this is a non-conflicting outer guard, never set below our own limit.
  // The testnet USDC asset is not in the SDK's default-asset table (SPEC §1),
  // so it must be explicitly allow-listed with its own atomic cap.
  const dollarCeiling = "$" + formatMicrosToUsdc(key.perRequestLimit > 0n ? key.perRequestLimit : 1_000_000n);
  client.setSpendControls({
    maxAmountPerPayment: dollarCeiling,
    allowedAssets: networks.map((n) => (
      {
        network: n.caip2 as `${string}:${string}`,
        asset: n.usdcAddress,
        maxAmountPerPayment: key.perRequestLimit.toString(),
      }
    )),
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
  //
  // Two more things happen here, both about OUR deadline actually governing the
  // request:
  //  - `signal` is passed straight to the inner fetch. @x402/fetch only carries
  //    it via new Request(input, init) + two request.clone()s, and undici links
  //    such dependent signals through WeakRefs: once the outer Request is
  //    unreachable (it is, after the probe) a major GC severs the chain and
  //    controller.abort() silently stops reaching the in-flight paid request or
  //    its body read. An `init.signal` replaces the Request's own signal, so
  //    this does not depend on that chain.
  //  - undici's own headersTimeout / bodyTimeout (300 s each by default) must not
  //    sit underneath our deadline: with MONEYSWITCH_PAID_TIMEOUT_MS above 300 s
  //    they would fire first, and a lost answer would be misreported. The
  //    dispatcher forwards to the process's global dispatcher (so an outbound
  //    proxy still applies) with both idle timers off; OUR timer is the deadline.
  const noRedirectFetch: typeof fetch = (fetchInput, init) => {
    if (deadlineBeforeSend) {
      // Defense in depth: the reservation was released because the probe deadline
      // expired; nothing may be sent on its behalf.
      return Promise.reject(new DOMException("payment released before send", "AbortError"));
    }
    return fetch(fetchInput, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
      dispatcher: callerDeadlineDispatcher(),
    } as RequestInit);
  };
  const fetchWithPay = wrapFetchWithPayment(noRedirectFetch, httpClient);

  const request = resolveRequestBody(input.body, input.headers);

  const amountString = () => (reservedAmount != null ? formatMicrosToUsdc(reservedAmount) : "0");

  /**
   * A transport failure (fetch rejected, deadline abort, body read failed)
   * AFTER the payment was signed. Never throws for the transport problem; the
   * facts go into the result so no caller can mistake it for a retryable error.
   */
  const afterSignFailure = (e: unknown, response: Response | null): PaidFetchResult => {
    const detail = timedOut
      ? `no complete response within ${paidMs}ms of the payment being signed`
      : describeError(e);
    // (A PAYMENT-RESPONSE with success:false is NOT "nothing was charged": the signed
    // authorization stays valid and the transfer may still mine. That row was already
    // marked `unknown` from the headers; it falls through to payment_unknown below.)
    // Settlement already confirmed from the response headers: the payment IS
    // settled (row + tx hash already stored); only the content is lost.
    if (settledPayment) {
      return {
        httpStatus: response?.status ?? 0,
        headers: response ? allowlistedHeaders(response) : {},
        body: "",
        payment: settledPayment,
        approvalId: approvalIdUsed,
        paymentId,
        paymentRejected: null,
        charged: "yes",
        paymentUnknown: null,
        bodyIncomplete: { detail },
      };
    }
    const code: PaymentUnknownCode = timedOut ? "TIMEOUT_AFTER_PAYMENT" : "UPSTREAM_ERROR_AFTER_PAYMENT";
    if (paymentId) {
      try {
        // Keep the budget reserved: `unknown` still counts against the key's
        // limits, and reconcile (core/reconcile.ts) resolves it on-chain once
        // the authorization has expired.
        markUnknown(db, paymentId, code);
      } catch {
        // Best effort: the row is at worst still `reserved` (also counted); the
        // caller must still be told the payment is unknown.
      }
    }
    return {
      httpStatus: 0,
      headers: {},
      body: "",
      payment: { amount: amountString(), txHash: null, network: network.caip2 },
      approvalId: approvalIdUsed,
      paymentId,
      paymentRejected: null,
      charged: "maybe",
      paymentUnknown: { code, detail },
      bodyIncomplete: null,
    };
  };

  try {
    armTimer(probeMs);

    let response: Response;
    try {
      response = await fetchWithPay(input.url, {
        method: input.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
    } catch (e) {
      // deadlineBeforeSend: the row (if any) was already released as failed by the
      // after-creation hook; do not turn it back into a held `unknown` one.
      if (!signed && paymentId && !deadlineBeforeSend) {
        if (signerRefused) {
          // The signer refused before producing a signature: no authorization exists, no money can move. Release the budget.
          failPayment(db, paymentId, "WALLET_CHANGED");
        } else {
          markUnknown(db, paymentId, "UPSTREAM_ERROR");
        }
      }
      if (ownAbortApprovalId) {
        throw new ApprovalRequiredError(ownAbortApprovalId);
      }
      if (ownAbortCode) {
        throw new MoneySwitchError(ownAbortCode, undefined, ownAbortLimit);
      }
      if (signerRefused) {
        throw new MoneySwitchError("WALLET_LOCKED", "The wallet was replaced or locked while this request was in progress; nothing was signed and nothing was charged");
      }
      if (signed) {
        return afterSignFailure(e, null);
      }
      if (deadlineBeforeSend) {
        // Our own probe deadline: nothing was sent, nothing is charged.
        throw new MoneySwitchError("UPSTREAM_ERROR", `upstream did not answer within ${probeMs}ms (no payment was sent)`);
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
      if (timedOut) {
        throw new MoneySwitchError(
          "UPSTREAM_ERROR",
          `upstream did not answer within ${probeMs}ms (no payment had been signed)`
        );
      }
      throw new MoneySwitchError("UPSTREAM_ERROR", msg);
    }

    // Defense in depth: with redirect:"manual" this must always hold (fetch
    // never navigates away from the requested URL). Fail loudly rather than
    // silently returning a response for a different host than the one that
    // was authorized/paid-for, in case of a future regression. After a
    // payment this is treated like any other lost response (payment_unknown):
    // a response from another host's settle header must not be trusted.
    let hostMismatch: MoneySwitchError | null = null;
    try {
      const requestedHost = new URL(input.url).host;
      const respHost = response.url ? new URL(response.url).host : requestedHost;
      if (respHost !== requestedHost) {
        hostMismatch = new MoneySwitchError(
          "UPSTREAM_ERROR",
          `response host ${respHost} does not match requested host ${requestedHost}`
        );
      }
    } catch {
      // response.url parsing failures are not security-relevant; ignore.
    }
    if (hostMismatch) {
      if (signed) return afterSignFailure(hostMismatch, null);
      throw hostMismatch;
    }

    const getHeader = (name: string) => response.headers.get(name);

    // v0.5.3: record settlement from the response HEADERS, before the body is
    // read. The body can be slow, huge or cut off; the payment must be settled
    // (with its tx hash) regardless — otherwise a body-read failure after a
    // confirmed settlement would leave the row `reserved`/`unknown` and the
    // caller would see a retryable error for money that is already spent.
    // Decoded with the SDK's own decoder, never hand-parsed.
    type SettleHeader = {
      success: boolean;
      transaction: string;
      errorReason?: string;
      extra?: Record<string, unknown>;
    };
    let settleHeader: SettleHeader | null = null;
    try {
      const decoded = httpClient.getPaymentSettleResponse(getHeader) as unknown;
      if (decoded && typeof decoded === "object" && "success" in decoded) {
        settleHeader = decoded as SettleHeader;
      }
    } catch {
      // no (or undecodable) PAYMENT-RESPONSE header
    }
    if (paymentId && reservedAmount != null && settleHeader) {
      if (settleHeader.success) {
        settlePayment(db, paymentId, settleHeader.transaction);
        settledPayment = {
          amount: formatMicrosToUsdc(reservedAmount),
          txHash: settleHeader.transaction,
          network: network.caip2,
          mock: Boolean(settleHeader.extra?.mock),
        };
      } else {
        // success:false is NOT proof that nothing was charged. We signed and SENT
        // an EIP-3009 authorization that stays valid until validBefore, and the
        // seller's server turns ANY exception while settling (a facilitator
        // timeout, a receipt wait that ran out) into this header — @x402/evm even
        // answers errorReason "settlement_pending" with the hash of a transfer it
        // already broadcast. So do not release the budget: keep it reserved
        // (`unknown`), remember the reported hash as a lead, and let reconcile
        // decide from the chain (authorizationState) once the authorization
        // expires. Same treatment as a seller that answers 402 again.
        const reportedTx =
          typeof settleHeader.transaction === "string" && settleHeader.transaction.length > 0
            ? settleHeader.transaction
            : null;
        markUnknown(db, paymentId, "SETTLE_NOT_CONFIRMED", { txHash: reportedTx });
        settleUnconfirmed = { reason: extractRejectionReason({ error: settleHeader.errorReason }, "") };
      }
    }

    // Body read: still under the (paid-phase, if signed) deadline timer.
    let parsedBody: unknown;
    let rawBody: string;
    try {
      const text = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          parsedBody = JSON.parse(text);
        } catch {
          parsedBody = text; // invalid JSON despite the content-type: hand it back as text rather than failing.
        }
      } else {
        parsedBody = text;
      }
      rawBody = typeof parsedBody === "string" ? parsedBody : JSON.stringify(parsedBody);
    } catch (e) {
      if (signed) return afterSignFailure(e, response);
      throw new MoneySwitchError("UPSTREAM_ERROR", describeError(e));
    }
    const body =
      rawBody.length > RESPONSE_BODY_LIMIT_BYTES ? rawBody.slice(0, RESPONSE_BODY_LIMIT_BYTES) : rawBody;

    const headers = allowlistedHeaders(response);

    let paymentRejected: PaidFetchResult["paymentRejected"] = null;
    let charged: Charged = "no";
    if (paymentId && reservedAmount != null) {
      if (settledPayment) {
        charged = "yes";
      } else if (settleUnconfirmed) {
        // PAYMENT-RESPONSE said success:false (row already kept `unknown` above): the
        // signed authorization is still live, so this is "maybe", not "no". Reported
        // exactly like a seller that answered 402 again.
        paymentRejected = { reason: settleUnconfirmed.reason };
        charged = "maybe";
      } else if (response.status === 402) {
        // We already signed and sent an EIP-3009 payment for this request (paymentId
        // is set), yet the seller answered 402 again — its facilitator rejected our
        // payment (e.g. insufficient_funds), or it otherwise declined to honor it.
        // Do NOT release/fail the reservation: the signed authorization stays valid
        // until validBefore and the seller could still settle it later; the on-chain
        // reconcile loop (packages/core/src/reconcile.ts) releases it after expiry
        // if it was never used.
        const parsed = httpClient.parsePaymentResult({ status: response.status, getHeader, body: parsedBody });
        let rejectionReason: string | null = null;
        if (
          parsed.header &&
          !("success" in parsed.header) &&
          typeof (parsed.header as { error?: unknown }).error === "string"
        ) {
          rejectionReason = extractRejectionReason(parsed.header, "");
        }
        if (rejectionReason == null) {
          rejectionReason = extractRejectionReason(parsedBody, rawBody);
        }
        markUnknown(db, paymentId, "PAYMENT_REJECTED");
        paymentRejected = { reason: rejectionReason };
        charged = "maybe";
      } else {
        // No settlement info at all (transport-level oddity after payment was
        // reserved): keep the reservation, mark unknown per SPEC §6 step 6.
        markUnknown(db, paymentId, "NO_SETTLE_HEADER");
        charged = "maybe";
      }
    }

    return {
      httpStatus: response.status,
      headers,
      body,
      payment: settledPayment,
      approvalId: approvalIdUsed,
      paymentId,
      paymentRejected,
      charged,
      paymentUnknown: null,
      bodyIncomplete: null,
    };
  } catch (e) {
    // Anything unexpected AFTER the signature (e.g. a DB write failing while
    // recording the outcome) must still be reported as an unknown payment, never
    // as a plain, retryable error. Our own typed errors pass through untouched.
    if (signed && !(e instanceof MoneySwitchError) && !(e instanceof ApprovalRequiredError)) {
      return afterSignFailure(e, null);
    }
    throw e;
  } finally {
    disarmTimer();
  }
}

/** "location" is included (not followed) so a 3xx response's target is visible to the caller, who must re-invoke /v1/fetch with it explicitly. */
const HEADER_ALLOWLIST = ["content-type", "content-length", "location"];

function allowlistedHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of response.headers.entries()) {
    if (HEADER_ALLOWLIST.includes(k.toLowerCase())) headers[k] = v;
  }
  return headers;
}
