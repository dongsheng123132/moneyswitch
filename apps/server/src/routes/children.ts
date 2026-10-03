import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createChildKeyInTransaction,
  listChildKeys,
  childrenCounts,
  revokeDescendantKey,
  getKeyChain,
  effectiveStatus,
  parseUsdcToMicros,
  formatMicrosToUsdc,
  writeAudit,
  DelegationError,
  MoneySwitchError,
  DEFAULT_MAX_KEY_DEPTH,
  limitFields,
  type CreateChildKeyInput,
} from "@moneyswitch/core";
import type { AppContext } from "../context.js";
import { requireMoneyKey } from "../auth.js";
import { keyView } from "../keyview.js";

/**
 * v0.4 (SPEC-v0.4 §A): child MoneyKeys, created/listed/revoked by the holder
 * of the parent MoneyKey (MoneyKey auth — the caller IS the parent).
 *
 *   POST /v1/keys/children              create a direct child of the caller
 *   GET  /v1/keys/children              list the caller's direct children
 *   POST /v1/keys/children/:id/revoke   revoke a key in the caller's subtree
 *
 * Error bodies: `{ error: <CODE>, code: <CODE>, message, field?, parent_value? }`.
 */

type Body = {
  name?: unknown;
  daily_budget?: unknown;
  total_budget?: unknown;
  per_request_limit?: unknown;
  approval_threshold?: unknown;
  allowed_hosts?: unknown;
  expires_at?: unknown;
  can_delegate?: unknown;
  max_payments_per_minute?: unknown;
};

function parseAmount(body: Body, field: keyof Body, required: boolean): bigint | null {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw new DelegationError("INVALID_REQUEST", `${field} is required`, { field });
    return null;
  }
  const str = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
  if (typeof str !== "string") {
    throw new DelegationError("INVALID_REQUEST", `${field} must be a decimal USDC string like "1.00"`, { field });
  }
  try {
    return parseUsdcToMicros(str);
  } catch {
    throw new DelegationError("INVALID_REQUEST", `${field} must be a decimal USDC string like "1.00"`, { field });
  }
}

function parseStringArray(body: Body, field: "allowed_hosts"): string[] | null {
  const raw = body[field];
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
    throw new DelegationError("INVALID_REQUEST", `${field} must be an array of strings`, { field });
  }
  return raw as string[];
}

function parseBody(body: Body): CreateChildKeyInput {
  if (body == null || typeof body !== "object") {
    throw new DelegationError("INVALID_REQUEST", "JSON body required");
  }
  if (typeof body.name !== "string") {
    throw new DelegationError("INVALID_REQUEST", "name is required", { field: "name" });
  }
  if (body.can_delegate !== undefined && body.can_delegate !== null && typeof body.can_delegate !== "boolean") {
    throw new DelegationError("INVALID_REQUEST", "can_delegate must be a boolean", { field: "can_delegate" });
  }
  if (body.expires_at !== undefined && body.expires_at !== null && typeof body.expires_at !== "string") {
    throw new DelegationError("INVALID_REQUEST", "expires_at must be an ISO-8601 string", { field: "expires_at" });
  }
  let maxPerMinute: number | undefined;
  if (body.max_payments_per_minute !== undefined && body.max_payments_per_minute !== null) {
    if (typeof body.max_payments_per_minute !== "number") {
      throw new DelegationError("INVALID_REQUEST", "max_payments_per_minute must be a positive integer", {
        field: "max_payments_per_minute",
      });
    }
    maxPerMinute = body.max_payments_per_minute;
  }
  return {
    name: body.name,
    dailyBudget: parseAmount(body, "daily_budget", true)!,
    totalBudget: parseAmount(body, "total_budget", true)!,
    perRequestLimit: parseAmount(body, "per_request_limit", true)!,
    approvalThreshold: parseAmount(body, "approval_threshold", false),
    allowedHosts: parseStringArray(body, "allowed_hosts"),
    expiresAt: (body.expires_at as string | null | undefined) ?? null,
    canDelegate: body.can_delegate === true,
    maxPaymentsPerMinute: maxPerMinute,
  };
}

