import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyAdminToken, authenticateMoneyKey, touchLastUsed, MoneySwitchError, limitFields } from "@moneyswitch/core";
import type { MoneyKeyRow } from "@moneyswitch/core";
import type { AppContext } from "./context.js";

function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers["authorization"];
  if (!header || Array.isArray(header)) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1] : null;
}

/** Admin routes only accept ms_admin_xxx. A MoneyKey (mk_live_xxx) is always 403. */
export function requireAdmin(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearer(req);
    if (!token || token.startsWith("mk_live_") || !verifyAdminToken(ctx.db, token)) {
      return reply.status(403).send({ error: "FORBIDDEN" });
    }
  };
}

declare module "fastify" {
  interface FastifyRequest {
    moneyKey?: MoneyKeyRow;
  }
}

/** Agent routes only accept mk_live_xxx. */
export function requireMoneyKey(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearer(req);
    if (!token || token.startsWith("ms_admin_")) {
      return reply.status(401).send({ status: "error", code: "KEY_INVALID", charged: "no" });
    }
    // v0.5 (SPEC-v0.5 §1): a public 0x address pasted where a MoneyKey belongs.
    if (/^0x[0-9a-fA-F]{40}$/.test(token)) {
      return reply.status(401).send({
        status: "error",
        code: "KEY_INVALID",
        charged: "no",
        hint: "LOOKS_LIKE_ADDRESS",
        message: "That is a public 0x receiving address, not a MoneyKey. A MoneyKey starts with mk_live_.",
      });
    }
    try {
      const key = authenticateMoneyKey(ctx.db, token);
      touchLastUsed(ctx.db, key.id);
      req.moneyKey = key;
    } catch (e) {
      const code = e instanceof MoneySwitchError ? e.code : "KEY_INVALID";
      // v0.4: a key whose ancestor is revoked/expired fails here with
      // limit_scope "ancestor" (SPEC-v0.4 §A cascade).
      // Auth runs before anything is signed, so every /v1/fetch envelope that
      // comes from this guard is `charged: "no"` (CONTRACT: charged on every envelope).
      return reply.status(401).send({ status: "error", code, charged: "no", ...limitFields(e) });
    }
  };
}

/** HTTP status for a gateway (OpenAI-compatible) policy/auth failure code, per SPEC-v0.2 §2 step 6. */
export function openAiStatusForCode(code: string): number {
  switch (code) {
    case "KEY_INVALID":
      return 401;
    case "KEY_REVOKED":
    case "KEY_EXPIRED":
    case "model_not_allowed":
      return 403;
    case "RATE_LIMITED":
      return 429;
    case "PER_REQUEST_LIMIT_EXCEEDED":
    case "MAX_PRICE_EXCEEDED":
    case "DAILY_BUDGET_EXCEEDED":
    case "TOTAL_BUDGET_EXCEEDED":
      return 402;
    // We signed a payment and the call may (or did) cost money: PAYMENT_REJECTED
    // (seller said no / could not confirm settlement), TIMEOUT_AFTER_PAYMENT and
    // UPSTREAM_ERROR_AFTER_PAYMENT (lost the answer), UPSTREAM_BODY_INCOMPLETE
    // (settled, body cut off). A retry would sign and pay a SECOND time, so these
    // must never be a status that a client or relay retries by default:
    //   - OpenAI SDKs retry 408/409/429/5xx and honour x-should-retry (the route sets it);
    //   - new-api (the relay MoneySwitch is plugged into as an OpenAI channel) ignores
    //     x-should-retry and, with RetryTimes > 0, retries every status in its default
    //     ranges 100-199,300-399,401-407,409-499,500-503,505-523,525-599 — that
    //     includes 402 — but NOT 400, 408, 504 or 524
    //     (setting/operation_setting/status_code_ranges.go).
    // 400 is terminal for both. The meaning travels in error.code and
    // error.moneyswitch_charged, not in the status.
    case "PAYMENT_REJECTED":
    case "TIMEOUT_AFTER_PAYMENT":
    case "UPSTREAM_ERROR_AFTER_PAYMENT":
    case "UPSTREAM_BODY_INCOMPLETE":
      return 400;
    case "APPROVAL_REQUIRED":
    case "APPROVAL_INVALID":
      return 409;
    case "WALLET_LOCKED":
    case "WALLET_BUSY": // the wallet is being replaced right now: nothing was signed, try again in a moment
      return 503;
    case "model_not_found":
      return 404;
    default:
      return 500;
  }
}

