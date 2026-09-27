import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createTollbooth,
  getTollbooth,
  getTollboothBySlug,
  listTollbooths,
  listTollboothRoutes,
  updateTollbooth,
  deleteTollbooth,
  addTollboothRoute,
  updateTollboothRoute,
  deleteTollboothRoute,
  recordEarning,
  queryEarnings,
  startOfUtcDay,
  formatMicrosToUsdc,
  parseUsdcToMicros,
  writeAudit,
  TollboothError,
  type TollboothRow,
  type TollboothRouteRow,
  type TollboothRouteInput,
} from "@moneyswitch/core";
import {
  splitTollboothUrl,
  normalizeRequestPath,
  matchRoute,
  joinUpstreamUrl,
  normalizeUpstreamUrl,
  buildUpstreamRequestHeaders,
  buildBuyerResponseHeaders,
  rewriteLocation,
  forwardToUpstream,
  UpstreamError,
  UpstreamUrlError,
  statusForUpstreamFailure,
  isSelfTargetResolved,
  createTollResourceServer,
  buildRouteConfig,
  runPaidRequest,
  payerFromPaymentHeader,
  ReplayGuard,
  TollPathError,
  formatUsdc,
  type TollResourceServer,
  type HandlerResult,
} from "@moneyswitch/tollbooth";
import type { HTTPAdapter } from "@x402/core/server";
import { getActiveNetwork } from "@moneyswitch/x402";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth.js";

/**
 * SPEC-v0.5 §2 — toll booths.
 *
 *   ANY  /t/{slug}/*                         public paid proxy (x402 via the official SDK)
 *   GET  /v1/admin/tollbooths                list
 *   POST /v1/admin/tollbooths                create (with rules)
 *   PATCH/DELETE /v1/admin/tollbooths/:id    edit (optionally replace rules) / delete
 *   POST/PATCH/DELETE /v1/admin/tollbooths/:id/routes[/:routeId]
 *   POST /v1/admin/tollbooths/:id/test       free upstream probe (never charges)
 *   POST /v1/admin/tollbooths/test-upstream  same, for the create wizard (no toll booth yet)
 *   GET  /v1/admin/earnings                  income, with totals
 */

const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BYTES = 64 * 1024;

export function publicBase(ctx: AppContext, req: FastifyRequest): string {
  if (ctx.config.publicUrl) return ctx.config.publicUrl;
  return `${req.protocol}://${req.host}`;
}

function routeView(r: TollboothRouteRow) {
  return {
    id: r.id,
    method: r.method,
    path_pattern: r.pathPattern,
    price: formatMicrosToUsdc(r.price),
    description: r.description,
  };
}

