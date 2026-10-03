import type { FastifyInstance } from "fastify";
import { rotateMoneyKeySecret, writeAudit, MoneySwitchError } from "@moneyswitch/core";
import { renderSkill, normalizeBaseUrl } from "@moneyswitch/skill";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth.js";
import { bindOrigin } from "../public-base.js";

/**
 * "One paste gives an AI agent payment ability" - the server side.
 *
 *   GET  /skill.md              public, generic SKILL.md (never contains a key)
 *   POST /v1/keys/:id/rotate    admin: new secret for the same key id
 *
 * The text itself comes from @moneyswitch/skill, the same renderer the
 * Dashboard uses for the personalized copy-paste text.
 */

/**
 * Base URL that goes into the public skill: MONEYSWITCH_PUBLIC_URL when it is set (and sane), else the address the server itself
 * listens on. Never the request's Host header (the sender chooses it, and an AI would follow whatever address the skill names); when
 * neither forms a plain http(s) origin the skill is rendered server-agnostic (env vars only).
 */
export function skillBaseUrl(ctx: AppContext): string | null {
  const candidates = [ctx.config.publicUrl, bindOrigin(ctx.config)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return normalizeBaseUrl(c);
    } catch {
      // not a plain base URL: try the next candidate
    }
  }
  return null;
}

export function registerSkillRoutes(app: FastifyInstance, ctx: AppContext) {
  const adminGuard = requireAdmin(ctx);

  app.get("/skill.md", async (_req, reply) => {
    return reply
      .header("content-type", "text/markdown; charset=utf-8")
      // The body depends on MONEYSWITCH_PUBLIC_URL, which an operator can change: do not let an intermediary keep an old copy.
      .header("cache-control", "no-cache")
      .header("x-content-type-options", "nosniff")
      .send(renderSkill({ baseUrl: skillBaseUrl(ctx) }));
  });

  // Only a hash of a key is stored, so a lost secret cannot be shown again.
  // Rotate keeps the key id (budgets, usage history, children, settings) and
  // swaps the secret; the old one stops working at once. The new plaintext is
  // returned exactly once.
  app.post("/v1/keys/:id/rotate", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const res = rotateMoneyKeySecret(ctx.db, id);
      if (!res) return reply.status(404).send({ error: "not_found" });
      writeAudit(ctx.db, "admin", "key.rotate", {
        keyId: id,
        name: res.row.name,
        previousPrefix: res.previousPrefix,
        newPrefix: res.row.keyPrefix,
      });
      return reply.header("cache-control", "no-store").send({
        id: res.row.id,
        key: res.plaintextKey,
        name: res.row.name,
        key_prefix: res.row.keyPrefix,
        allowed_hosts: res.row.allowedHosts,
        parent_id: res.row.parentId,
        depth: res.row.depth,
      });
    } catch (e) {
      if (e instanceof MoneySwitchError && e.code === "KEY_REVOKED") {
        return reply.status(409).send({ error: "KEY_REVOKED", message: "a revoked key cannot be reset; create a new key instead" });
      }
      throw e;
    }
  });
}