/** Human-readable fallback message for a gateway/policy error code (SPEC-v0.2 §2 step 6 wants "人类可读说明"). */
export function humanMessageForCode(code: string): string {
  switch (code) {
    case "KEY_INVALID":
      return "MoneyKey not found or invalid";
    case "KEY_REVOKED":
      return "MoneyKey has been revoked";
    case "KEY_EXPIRED":
      return "MoneyKey has expired";
    case "RATE_LIMITED":
      return "Too many payments in the last minute";
    case "PER_REQUEST_LIMIT_EXCEEDED":
      return "Request price exceeds this MoneyKey's per-request limit";
    case "MAX_PRICE_EXCEEDED":
      return "Request price exceeds the max_price given";
    case "DAILY_BUDGET_EXCEEDED":
      return "This MoneyKey's daily budget is exhausted";
    case "TOTAL_BUDGET_EXCEEDED":
      return "This MoneyKey's total budget is exhausted";
    case "PAYMENT_REJECTED":
      return "Seller rejected our signed payment (its facilitator declined it); the held budget is released automatically once the authorization expires";
    case "TIMEOUT_AFTER_PAYMENT":
      return "A payment was signed but the seller did not answer in time; you may have been charged. Do not retry blindly";
    case "UPSTREAM_ERROR_AFTER_PAYMENT":
      return "A payment was signed but the request then failed; you may have been charged. Do not retry blindly";
    case "UPSTREAM_BODY_INCOMPLETE":
      return "The payment was settled but the seller's response was cut off; you have been charged. Do not retry blindly";
    case "APPROVAL_REQUIRED":
      return "Payment requires manual approval";
    case "APPROVAL_INVALID":
      return "approval_id is unknown, not approved yet, expired, already used, or does not match this request";
    case "WALLET_LOCKED":
      return "The MoneySwitch wallet is locked; an admin must unlock it";
    case "WALLET_BUSY":
      return "The MoneySwitch wallet is being replaced right now; nothing was signed or charged. Try again in a moment";
    case "model_not_allowed":
      return "MoneyKey is not allowed to use this model";
    case "model_not_found":
      return "The requested model does not exist or is not served by any enabled channel";
    default:
      return code;
  }
}

/** OpenAI-shaped error body, per SPEC-v0.2 §2 step 6 (+ v0.4 limit_scope / limit_key_prefix when known). */
export function openAiError(
  message: string,
  code: string,
  approvalId?: string | null,
  limit?: { limit_scope?: string; limit_key_prefix?: string },
  extra?: {
    reason?: string | null;
    reserved_until_expiry?: boolean;
    /** "yes" | "no" | "maybe": whether this call cost money (same meaning as /v1/fetch's `charged`). */
    moneyswitch_charged?: "yes" | "no" | "maybe";
    /** Payment facts when a payment was signed (tx_hash is null while unknown). */
    payment?: { amount: string; tx_hash: string | null; network: string | null };
  }
) {
  return {
    error: {
      message,
      type: "moneyswitch_policy",
      code,
      ...(approvalId ? { approval_id: approvalId } : {}),
      ...(limit ?? {}),
      ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
      ...(extra?.reserved_until_expiry !== undefined
        ? { reserved_until_expiry: extra.reserved_until_expiry }
        : {}),
      ...(extra?.moneyswitch_charged !== undefined ? { moneyswitch_charged: extra.moneyswitch_charged } : {}),
      ...(extra?.payment !== undefined ? { payment: extra.payment } : {}),
    },
  };
}

/**
 * Like requireMoneyKey, but emits OpenAI-shaped error bodies on auth failure
 * (SPEC-v0.2 §2: the gateway routes must speak the OpenAI protocol even for
 * key-check failures) instead of requireMoneyKey's `{status,code}` shape,
 * which /v1/fetch's own tests depend on and must not change.
 */
export function requireMoneyKeyOpenAI(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearer(req);
    if (!token || token.startsWith("ms_admin_")) {
      return reply.status(401).send(openAiError("Invalid MoneyKey", "KEY_INVALID"));
    }
    try {
      const key = authenticateMoneyKey(ctx.db, token);
      touchLastUsed(ctx.db, key.id);
      req.moneyKey = key;
    } catch (e) {
      const code = e instanceof MoneySwitchError ? e.code : "KEY_INVALID";
      const limit = limitFields(e);
      const message =
        limit.limit_scope === "ancestor"
          ? `${humanMessageForCode(code)} (parent key ${limit.limit_key_prefix} is no longer active)`
          : humanMessageForCode(code);
      return reply.status(openAiStatusForCode(code)).send(openAiError(message, code, null, limit));
    }
  };
}
