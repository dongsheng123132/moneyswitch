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