function tollboothView(ctx: AppContext, req: FastifyRequest, t: TollboothRow, routes: TollboothRouteRow[]) {
  const wallet = ctx.wallet.getAddress();
  const today = queryEarnings(ctx.db, { tollboothId: t.id, sinceIso: startOfUtcDay(), limit: 1 });
  const all = queryEarnings(ctx.db, { tollboothId: t.id, limit: 1 });
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    upstream_url: t.upstreamUrl,
    pay_to: t.payTo,
    pay_to_is_wallet: Boolean(wallet && wallet.toLowerCase() === t.payTo.toLowerCase()),
    network: t.network,
    enabled: t.enabled,
    forward_host_header: t.forwardHostHeader,
    default_price: t.defaultPrice == null ? null : formatMicrosToUsdc(t.defaultPrice),
    description: t.description,
    public_url: `${publicBase(ctx, req)}/t/${t.slug}`,
    routes: routes.map(routeView),
    earnings_today: formatMicrosToUsdc(today.total),
    paid_calls_today: today.settledCount,
    earnings_total: formatMicrosToUsdc(all.total),
    paid_calls_total: all.settledCount,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

function sendTollboothError(reply: FastifyReply, e: unknown) {
  if (e instanceof TollboothError) {
    const status = e.code === "NOT_FOUND" ? 404 : e.code === "SLUG_TAKEN" ? 409 : 400;
    return reply.status(status).send({ error: e.code, message: e.message, ...(e.reason ? { reason: e.reason } : {}) });
  }
  if (e instanceof Error && /^INVALID_AMOUNT/.test(e.message)) {
    return reply.status(400).send({ error: "INVALID_PRICE", message: "Prices are USDC amounts like 0.01 (max 6 decimals)" });
  }
  return reply.status(400).send({ error: "INVALID_REQUEST", message: e instanceof Error ? e.message : "invalid request" });
}

function parsePrice(v: unknown, field: string): bigint {
  if (typeof v === "number") v = String(v);
  if (typeof v !== "string") throw new TollboothError("INVALID_PRICE", `${field} must be a USDC amount string like "0.01"`);
  try {
    return parseUsdcToMicros(v.replace(/^\$/, ""));
  } catch {
    throw new TollboothError("INVALID_PRICE", `${field}: "${v}" is not a USDC amount like 0.01 (max 6 decimals)`);
  }
}

interface RouteBody {
  method?: string;
  path_pattern?: string;
  price?: string | number;
  description?: string | null;
}

function parseRouteBody(r: RouteBody, i?: number): TollboothRouteInput {
  const label = i === undefined ? "Rule" : `Rule ${i + 1}`;
  if (!r || typeof r !== "object") throw new TollboothError("INVALID_ROUTE", `${label} must be an object`);
  if (typeof r.path_pattern !== "string") throw new TollboothError("INVALID_ROUTE", `${label}: path_pattern is required`);
  return { method: r.method, pathPattern: r.path_pattern, price: parsePrice(r.price ?? "0", `${label} price`), description: r.description ?? null };
}

async function assertUpstreamNotSelf(ctx: AppContext, upstreamUrl: string): Promise<void> {
  let normalized: string;
  try {
    normalized = normalizeUpstreamUrl(upstreamUrl);
  } catch (e) {
    throw new TollboothError("INVALID_UPSTREAM", e instanceof UpstreamUrlError ? e.message : "Invalid upstream URL");
  }
  if (await isSelfTargetResolved(new URL(normalized), ctx.config.port)) {
    throw new TollboothError(
      "UPSTREAM_IS_SELF",
      "The upstream points at this MoneySwitch server itself. A toll booth must sit in front of another service (e.g. http://127.0.0.1:8000)."
    );
  }
}

/** Free reachability probe: one GET to the upstream base URL, no payment, no redirects followed. */
async function probeUpstream(ctx: AppContext, upstreamUrl: string) {
  try {
    await assertUpstreamNotSelf(ctx, upstreamUrl);
  } catch (e) {
    const te = e as TollboothError;
    return { ok: false, error: te.code, message: te.message };
  }
  const url = new URL(normalizeUpstreamUrl(upstreamUrl));
  const started = Date.now();
  try {
    const res = await forwardToUpstream({
      url,
      method: "GET",
      headers: { "user-agent": "MoneySwitch-Tollbooth-Probe/0.5", "x-moneyswitch-probe": "1" },
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: PROBE_MAX_BYTES,
    });
    return {
      ok: true,
      status: res.status,
      latency_ms: Date.now() - started,
      content_type: res.headers.get("content-type"),
      // Any HTTP answer means "reachable"; 5xx is worth a warning in the UI.
      healthy: res.status < 500,
    };
  } catch (e) {
    if (e instanceof UpstreamError) {
      // Big bodies are fine for a probe: the upstream answered.
      if (e.code === "UPSTREAM_TOO_LARGE") return { ok: true, status: 200, latency_ms: Date.now() - started, content_type: null, healthy: true };
      return { ok: false, error: e.code, message: e.message };
    }
    return { ok: false, error: "UPSTREAM_UNREACHABLE", message: e instanceof Error ? e.message : String(e) };
  }
}

function rangeSince(range: string | undefined): string | undefined {
  if (range === "today") return startOfUtcDay();
  if (range === "7d") return new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  return undefined;
}

/** HTTPAdapter for Fastify (the SDK ships Express/Hono/Next adapters; this mirrors ExpressAdapter). */
class FastifyTollAdapter implements HTTPAdapter {
  constructor(
    private req: FastifyRequest,
    private path: string,
    private url: string
  ) {}
  getHeader(name: string): string | undefined {
    const v = this.req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  }
  getMethod(): string {
    return this.req.method;
  }
  getPath(): string {
    return this.path;
  }
  getUrl(): string {
    return this.url;
  }
  getAcceptHeader(): string {
    return this.getHeader("accept") ?? "";
  }
  getUserAgent(): string {
    return this.getHeader("user-agent") ?? "";
  }
  getQueryParams(): Record<string, string | string[]> {
    return (this.req.query ?? {}) as Record<string, string | string[]>;
  }
  getQueryParam(name: string): string | string[] | undefined {
    return this.getQueryParams()[name];
  }
  getBody(): unknown {
    return undefined;
  }
}

const SECURITY_HEADERS = { "content-security-policy": "sandbox", "x-content-type-options": "nosniff" };

export function registerTollboothRoutes(app: FastifyInstance, ctx: AppContext) {
  const adminGuard = requireAdmin(ctx);
  const replay = new ReplayGuard();
  let toll: TollResourceServer | null = null;
  const getToll = (): TollResourceServer => {
    if (!toll) {
      const n = getActiveNetwork();
      toll = createTollResourceServer({
        facilitatorUrl: ctx.config.facilitatorUrl ?? n.facilitatorUrl,
        network: {
          caip2: n.caip2,
          usdcAddress: n.usdcAddress,
          usdcDomainName: n.usdcDomainName,
          usdcDomainVersion: n.usdcDomainVersion,
          label: n.label,
        },
      });
    }
    return toll;
  };

  // ------------------------------------------------------------- admin API

  app.get("/v1/admin/tollbooths", { preHandler: adminGuard }, async (req, reply) => {
    const rows = listTollbooths(ctx.db);
    return reply.send({ tollbooths: rows.map((t) => tollboothView(ctx, req, t, listTollboothRoutes(ctx.db, t.id))) });
  });

  app.get("/v1/admin/tollbooths/:id", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = getTollbooth(ctx.db, id);
    if (!t) return reply.status(404).send({ error: "NOT_FOUND", message: "Toll booth not found" });
    return reply.send(tollboothView(ctx, req, t, listTollboothRoutes(ctx.db, id)));
  });

  app.post("/v1/admin/tollbooths", { preHandler: adminGuard }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      name?: string;
      slug?: string;
      upstream_url?: string;
      pay_to?: string;
      default_price?: string | number | null;
      enabled?: boolean;
      forward_host_header?: boolean;
      description?: string | null;
      routes?: RouteBody[];
    };
    try {
      // pay_to defaults to this MoneySwitch's own wallet (钱包收付一体).
      const payTo = body.pay_to ?? ctx.wallet.getAddress();
      if (!payTo) {
        throw new TollboothError("PAY_TO_REQUIRED", "No receiving address: create the MoneySwitch wallet first, or enter an address you own.");
      }
      await assertUpstreamNotSelf(ctx, String(body.upstream_url ?? ""));
      const routes = Array.isArray(body.routes) ? body.routes.map(parseRouteBody) : [];
      const { tollbooth, routes: rows } = createTollbooth(ctx.db, {
        name: String(body.name ?? ""),
        slug: body.slug,
        upstreamUrl: String(body.upstream_url ?? ""),
        payTo,
        network: getActiveNetwork().caip2,
        enabled: body.enabled ?? true,
        forwardHostHeader: body.forward_host_header === true,
        defaultPrice: body.default_price == null ? null : parsePrice(body.default_price, "default_price"),
        description: body.description ?? null,
        routes,
      });
      writeAudit(ctx.db, "admin", "tollbooth.create", {
        tollboothId: tollbooth.id,
        slug: tollbooth.slug,
        payTo: tollbooth.payTo,
        upstream: tollbooth.upstreamUrl,
      });
      return reply.send(tollboothView(ctx, req, tollbooth, rows));
    } catch (e) {
      return sendTollboothError(reply, e);
    }
  });

  app.patch("/v1/admin/tollbooths/:id", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      name?: string;
      slug?: string;
      upstream_url?: string;
      pay_to?: string;
      default_price?: string | number | null;
      enabled?: boolean;
      forward_host_header?: boolean;
      description?: string | null;
      routes?: RouteBody[];
    };
    try {
      if (body.upstream_url !== undefined) await assertUpstreamNotSelf(ctx, String(body.upstream_url));
      const { tollbooth, routes } = updateTollbooth(ctx.db, id, {
        name: body.name,
        slug: body.slug,
        upstreamUrl: body.upstream_url,
        payTo: body.pay_to,
        enabled: body.enabled,
        forwardHostHeader: body.forward_host_header,
        defaultPrice: body.default_price === undefined ? undefined : body.default_price === null ? null : parsePrice(body.default_price, "default_price"),
        description: body.description,
        routes: Array.isArray(body.routes) ? body.routes.map(parseRouteBody) : undefined,
      });
      writeAudit(ctx.db, "admin", "tollbooth.update", {
        tollboothId: id,
        fields: Object.keys(body),
        ...(body.pay_to !== undefined ? { payTo: tollbooth.payTo } : {}),
      });
      return reply.send(tollboothView(ctx, req, tollbooth, routes));
    } catch (e) {
      return sendTollboothError(reply, e);
    }
  });

  app.delete("/v1/admin/tollbooths/:id", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = getTollbooth(ctx.db, id);
    if (!t) return reply.status(404).send({ error: "NOT_FOUND", message: "Toll booth not found" });
    deleteTollbooth(ctx.db, id);
    writeAudit(ctx.db, "admin", "tollbooth.delete", { tollboothId: id, slug: t.slug });
    return reply.send({ id, deleted: true });
  });

  app.post("/v1/admin/tollbooths/:id/routes", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const row = addTollboothRoute(ctx.db, id, parseRouteBody((req.body ?? {}) as RouteBody));
      writeAudit(ctx.db, "admin", "tollbooth.route_create", { tollboothId: id, routeId: row.id });
      return reply.send(routeView(row));
    } catch (e) {
      return sendTollboothError(reply, e);
    }
  });

  app.patch("/v1/admin/tollbooths/:id/routes/:routeId", { preHandler: adminGuard }, async (req, reply) => {
    const { id, routeId } = req.params as { id: string; routeId: string };
    const b = (req.body ?? {}) as RouteBody;
    try {
      const row = updateTollboothRoute(ctx.db, id, routeId, {
        method: b.method,
        pathPattern: b.path_pattern,
        price: b.price === undefined ? undefined : parsePrice(b.price, "price"),
        description: b.description,
      });
      writeAudit(ctx.db, "admin", "tollbooth.route_update", { tollboothId: id, routeId });
      return reply.send(routeView(row));
    } catch (e) {
      return sendTollboothError(reply, e);
    }
  });

  app.delete("/v1/admin/tollbooths/:id/routes/:routeId", { preHandler: adminGuard }, async (req, reply) => {
    const { id, routeId } = req.params as { id: string; routeId: string };
    if (!deleteTollboothRoute(ctx.db, id, routeId)) return reply.status(404).send({ error: "NOT_FOUND", message: "Rule not found" });
    writeAudit(ctx.db, "admin", "tollbooth.route_delete", { tollboothId: id, routeId });
    return reply.send({ id: routeId, deleted: true });
  });

  app.post("/v1/admin/tollbooths/test-upstream", { preHandler: adminGuard }, async (req, reply) => {
    const { upstream_url } = (req.body ?? {}) as { upstream_url?: string };
    return reply.send(await probeUpstream(ctx, String(upstream_url ?? "")));
  });

  app.post("/v1/admin/tollbooths/:id/test", { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = getTollbooth(ctx.db, id);
    if (!t) return reply.status(404).send({ error: "NOT_FOUND", message: "Toll booth not found" });
    return reply.send(await probeUpstream(ctx, t.upstreamUrl));
  });

  app.get("/v1/admin/earnings", { preHandler: adminGuard }, async (req, reply) => {
    const q = req.query as { tollbooth?: string; range?: string; limit?: string };
    const range = q.range === "today" || q.range === "7d" ? q.range : "all";
    const summary = queryEarnings(ctx.db, {
      tollboothId: q.tollbooth || undefined,
      sinceIso: rangeSince(range),
      limit: q.limit ? Number(q.limit) : 500,
    });
    const routeIndex = new Map<string, TollboothRouteRow>();
    for (const t of listTollbooths(ctx.db)) for (const r of listTollboothRoutes(ctx.db, t.id)) routeIndex.set(r.id, r);
    return reply.send({
      range,
      since: rangeSince(range) ?? null,
      total: formatMicrosToUsdc(summary.total),
      settled_count: summary.settledCount,
      failed_count: summary.failedCount,
      by_tollbooth: summary.byTollbooth.map((b) => ({
        tollbooth_id: b.tollboothId,
        slug: b.slug,
        name: b.name,
        deleted: !getTollbooth(ctx.db, b.tollboothId),
        total: formatMicrosToUsdc(b.total),
        count: b.count,
      })),
      by_route: summary.byRoute.map((b) => {
        const r = b.routeId ? routeIndex.get(b.routeId) : undefined;
        return {
          tollbooth_id: b.tollboothId,
          route_id: b.routeId,
          method: r?.method ?? (b.routeId ? b.method : "ANY"),
          path_pattern: r?.pathPattern ?? null,
          is_default: b.routeId == null,
          total: formatMicrosToUsdc(b.total),
          count: b.count,
        };
      }),
      items: summary.items.map((e) => ({
        id: e.id,
        created_at: e.createdAt,
        tollbooth_id: e.tollboothId,
        tollbooth_slug: e.tollboothSlug,
        tollbooth_name: e.tollboothName,
        route_id: e.routeId,
        method: e.method,
        path: e.path,
        amount: formatMicrosToUsdc(e.amount),
        payer: e.payer,
        tx_hash: e.txHash,
        mock: Boolean(e.txHash && e.txHash.startsWith("0xmock")),
        network: e.network,
        status: e.status,
        upstream_status: e.upstreamStatus,
        error_code: e.errorCode,
      })),
    });
  });

  // --------------------------------------------------------- public proxy

  app.register(async (scope) => {
    // Raw bytes in, raw bytes out: the toll booth never parses bodies.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => done(null, body));

    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      reply.headers(SECURITY_HEADERS);
      const parts = splitTollboothUrl(req.raw.url ?? "");
      if (!parts) return reply.status(404).send({ error: "TOLLBOOTH_NOT_FOUND" });
      const tb = getTollboothBySlug(ctx.db, parts.slug);
      if (!tb || !tb.enabled) {
        return reply.status(404).send({ error: "TOLLBOOTH_NOT_FOUND", message: "No active toll booth at this address." });
      }
      let norm;
      try {
        norm = normalizeRequestPath(parts.rest);
      } catch (e) {
        return reply.status(400).send({ error: "BAD_PATH", message: e instanceof TollPathError ? e.message : "Bad path" });
      }
      const routes = listTollboothRoutes(ctx.db, tb.id);
      const decision = matchRoute(routes, req.method, norm.matchPath, tb.defaultPrice);
      if (decision.kind === "deny") {
        return reply.status(404).send({ error: "NOT_FOR_SALE", message: "This path is not offered by this toll booth." });
      }
      const network = getActiveNetwork();
      if (tb.network !== network.caip2) {
        return reply.status(503).send({ error: "NETWORK_MISMATCH", message: `This toll booth was set up for ${tb.network}, the server now runs ${network.caip2}.` });
      }

      let upstreamUrl: URL;
      try {
        upstreamUrl = joinUpstreamUrl(tb.upstreamUrl, norm.forwardPath, parts.search);
      } catch {
        return reply.status(400).send({ error: "BAD_PATH" });
      }
      // Re-checked per request (DNS can change after the toll booth was saved).
      if (await isSelfTargetResolved(upstreamUrl, ctx.config.port)) {
        return reply.status(502).send({ error: "UPSTREAM_IS_SELF", message: "The toll booth's upstream points at MoneySwitch itself." });
      }

      const base = publicBase(ctx, req);
      const tollPublicBase = `${base}/t/${tb.slug}`;
      const publicResourceUrl = tollPublicBase + norm.forwardPath;
      let baseUrl: URL | null = null;
      try {
        baseUrl = new URL(base);
      } catch {
        baseUrl = null;
      }
      const body = Buffer.isBuffer(req.body) ? (req.body as Buffer) : null;

      const forward = async (payer: string | null, amount: string): Promise<HandlerResult> => {
        const res = await forwardToUpstream({
          url: upstreamUrl,
          method: req.method,
          headers: buildUpstreamRequestHeaders(req.headers, {
            tollbooth: tb.slug,
            payer,
            amount,
            publicHost: baseUrl?.host,
            publicProto: baseUrl?.protocol === "https:" ? "https" : "http",
            clientIp: req.ip,
            forwardHostHeader: tb.forwardHostHeader,
          }),
          body,
        });
        const headers = buildBuyerResponseHeaders(res.headers);
        if (headers["location"]) headers["location"] = rewriteLocation(headers["location"], tb.upstreamUrl, tollPublicBase);
        return { status: res.status, headers, body: res.body };
      };

      if (decision.kind === "free") {
        try {
          const r = await forward(null, "0");
          return reply.status(r.status).headers(r.headers).send(r.body);
        } catch (e) {
          if (e instanceof UpstreamError) {
            return reply.status(statusForUpstreamFailure(e.code)).send({ error: e.code, message: e.message });
          }
          throw e;
        }
      }

      const paymentHeader = (req.headers["payment-signature"] ?? req.headers["x-payment"]) as string | undefined;
      if (paymentHeader && !replay.begin(paymentHeader)) {
        return reply.status(409).send({ error: "PAYMENT_ALREADY_USED", message: "This payment was already used for a request. Sign a new one." });
      }
      let settled = false;
      try {
        const payer = payerFromPaymentHeader(paymentHeader);
        const offer = {
          name: tb.name,
          payTo: tb.payTo,
          price: decision.price,
          network: getToll().network,
          description: decision.route?.description || tb.description || `${tb.name} — ${req.method} ${norm.forwardPath}`,
          resourceUrl: publicResourceUrl,
        };
        const result = await runPaidRequest({
          toll: getToll(),
          route: buildRouteConfig(offer),
          adapter: new FastifyTollAdapter(req, norm.forwardPath, publicResourceUrl + parts.search),
          path: norm.forwardPath,
          method: req.method,
          handler: () => forward(payer, formatUsdc(decision.price)),
        });
        settled = result.outcome === "settled";
        if (result.outcome !== "payment_required" && !(result.outcome === "facilitator_error" && result.upstreamStatus == null)) {
          recordEarning(ctx.db, {
            tollbooth: tb,
            routeId: decision.route?.id ?? null,
            method: req.method,
            path: norm.forwardPath,
            amount: decision.price,
            payer: result.payer ?? payer,
            txHash: result.transaction ?? null,
            network: result.network ?? offer.network.caip2,
            status: settled ? "settled" : "failed",
            upstreamStatus: result.upstreamStatus ?? null,
            errorCode: settled ? null : result.errorReason ?? result.outcome,
          });
        }
        return reply.status(result.status).headers(result.headers).send(result.body);
      } finally {
        if (paymentHeader) replay.end(paymentHeader, settled);
      }
    };

    scope.route({ method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], url: "/t/:slug", handler, exposeHeadRoute: false });
    scope.route({ method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], url: "/t/:slug/*", handler, exposeHeadRoute: false });
  });
}
