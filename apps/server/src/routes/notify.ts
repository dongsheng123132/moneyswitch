import type { FastifyInstance } from "fastify";
import { writeAudit } from "@moneyswitch/core";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth.js";
import { dispatchEvent } from "../notify/dispatcher.js";
import { resolveRuntime } from "../notify/runtime.js";
import {
  applyPatch,
  buildAdminView,
  fieldName,
  parsePatch,
  resolveSettings,
  toNotifyConfig,
} from "../notify/settings.js";
import { NotifyInputError } from "../notify/types.js";

/**
 * Admin API for approval push notifications.
 *
 *   GET  /v1/admin/notify        which channels are configured (secrets masked) + where each value comes from (env | db)
 *   PUT  /v1/admin/notify        partial update; "" / null clears a field; env-supplied fields are read-only (409)
 *   POST /v1/admin/notify/test   sends a test message to every configured channel, returns per-channel ok/error
 *
 * Nothing here ever returns a full webhook URL, token or secret, including
 * right after saving, and error text is scrubbed of them before it is returned.
 */
export function registerNotifyRoutes(app: FastifyInstance, ctx: AppContext) {
  const adminGuard = requireAdmin(ctx);

  function approveUrl(): string | null {
    const base = ctx.config.publicUrl?.trim().replace(/\/+$/, "");
    return base ? `${base}/approvals` : null;
  }

  function view() {
    const runtime = resolveRuntime(ctx.notify);
    const { values, sources } = resolveSettings(ctx.sqlite, runtime.env);
    return { ...buildAdminView(values, sources), approve_url: approveUrl() };
  }

  app.get("/v1/admin/notify", { preHandler: adminGuard }, async (_req, reply) => reply.send(view()));

  app.put("/v1/admin/notify", { preHandler: adminGuard }, async (req, reply) => {
    const runtime = resolveRuntime(ctx.notify);
    try {
      const patch = parsePatch(req.body);
      const changed = applyPatch(ctx.sqlite, patch, runtime.env, runtime.now());
      // Field names only: values are secrets and never go to the audit log.
      writeAudit(ctx.db, "admin", "notify.update", { fields: changed.map(fieldName) });
      return reply.send(view());
    } catch (e) {
      if (e instanceof NotifyInputError) {
        return reply.status(e.code === "FIELD_FROM_ENV" ? 409 : 400).send({ error: e.code, field: e.field });
      }
      throw e;
    }
  });

  app.post("/v1/admin/notify/test", { preHandler: adminGuard }, async (_req, reply) => {
    const runtime = resolveRuntime(ctx.notify);
    const { values } = resolveSettings(ctx.sqlite, runtime.env);
    const results = await dispatchEvent(
      { type: "test", approveUrl: approveUrl() },
      toNotifyConfig(values),
      runtime.deps(),
      runtime.log
    );
    writeAudit(ctx.db, "admin", "notify.test", { results: results.map((r) => ({ channel: r.channel, ok: r.ok })) });
    return reply.send({ results });
  });
}
