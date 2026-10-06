import type { FastifyRequest, FastifyReply } from "fastify";
import {
  verifyAdminToken,
  authenticateMoneyKey,
  touchLastUsed,
  MoneySwitchError,
  limitFields,
  expireStaleApprovals,
  getApproval,
  checkApprovalPin,
  isValidApprovalPin,
  writeAudit,
  APPROVAL_PIN_MAX_FAILURES,
  type ApprovalPinRefusal,
} from "@moneyswitch/core";
import type { MoneyKeyRow } from "@moneyswitch/core";
import type { AppContext } from "./context.js";

function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers["authorization"];
  if (!header || Array.isArray(header)) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1] : null;
}

/** Is this request the administrator's (ms_admin_xxx)? A MoneyKey (mk_live_xxx) never is. */
function isAdminRequest(ctx: AppContext, req: FastifyRequest): boolean {
  const token = extractBearer(req);
  return Boolean(token) && !token!.startsWith("mk_live_") && verifyAdminToken(ctx.db, token!);
}

/** Admin routes only accept ms_admin_xxx. A MoneyKey (mk_live_xxx) is always 403. */
export function requireAdmin(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isAdminRequest(ctx, req)) return reply.status(403).send({ error: "FORBIDDEN" });
  };
}

declare module "fastify" {
  interface FastifyRequest {
    moneyKey?: MoneyKeyRow;
    /** Who decides the approval of this request (requireAdminOrApprovalPin): "admin", or `pin:<root key id>`; the name the audit row carries. */
    approvalActor?: string;
  }
}

const PIN_REFUSAL_MESSAGES: Record<ApprovalPinRefusal, string> = {
  WRONG: "That PIN is not right.",
  LOCKED: `This key's PIN is locked after ${APPROVAL_PIN_MAX_FAILURES} wrong tries. Only the administrator can approve now, and setting a new PIN unlocks it.`,
  NOT_SET: "This key has no PIN: only the administrator can approve its requests.",
  KEY_NOT_ACTIVE: "The key this request belongs to is revoked or expired.",
};
const PIN_REFUSAL_CODES: Record<ApprovalPinRefusal, string> = {
  WRONG: "APPROVAL_PIN_WRONG",
  LOCKED: "APPROVAL_PIN_LOCKED",
  NOT_SET: "APPROVAL_PIN_NOT_SET",
  KEY_NOT_ACTIVE: "APPROVAL_KEY_NOT_ACTIVE",
};

/**
 * Who may approve or deny request `:id` (SPEC.md §3): the administrator (Authorization: Bearer ms_admin_…), or the person who holds the key:
 * no Authorization, and the PIN of the request's root key as `{"pin": "1234"}` in the body. Any Authorization that is not the
 * administrator's (a MoneyKey, a stale token) is a plain 403 whatever the body says: a key can never approve. A PIN is only looked at for a
 * request that exists and is still pending (404 / APPROVAL_NOT_PENDING cost no try); a wrong one is counted (cumulatively since the PIN was
 * set: a right one resets nothing) and audited, and the fifth locks the key's PIN. Sets req.approvalActor.
 */
export function requireAdminOrApprovalPin(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (isAdminRequest(ctx, req)) {
      req.approvalActor = "admin";
      return;
    }
    const pin = (req.body as { pin?: unknown } | null | undefined)?.pin;
    if (req.headers["authorization"] || pin === undefined) return reply.status(403).send({ error: "FORBIDDEN" });
    if (!isValidApprovalPin(pin)) return reply.status(400).send({ error: "APPROVAL_PIN_INVALID", message: "pin must be 4 to 6 digits" });

    expireStaleApprovals(ctx.db);
    const { id } = req.params as { id: string };
    const approval = getApproval(ctx.db, id);
    if (!approval) return reply.status(404).send({ error: "not_found" });
    if (approval.status !== "pending") return reply.status(400).send({ error: "APPROVAL_NOT_PENDING" });

    const check = checkApprovalPin(ctx.db, approval.keyId, pin);
    if (!check.ok) {
      if (check.counted) {
        writeAudit(ctx.db, "anonymous", "approval.pin_wrong", { approvalId: id, keyId: check.rootKeyId, attemptsLeft: check.attemptsLeft, locked: check.reason === "LOCKED" });
      }
      return reply.status(403).send({
        error: PIN_REFUSAL_CODES[check.reason],
        message: PIN_REFUSAL_MESSAGES[check.reason],
        ...(check.reason === "WRONG" ? { attempts_left: check.attemptsLeft } : {}),
      });
    }
    req.approvalActor = `pin:${check.rootKeyId}`;
  };
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

