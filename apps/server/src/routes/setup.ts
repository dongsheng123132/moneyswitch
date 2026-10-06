import type { FastifyInstance } from "fastify";
import { writeAudit } from "@moneyswitch/core";
import { getActiveNetwork, getEnabledNetworks, isMainnet, isMainnetNetwork } from "@moneyswitch/x402";
import { getInstalledOutboundProxy, hostPortOf } from "@moneyswitch/net";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth.js";
import { publicBase } from "../public-base.js";

const FAUCET_URL = "https://faucet.circle.com/";

/**
 * First-run sign-in + Dashboard metadata routes.
 *
 * - GET  /v1/setup/status   unauthenticated, returns ONLY whether a one-time setup link is still claimable

 * - POST /v1/setup/claim    unauthenticated, exchanges the one-time setup token (printed to stdout on first boot)
 *                           for the admin token. Single use, 30 min, burns after 10 bad attempts (SetupTokenStore).
 * - GET  /v1/admin/meta     admin only: network facts + the public base URL the skill is written for.
 */
export function registerSetupRoutes(app: FastifyInstance, ctx: AppContext) {
  const adminGuard = requireAdmin(ctx);
  app.get("/v1/setup/status", async (_req, reply) => {
    return reply.header("cache-control", "no-store").send({ setup_link_active: ctx.setup?.isActive() ?? false });
  });

  app.post("/v1/setup/claim", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const body = (req.body ?? {}) as { setup_token?: unknown };
    if (!ctx.setup) return reply.status(410).send({ error: "SETUP_INACTIVE" });
    const result = ctx.setup.claim(body.setup_token);
    if (!result.ok) {
      const status = result.reason === "SETUP_INVALID" ? 403 : 410;
      return reply.status(status).send({ error: result.reason });
    }
    writeAudit(ctx.db, "admin", "setup.claim", {});
    return reply.send({ admin_token: result.adminToken });
  });

  app.get("/v1/admin/meta", { preHandler: adminGuard }, async (req, reply) => {
    const network = getActiveNetwork();
    const chainId = Number(network.caip2.split(":")[1] ?? 0) || null;
    const proxy = getInstalledOutboundProxy();
    return reply.send({
      network: network.caip2,
      networks: getEnabledNetworks().map((n) => ({
        network: n.caip2, chain_id: Number(n.caip2.split(":")[1]), usdc_address: n.usdcAddress,
        network_label: n.label, explorer_base: n.explorerBase, is_mainnet: isMainnetNetwork(n),
      })),
      chain_id: chainId,
      usdc_address: network.usdcAddress,
      explorer_base: network.explorerBase,
      network_label: network.label,
      is_mainnet: isMainnet(),
      // Circle's faucet only mints testnet USDC: offered whenever a testnet is enabled (the page shows it in the testnet group only).
      faucet_url: getEnabledNetworks().some((n) => !isMainnetNetwork(n)) ? FAUCET_URL : null,
      wallet_password_from_env: Boolean(ctx.config.walletPassword),
      // The base URL the skill is written for (MONEYSWITCH_PUBLIC_URL, else the address the server listens on: never the request's Host).
      wallet_address: ctx.wallet.getAddress(),
      public_base: publicBase(ctx),
      public_base_from_env: Boolean(ctx.config.publicUrl),
      // Read-only: host:port + source only, never credentials (see
      // packages/net's redactProxyUrl/hostPortOf and the README "behind a
      // proxy" section).
      outbound_proxy:
        proxy && proxy.url ? { host_port: hostPortOf(proxy.url), source: proxy.source } : { host_port: null, source: proxy?.source ?? "none" },
    });
  });
}
