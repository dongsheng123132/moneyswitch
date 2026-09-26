import express, { type Request, type Response, type NextFunction } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { x402HTTPResourceServer } from "@x402/core/server";
import type { HTTPRequestContext, RouteConfig } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import {
  checkPayTo,
  parseUsdc,
  formatUsdc,
  parseRouteSpec,
  normalizeRequestPath,
  matchRoute,
  normalizeUpstreamUrl,
  joinUpstreamUrl,
  buildUpstreamRequestHeaders,
  buildBuyerResponseHeaders,
  rewriteLocation,
  forwardToUpstream,
  UpstreamError,
  statusForUpstreamFailure,
  isSelfTargetResolved,
  createTollResourceServer,
  monadTestnet,
  unpaidBody,
  paywallHtml,
  payerFromPaymentHeader,
  ReplayGuard,
  TollPathError,
  type TollRoute,
  type RouteDecision,
} from "@moneyswitch/tollbooth";

/**
 * `moneyswitch sell` (SPEC-v0.5 §4): a single-process toll booth on your own
 * machine, no MoneySwitch server needed. x402 comes from the official
 * @x402/express middleware (+ @x402/core, @x402/evm) — the same one
 * apps/demo-seller uses; rule matching and forwarding are the exact modules
 * the server's /t/{slug}/* toll booth uses (packages/tollbooth).
 *
 * Settlement semantics come from @x402/express: the payment is verified,
 * the upstream is called, and it is settled ONLY if the upstream answered
 * with a status below 400. On 4xx/5xx the verified payment is cancelled and
 * the buyer pays nothing.
 */

export const SELL_HELP = `moneyswitch sell - put a toll booth in front of your own API (x402, USDC)

Usage:
  moneyswitch sell --upstream <url> --pay-to <0x address> [--price <usdc>]
                   [--route "<METHOD> <path>=<usdc>"]... [--port 4402] [--host 127.0.0.1]
                   [--network testnet] [--facilitator <url>] [--name <text>]
                   [--public-url <url>] [--json]

  --upstream     Your existing service, e.g. http://localhost:8000 (not changed at all).
  --pay-to       PUBLIC receiving address (0x…). Safe to share: it can only receive.
                 Never a MoneyKey (mk_live_…) or a private key — those are refused.
  --price        Price in USDC for every request that matches no --route.
                 Without --price, requests that match no --route are refused (404).
  --route        Price rule, repeatable. Examples:
                   --route "POST /v1/chat/completions=0.01"
                   --route "GET /health=0"        (0 = free pass-through)
                   --route "/files/*=0.05"        (any method, prefix)
                 The most specific rule (longest literal prefix) wins.
  --port/--host  Where the toll booth listens (default 127.0.0.1:4402).
  --network      Only "testnet" (Monad testnet USDC) in v0.5.
  --facilitator  x402 facilitator URL (default: MONEYSWITCH_FACILITATOR_URL or the Monad testnet facilitator).
  --public-url   The address buyers use if it differs from http://<host>:<port> (e.g. behind a tunnel).

Buyers only pay when your service answers 2xx/3xx; errors are never charged.
Exit codes: 0 ok, 1 failure, 2 bad args.`;

export interface SellOptions {
  upstream: string;
  payTo: string;
  /** micro-USDC for unmatched requests; null = refuse. */
  defaultPrice: bigint | null;
  routes: TollRoute[];
  port: number;
  host: string;
  facilitatorUrl: string;
  name: string;
  publicUrl: string | null;
  json: boolean;
}

export type ParseResult = { ok: true; opts: SellOptions } | { ok: false; error: string };

