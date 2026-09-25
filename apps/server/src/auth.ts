import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyAdminToken, authenticateMoneyKey, touchLastUsed, MoneySwitchError } from "@moneyswitch/core";
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
      return reply.status(401).send({ status: "error", code: "KEY_INVALID" });
    }
    try {
      const key = authenticateMoneyKey(ctx.db, token);
      touchLastUsed(ctx.db, key.id);
      req.moneyKey = key;
    } catch (e) {
      const code = e instanceof MoneySwitchError ? e.code : "KEY_INVALID";
      return reply.status(401).send({ status: "error", code });
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
    case "APPROVAL_REQUIRED":
    case "APPROVAL_INVALID":
      return 409;
    case "WALLET_LOCKED":
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
    case "APPROVAL_REQUIRED":
      return "Payment requires manual approval";
    case "APPROVAL_INVALID":
      return "approval_id is unknown, not approved yet, expired, already used, or does not match this request";
    case "WALLET_LOCKED":
      return "The MoneySwitch wallet is locked; an admin must unlock it";
    case "model_not_allowed":
      return "MoneyKey is not allowed to use this model";
    case "model_not_found":
      return "The requested model does not exist or is not served by any enabled channel";
    default:
      return code;
  }
}

/** OpenAI-shaped error body, per SPEC-v0.2 §2 step 6. */
export function openAiError(message: string, code: string, approvalId?: string | null) {
  return {
    error: {
      message,
      type: "moneyswitch_policy",
      code,
      ...(approvalId ? { approval_id: approvalId } : {}),
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
      return reply.status(openAiStatusForCode(code)).send(openAiError(humanMessageForCode(code), code));
    }
  };
}