function wireParentValue(v: unknown): unknown {
  return typeof v === "bigint" ? formatMicrosToUsdc(v) : v;
}

function sendDelegationError(reply: FastifyReply, e: DelegationError) {
  return reply.status(e.httpStatus).send({
    error: e.code,
    code: e.code,
    message: e.message.replace(/^[A-Z_]+: /, ""),
    ...(e.field ? { field: e.field } : {}),
    ...(e.parentValue !== undefined ? { parent_value: wireParentValue(e.parentValue) } : {}),
  });
}

export function registerChildKeyRoutes(app: FastifyInstance, ctx: AppContext) {
  const keyGuard = requireMoneyKey(ctx);
  const maxDepth = () => ctx.config.maxKeyDepth ?? DEFAULT_MAX_KEY_DEPTH;

  app.post("/v1/keys/children", { preHandler: keyGuard }, async (req, reply) => {
    const parent = req.moneyKey!;
    let input: CreateChildKeyInput;
    try {
      input = parseBody(req.body as Body);
    } catch (e) {
      if (e instanceof DelegationError) return sendDelegationError(reply, e);
      throw e;
    }
    try {
      // Validation + insert in ONE BEGIN IMMEDIATE transaction against a fresh
      // read of the parent chain (the auth snapshot is only used for its id).
      const { plaintextKey, row } = createChildKeyInTransaction(ctx.sqlite, ctx.db, parent.id, input, {
        maxDepth: maxDepth(),
      });
      writeAudit(ctx.db, `key:${parent.id}`, "key.child_create", {
        keyId: row.id,
        parentId: parent.id,
        name: row.name,
        depth: row.depth,
        canDelegate: row.canDelegate,
        dailyBudget: formatMicrosToUsdc(row.dailyBudget),
        totalBudget: formatMicrosToUsdc(row.totalBudget),
        perRequestLimit: formatMicrosToUsdc(row.perRequestLimit),
      });
      return reply.send({
        ...keyView(ctx.db, row, { childrenCount: 0, status: "active" }),
        // Full key — returned exactly once, never stored in plaintext.
        key: plaintextKey,
      });
    } catch (e) {
      if (e instanceof DelegationError) return sendDelegationError(reply, e);
      if (e instanceof MoneySwitchError) {
        // Parent (or an ancestor) was revoked/expired between auth and the transaction.
        return reply.status(401).send({ status: "error", code: e.code, error: e.code, ...limitFields(e) });
      }
      throw e;
    }
  });

  app.get("/v1/keys/children", { preHandler: keyGuard }, async (req, reply) => {
    const parent = req.moneyKey!;
    const parentChain = getKeyChain(ctx.db, parent.id);
    const counts = childrenCounts(ctx.db);
    const now = Date.now();
    const children = listChildKeys(ctx.db, parent.id).map((row) =>
      keyView(ctx.db, row, {
        childrenCount: counts.get(row.id) ?? 0,
        status: effectiveStatus([row, ...parentChain], now),
      })
    );
    return reply.send({ children });
  });

  app.post("/v1/keys/children/:id/revoke", { preHandler: keyGuard }, async (req, reply) => {
    const caller = req.moneyKey!;
    const { id } = req.params as { id: string };
    // Only strict descendants of the caller. Anything else (a sibling, an
    // ancestor, the caller itself, another tree, a non-existent id) is 404,
    // so the endpoint cannot be used to probe for keys outside the subtree.
    const revoked = revokeDescendantKey(ctx.db, caller.id, id);
    if (!revoked) {
      return reply.status(404).send({ error: "NOT_FOUND", code: "NOT_FOUND", message: "No such key in your subtree" });
    }
    writeAudit(ctx.db, `key:${caller.id}`, "key.child_revoke", { keyId: id, parentId: revoked.parentId });
    return reply.send({ id, revoked: true });
  });
}