export function parseSellArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParseResult {
  const net = monadTestnet(env);
  let upstream: string | undefined;
  let payTo: string | undefined;
  let price: string | undefined;
  const routeSpecs: string[] = [];
  let port = 4402;
  let host = "127.0.0.1";
  let network = "testnet";
  let facilitatorUrl = net.facilitatorUrl;
  let name = "moneyswitch sell";
  let publicUrl: string | null = null;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 2 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq > 2 ? a.slice(eq + 1) : undefined;
    const next = (): string | undefined => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case "--upstream":
        upstream = next();
        break;
      case "--pay-to":
      case "--payto":
        payTo = next();
        break;
      case "--price":
        price = next();
        break;
      case "--route":
        routeSpecs.push(next() ?? "");
        break;
      case "--port":
        port = Number(next());
        break;
      case "--host":
        host = next() ?? host;
        break;
      case "--network":
        network = next() ?? network;
        break;
      case "--facilitator":
        facilitatorUrl = next() ?? facilitatorUrl;
        break;
      case "--name":
        name = next() ?? name;
        break;
      case "--public-url":
        publicUrl = (next() ?? "").replace(/\/+$/, "") || null;
        break;
      case "--json":
        json = true;
        break;
      default:
        return { ok: false, error: `Unknown option "${a}"` };
    }
  }

  if (!upstream) return { ok: false, error: "--upstream is required (e.g. --upstream http://localhost:8000)" };
  let upstreamNorm: string;
  try {
    upstreamNorm = normalizeUpstreamUrl(upstream);
  } catch (e) {
    return { ok: false, error: `--upstream: ${(e as Error).message}` };
  }
  if (!payTo) return { ok: false, error: "--pay-to is required: the PUBLIC 0x address that receives the money" };
  const pay = checkPayTo(payTo);
  if (!pay.ok) return { ok: false, error: `--pay-to refused: ${pay.message}` };
  if (network !== "testnet") return { ok: false, error: `--network "${network}" is not supported in v0.5 (only "testnet")` };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "--port must be 1-65535" };
  let defaultPrice: bigint | null = null;
  if (price !== undefined) {
    try {
      defaultPrice = parseUsdc(price);
    } catch {
      return { ok: false, error: `--price "${price}" is not a USDC amount like 0.01` };
    }
  }
  const routes: TollRoute[] = [];
  for (const spec of routeSpecs) {
    try {
      routes.push(parseRouteSpec(spec));
    } catch (e) {
      return { ok: false, error: `--route: ${(e as Error).message}` };
    }
  }
  if (defaultPrice == null && routes.length === 0) {
    return { ok: false, error: "Set --price (e.g. --price 0.01) or at least one --route" };
  }
  return {
    ok: true,
    opts: { upstream: upstreamNorm, payTo: pay.address, defaultPrice, routes, port, host, facilitatorUrl, name, publicUrl, json },
  };
}

/** Rule decision for an incoming request (same function the server uses). */
function decide(opts: SellOptions, method: string, rawPath: string): { decision: RouteDecision; forwardPath: string } {
  const norm = normalizeRequestPath(rawPath);
  return { decision: matchRoute(opts.routes, method, norm.matchPath, opts.defaultPrice), forwardPath: norm.forwardPath };
}

function pathOfUrl(u: string): string {
  const q = u.indexOf("?");
  return q === -1 ? u : u.slice(0, q);
}

function describeRules(opts: SellOptions): string[] {
  const lines = opts.routes.map((r) => `${r.method === "ANY" ? "ANY " : r.method + " "}${r.pathPattern} → ${r.price === 0n ? "free" : formatUsdc(r.price) + " USDC"}`);
  lines.push(`everything else → ${opts.defaultPrice == null ? "refused (404)" : opts.defaultPrice === 0n ? "free" : formatUsdc(opts.defaultPrice) + " USDC"}`);
  return lines;
}

export interface SellHandle {
  url: string;
  server: Server;
  close(): Promise<void>;
}

export interface SellLog {
  event: "listening" | "settled" | "not_charged";
  [k: string]: unknown;
}

