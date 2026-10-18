import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createChildKeyInTransaction,
  listChildKeys,
  childrenCounts,
  revokeDescendantKey,
  getKeyChain,
  effectiveStatus,
  formatMicrosToUsdc,
  writeAudit,
  DelegationError,
  MoneySwitchError,
  DEFAULT_MAX_KEY_DEPTH,
  limitFields,
  parseKeyFields,
  keyErrorFields,
  type KeyBody,
  type CreateChildKeyInput,
  type NetworkMode,
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

type Body = KeyBody & { network_mode?: unknown };

/**
 * The child-key body: the shared key fields (core/keyinput.ts, the same
 * reading POST /v1/keys gives them) plus what only a child key has — the
 * network type, which must be its parent's.
 */
function parseBody(body: Body): CreateChildKeyInput {
  if (body == null || typeof body !== "object") {
    throw new DelegationError("INVALID_REQUEST", "JSON body required");
  }
  if (body.network_mode !== undefined && body.network_mode !== null && body.network_mode !== "testnet" && body.network_mode !== "mainnet") {
    throw new DelegationError("INVALID_REQUEST", 'network_mode must be "testnet" or "mainnet"', { field: "network_mode" });
  }
  const fields = parseKeyFields(body);
  return {
    ...fields,
    networkMode: (body.network_mode as NetworkMode | null | undefined) ?? null,
  };
}

/** `{ error, code, message, field?, parent_value? }` with the status the code says (400 for these, 403 for a refusal). */
function sendDelegationError(reply: FastifyReply, e: DelegationError) {
  return reply.status(e.httpStatus).send(keyErrorFields(e));
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
        networkMode: row.networkMode,
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
