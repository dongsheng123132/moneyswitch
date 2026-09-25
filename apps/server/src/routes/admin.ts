import type { FastifyInstance } from "fastify";
import {
  createMoneyKey,
  listMoneyKeys,
  getMoneyKeyById,
  revokeMoneyKey,
  listApprovals,
  decideApproval,
  expireStaleApprovals,
  usedToday,
  usedTotal,
  formatMicrosToUsdc,
  parseUsdcToMicros,
  listAllPayments,
  writeAudit,
  createChannel,
  listChannels,
  getChannelById,
  updateChannel,
  deleteChannel,
  normalizeBaseUrl,
  assertNotSsrf,
  MoneySwitchError,
} from "@moneyswitch/core";
import { getActiveNetwork } from "@moneyswitch/x402";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth.js";

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const adminGuard = requireAdmin(ctx);

  app.post("/v1/keys", { preHandler: adminGuard }, async (req, reply) => {
    const body = req.body as {
      name: string;
      total_budget: string;
      daily_budget: string;
      per_request_limit: string;
      approval_threshold?: string | null;
      allowed_hosts: string[];
      max_payments_per_minute?: number;
      expires_at?: string | null;
      allowed_models?: string[] | null;
    };
    try {
      const { plaintextKey, row } = createMoneyKey(ctx.db, {
        name: body.name,
        totalBudget: parseUsdcToMicros(body.total_budget),
        dailyBudget: parseUsdcToMicros(body.daily_budget),
        perRequestLimit: parseUsdcToMicros(body.per_request_limit),
        approvalThreshold:
          body.approval_threshold != null ? parseUsdcToMicros(body.approval_threshold) : null,
        allowedHosts: body.allowed_hosts ?? [],
        maxPaymentsPerMinute: body.max_payments_per_minute,
        expiresAt: body.expires_at ?? null,
        allowedModels: body.allowed_models ?? null,
      });
      writeAudit(ctx.db, "admin", "key.create", { keyId: row.id, name: row.name });
      return reply.send({
        id: row.id,
        key: plaintextKey,
        name: row.name,
        total_budget: formatMicrosToUsdc(row.totalBudget),
        daily_budget: formatMicrosToUsdc(row.dailyBudget),
        per_request_limit: formatMicrosToUsdc(row.perRequestLimit),
        approval_threshold: row.approvalThreshold != null ? formatMicrosToUsdc(row.approvalThreshold) : null,
        allowed_hosts: row.allowedHosts,
        max_payments_per_minute: row.maxPaymentsPerMinute,
        expires_at: row.expiresAt,
        allowed_models: row.allowedModels,
      });
    } catch (e) {
      return reply.status(400).send({ error: e instanceof Error ? e.message : "invalid_request" });
    }
  });

  app.get("/v1/keys", { preHandler: adminGuard }, async (_req, reply) => {
    const rows = listMoneyKeys(ctx.db);
    const out = rows.map((row) => ({
      id: row.id,
      name: row.name,
      key_prefix: row.keyPrefix,
      enabled: row.enabled,
      total_budget: formatMicrosToUsdc(row.totalBudget),
      daily_budget: formatMicrosToUsdc(row.dailyBudget),
      per_request_limit: formatMicrosToUsdc(row.perRequestLimit),
      approval_threshold: row.approvalThreshold != null ? formatMicrosToUsdc(row.approvalThreshold) : null,
      allowed_hosts: row.allowedHosts,
      max_payments_per_minute: row.maxPaymentsPerMinute,
      expires_at: row.expiresAt,
      created_at: row.createdAt,
      last_used_at: row.lastUsedAt,
      used_today: formatMicrosToUsdc(usedToday(ctx.db, row.id)),
      used_total: formatMicrosToUsdc(usedTotal(ctx.db, row.id)),
      allowed_models: row.allowedModels,
    }));
    return reply.send({ keys: out });
  });

  app.post("/v1/keys/:id/revoke", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = getMoneyKeyById(ctx.db, id);
    if (!row) return reply.status(404).send({ error: "not_found" });
    revokeMoneyKey(ctx.db, id);
    writeAudit(ctx.db, "admin", "key.revoke", { keyId: id });
    return reply.send({ id, revoked: true });
  });

  app.get("/v1/approvals", { preHandler: adminGuard }, async (req, reply) => {
    expireStaleApprovals(ctx.db);
    const { status } = req.query as { status?: string };
    const rows = listApprovals(ctx.db, status);
    return reply.send({
      approvals: rows.map((a) => ({
        id: a.id,
        key_id: a.keyId,
        url: a.url,
        method: a.method,
        network: a.network,
        asset: a.asset,
        pay_to: a.payTo,
        amount: formatMicrosToUsdc(a.amount),
        status: a.status,
        expires_at: a.expiresAt,
        decided_at: a.decidedAt,
        created_at: a.createdAt,
      })),
    });
  });

  app.post("/v1/approvals/:id/approve", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const row = decideApproval(ctx.db, id, "approved");
      writeAudit(ctx.db, "admin", "approval.approve", { approvalId: id });
      return reply.send({ id: row.id, status: row.status });
    } catch (e) {
      return reply.status(400).send({ error: e instanceof Error ? e.message : "invalid_request" });
    }
  });

  app.post("/v1/approvals/:id/deny", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const row = decideApproval(ctx.db, id, "denied");
      writeAudit(ctx.db, "admin", "approval.deny", { approvalId: id });
      return reply.send({ id: row.id, status: row.status });
    } catch (e) {
      return reply.status(400).send({ error: e instanceof Error ? e.message : "invalid_request" });
    }
  });

  app.get("/v1/admin/usage", { preHandler: adminGuard }, async (_req, reply) => {
    const payments = listAllPayments(ctx.db, 200);
    return reply.send({
      payments: payments.map((p) => ({
        id: p.id,
        key_id: p.keyId,
        url: p.url,
        host: p.host,
        method: p.method,
        network: p.network,
        asset: p.asset,
        pay_to: p.payTo,
        amount: formatMicrosToUsdc(p.amount),
        status: p.status,
        tx_hash: p.txHash,
        error_code: p.errorCode,
        approval_id: p.approvalId,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
        kind: p.kind,
        model: p.model,
        prompt_tokens: p.promptTokens,
        completion_tokens: p.completionTokens,
      })),
    });
  });

  // --- v0.2 (SPEC-v0.2 §1): Channel management ---

  app.get("/v1/admin/channels", { preHandler: adminGuard }, async (_req, reply) => {
    const rows = listChannels(ctx.db);
    return reply.send({
      channels: rows.map((c) => ({
        id: c.id,
        name: c.name,
        base_url: c.baseUrl,
        models: c.models,
        enabled: c.enabled,
        created_at: c.createdAt,
      })),
    });
  });

  app.post("/v1/admin/channels", { preHandler: adminGuard }, async (req, reply) => {
    const body = req.body as { name?: string; base_url?: string; models?: string[] };
    if (!body.name || !body.base_url) {
      return reply.status(400).send({ error: "name and base_url are required" });
    }
    try {
      const row = createChannel(ctx.db, {
        name: body.name,
        baseUrl: body.base_url,
        models: body.models ?? [],
      });
      writeAudit(ctx.db, "admin", "channel.create", { channelId: row.id, name: row.name });
      return reply.send({
        id: row.id,
        name: row.name,
        base_url: row.baseUrl,
        models: row.models,
        enabled: row.enabled,
        created_at: row.createdAt,
      });
    } catch (e) {
      return reply.status(400).send({ error: e instanceof Error ? e.message : "invalid_request" });
    }
  });

  app.patch("/v1/admin/channels/:id", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { enabled?: boolean; models?: string[]; name?: string; base_url?: string };
    if (!getChannelById(ctx.db, id)) {
      return reply.status(404).send({ error: "not_found" });
    }
    try {
      const row = updateChannel(ctx.db, id, {
        enabled: body.enabled,
        models: body.models,
        name: body.name,
        baseUrl: body.base_url,
      });
      writeAudit(ctx.db, "admin", "channel.update", { channelId: id });
      return reply.send({
        id: row.id,
        name: row.name,
        base_url: row.baseUrl,
        models: row.models,
        enabled: row.enabled,
        created_at: row.createdAt,
      });
    } catch (e) {
      return reply.status(400).send({ error: e instanceof Error ? e.message : "invalid_request" });
    }
  });

  // GET /v1/admin/channels/probe-models?base_url=... : server-side proxy for the
  // Dashboard's "pull models from upstream" button — the browser can't call the
  // channel's base_url directly (CORS), so we fetch `${base_url}/models` here.
  // Reuses the SSRF self-port hard-block (never bypassable); private/loopback
  // hosts are otherwise allowed since a channel base_url legitimately targets
  // local demo-seller instances. 5s timeout, no redirects followed, 256KB cap.
  app.get("/v1/admin/channels/probe-models", { preHandler: adminGuard }, async (req, reply) => {
    const { base_url } = req.query as { base_url?: string };
    if (!base_url) {
      return reply.status(400).send({ error: "PROBE_FAILED", message: "base_url query param is required" });
    }

    let url: URL;
    try {
      url = new URL(`${normalizeBaseUrl(base_url)}/models`);
    } catch {
      return reply.status(400).send({ error: "PROBE_FAILED", message: "base_url is not a valid URL" });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return reply.status(400).send({ error: "PROBE_FAILED", message: "base_url must be http or https" });
    }

    try {
      const hostPort = `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
      // allowedHosts=[hostPort] permits this exact private/loopback target;
      // the self-port rule below is enforced regardless and cannot be bypassed.
      assertNotSsrf(url, { selfPort: ctx.config.port, allowedHosts: [hostPort] });
    } catch (e) {
      const message = e instanceof MoneySwitchError ? e.message : "SSRF_BLOCKED";
      return reply.status(502).send({ error: "PROBE_FAILED", message });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const RESPONSE_LIMIT_BYTES = 256 * 1024;
    try {
      const res = await fetch(url, { redirect: "manual", signal: controller.signal });
      if (res.status >= 300 && res.status < 400) {
        return reply.status(502).send({ error: "PROBE_FAILED", message: `upstream returned a redirect (HTTP ${res.status})` });
      }
      if (!res.ok) {
        return reply.status(502).send({ error: "PROBE_FAILED", message: `upstream returned HTTP ${res.status}` });
      }
      const raw = await res.text();
      const truncated = raw.length > RESPONSE_LIMIT_BYTES ? raw.slice(0, RESPONSE_LIMIT_BYTES) : raw;
      let json: unknown;
      try {
        json = JSON.parse(truncated);
      } catch {
        return reply.status(502).send({ error: "PROBE_FAILED", message: "upstream did not return valid JSON" });
      }
      const data = (json as { data?: Array<{ id?: string }> })?.data;
      if (!Array.isArray(data)) {
        return reply.status(502).send({ error: "PROBE_FAILED", message: "upstream response missing a 'data' array" });
      }
      const models = data.map((m) => m?.id).filter((id): id is string => typeof id === "string");
      return reply.send({ models });
    } catch (e) {
      const message = e instanceof Error ? e.message : "probe request failed";
      return reply.status(502).send({ error: "PROBE_FAILED", message });
    } finally {
      clearTimeout(timeout);
    }
  });

  app.delete("/v1/admin/channels/:id", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getChannelById(ctx.db, id)) {
      return reply.status(404).send({ error: "not_found" });
    }
    deleteChannel(ctx.db, id);
    writeAudit(ctx.db, "admin", "channel.delete", { channelId: id });
    return reply.send({ id, deleted: true });
  });

  app.get("/v1/admin/wallet", { preHandler: adminGuard }, async (_req, reply) => {
    const network = getActiveNetwork();
    const address = ctx.wallet.getAddress();
    let balance: string | null = null;
    if (address) {
      try {
        const raw = await ctx.wallet.getUsdcBalance(network.rpcUrl, network.usdcAddress);
        balance = formatMicrosToUsdc(raw);
      } catch {
        balance = null;
      }
    }
    return reply.send({
      address,
      unlocked: ctx.wallet.isUnlocked(),
      has_keystore: ctx.wallet.hasKeystore(),
      usdc_balance: balance,
      network: network.caip2,
    });
  });

  app.post("/v1/admin/wallet/create", { preHandler: adminGuard }, async (req, reply) => {
    const { password } = req.body as { password: string };
    if (!password || password.length < 8) {
      return reply.status(400).send({ error: "password must be at least 8 characters" });
    }
    try {
      const { address } = await ctx.wallet.createWallet(password);
      writeAudit(ctx.db, "admin", "wallet.create", { address });
      return reply.send({ address });
    } catch (e) {
      return reply.status(400).send({ error: e instanceof Error ? e.message : "wallet_error" });
    }
  });

  app.post("/v1/admin/wallet/unlock", { preHandler: adminGuard }, async (req, reply) => {
    const { password } = req.body as { password: string };
    try {
      const { address } = await ctx.wallet.unlock(password);
      writeAudit(ctx.db, "admin", "wallet.unlock", { address });
      return reply.send({ address, unlocked: true });
    } catch {
      return reply.status(400).send({ error: "unlock_failed" });
    }
  });
}