export async function startSell(opts: SellOptions, log: (entry: SellLog) => void = () => undefined): Promise<SellHandle> {
  const net = monadTestnet();
  const toll = createTollResourceServer({ facilitatorUrl: opts.facilitatorUrl, network: net });
  toll.resourceServer.onAfterSettle(async (c) => {
    const r = c.result as { transaction?: string; payer?: string; network?: string };
    log({ event: "settled", amount: formatUsdc(BigInt(c.requirements.amount)), payer: r.payer ?? null, tx: r.transaction ?? null });
  });
  toll.resourceServer.onVerifiedPaymentCanceled(async (c) => {
    log({ event: "not_charged", amount: formatUsdc(BigInt(c.requirements.amount)), reason: c.reason, upstream_status: c.responseStatus ?? null });
  });

  const offerFor = (ctx: HTTPRequestContext) => {
    const { decision } = decide(opts, ctx.method, ctx.path);
    const price = decision.kind === "paid" ? decision.price : 0n;
    return {
      name: opts.name,
      payTo: opts.payTo,
      price,
      network: net,
      description: (decision.kind === "paid" && decision.route?.description) || `${opts.name} — ${ctx.method} ${ctx.path}`,
    };
  };

  // One catch-all x402 route: the price is chosen per request by our rule
  // matcher (DynamicPrice); free rules are granted without payment through the
  // SDK's own onProtectedRequest hook. Refused paths never reach this point.
  const routeConfig: RouteConfig = {
    accepts: {
      scheme: "exact",
      payTo: opts.payTo,
      network: net.caip2 as `${string}:${string}`,
      price: (ctx) => formatUsdc(offerFor(ctx).price),
    },
    description: `${opts.name} — pay per call`,
    mimeType: "application/json",
    unpaidResponseBody: async (ctx) => ({ contentType: "application/json", body: unpaidBody(offerFor(ctx)) }),
  };
  const httpServer = new x402HTTPResourceServer(toll.resourceServer, { "*": routeConfig });
  httpServer.onProtectedRequest(async (ctx) => {
    const { decision } = decide(opts, ctx.method, ctx.path);
    if (decision.kind === "free") return { grantAccess: true };
    if (decision.kind === "deny") return { abort: true, reason: "NOT_FOR_SALE" };
    return undefined;
  });
  httpServer.registerPaywallProvider({
    generateHtml: (paymentRequired) => {
      const a = paymentRequired.accepts[0];
      return paywallHtml({
        name: opts.name,
        payTo: a?.payTo ?? opts.payTo,
        price: BigInt(a?.amount ?? "0"),
        network: net,
        description: paymentRequired.resource?.description ?? opts.name,
      });
    },
  });

  const replay = new ReplayGuard();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(express.raw({ type: () => true, limit: "10mb" }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("content-security-policy", "sandbox");
    res.setHeader("x-content-type-options", "nosniff");
    try {
      const { decision, forwardPath } = decide(opts, req.method, pathOfUrl(req.originalUrl));
      if (decision.kind === "deny") {
        res.status(404).json({ error: "NOT_FOR_SALE", message: "This path is not offered by this toll booth." });
        return;
      }
      res.locals.toll = { decision, forwardPath };
    } catch (e) {
      res.status(400).json({ error: "BAD_PATH", message: e instanceof TollPathError ? e.message : "Bad path" });
      return;
    }
    const header = req.header("payment-signature") || req.header("x-payment");
    if (header) {
      if (!replay.begin(header)) {
        res.status(409).json({ error: "PAYMENT_ALREADY_USED", message: "This payment was already used for a request. Sign a new one." });
        return;
      }
      res.on("finish", () => replay.end(header, res.statusCode < 400));
    }
    next();
  });
  app.use(paymentMiddlewareFromHTTPServer(httpServer));

  let selfPort = opts.port;
  app.use(async (req: Request, res: Response) => {
    const { decision, forwardPath } = res.locals.toll as { decision: RouteDecision; forwardPath: string };
    const q = req.originalUrl.indexOf("?");
    const search = q === -1 ? "" : req.originalUrl.slice(q);
    const target = joinUpstreamUrl(opts.upstream, forwardPath, search);
    if (await isSelfTargetResolved(target, selfPort)) {
      res.status(502).json({ error: "UPSTREAM_IS_SELF", message: "The upstream points at this toll booth itself." });
      return;
    }
    const publicBase = opts.publicUrl ?? `http://${req.headers.host ?? `${opts.host}:${selfPort}`}`;
    let publicHost: string | undefined;
    try {
      publicHost = new URL(publicBase).host;
    } catch {
      publicHost = undefined;
    }
    const paid = decision.kind === "paid";
    try {
      const up = await forwardToUpstream({
        url: target,
        method: req.method,
        headers: buildUpstreamRequestHeaders(req.headers, {
          tollbooth: opts.name,
          payer: paid ? payerFromPaymentHeader(req.header("payment-signature") || req.header("x-payment")) : null,
          amount: paid ? formatUsdc(decision.price) : "0",
          publicHost,
          publicProto: publicBase.startsWith("https:") ? "https" : "http",
          clientIp: req.socket.remoteAddress ?? undefined,
        }),
        body: Buffer.isBuffer(req.body) ? req.body : null,
      });
      const headers = buildBuyerResponseHeaders(up.headers);
      if (headers["location"]) headers["location"] = rewriteLocation(headers["location"], opts.upstream, publicBase);
      res.status(up.status);
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(up.body);
    } catch (e) {
      if (e instanceof UpstreamError) {
        res.status(statusForUpstreamFailure(e.code)).json({ error: e.code, message: e.message, charged: false });
        return;
      }
      res.status(502).json({ error: "UPSTREAM_ERROR", charged: false });
    }
  });

  // Refuse to start in front of ourselves (upstream == this toll booth).
  if (await isSelfTargetResolved(new URL(opts.upstream), opts.port)) {
    throw new Error(`--upstream ${opts.upstream} points at this toll booth itself (port ${opts.port})`);
  }

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(opts.port, opts.host, () => resolve(s));
    s.on("error", reject);
  });
  selfPort = (server.address() as AddressInfo).port;
  const hostForUrl = opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  const url = opts.publicUrl ?? `http://${hostForUrl}:${selfPort}`;
  log({ event: "listening", url, upstream: opts.upstream, pay_to: opts.payTo, network: net.caip2, rules: describeRules(opts) });
  return {
    url,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const useColor = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const green = (s: string) => (useColor() ? `\x1b[32m${s}\x1b[0m` : s);
const bold = (s: string) => (useColor() ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (useColor() ? `\x1b[2m${s}\x1b[0m` : s);

function printHuman(entry: SellLog): void {
  if (entry.event === "listening") {
    const out = [
      "",
      bold("MoneySwitch toll booth is running"),
      "",
      `  Public address (give this to buyers):  ${green(String(entry.url))}`,
      `  Forwards to (your service, unchanged):  ${entry.upstream}`,
      `  Pay to — ${green("PUBLIC receiving address, safe to share")}:`,
      `    ${green(String(entry.pay_to))}`,
      `  Network: Monad testnet USDC (${entry.network})`,
      "",
      "  Prices:",
      ...(entry.rules as string[]).map((l) => `    ${l}`),
      "",
      dim("  Buyers are only charged when your service answers 2xx/3xx; errors are never charged."),
      dim("  Your MoneyKey (mk_live_…) and private keys are never needed here — never give them to anyone."),
      dim(`  Try it:  curl -i ${entry.url}/`),
      "",
    ];
    process.stdout.write(out.join("\n") + "\n");
    return;
  }
  const ts = new Date().toISOString();
  if (entry.event === "settled") {
    process.stdout.write(`${ts}  + ${entry.amount} USDC  from ${entry.payer ?? "?"}  tx ${entry.tx ?? "?"}\n`);
  } else {
    process.stdout.write(`${ts}  not charged (${entry.amount} USDC): upstream answered ${entry.upstream_status ?? entry.reason}\n`);
  }
}

export async function runSell(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(SELL_HELP + "\n");
    return 0;
  }
  const parsed = parseSellArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`moneyswitch sell: ${parsed.error}\n\nRun "moneyswitch sell --help" for usage.\n`);
    return 2;
  }
  const opts = parsed.opts;
  const log = (e: SellLog) => (opts.json ? process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n") : printHuman(e));
  let handle: SellHandle;
  try {
    handle = await startSell(opts, log);
  } catch (e) {
    process.stderr.write(`moneyswitch sell: ${(e as Error).message}\n`);
    return 1;
  }
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await handle.close();
  return 0;
}
