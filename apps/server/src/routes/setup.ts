import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { writeAudit } from "@moneyswitch/core";
import { getActiveNetwork } from "@moneyswitch/x402";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth.js";
import { publicBase } from "./tollbooths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** apps/cli, resolved relative to this file (works from apps/server/src via tsx and apps/server/dist via node). */
function cliDir(): string {
  return path.resolve(__dirname, "..", "..", "..", "cli");
}

export function defaultCliTarballPath(): string {
  return path.join(cliDir(), "pack", "moneyswitch.tgz");
}

const EXPLORER_BASE = "https://testnet.monadvision.com";
const FAUCET_URL = "https://faucet.circle.com/";

/**
 * First-run setup + Dashboard metadata routes (docs/ux-audit.md).
 *
 * - GET  /v1/setup/status   unauthenticated, returns ONLY whether a one-time setup link is still claimable.
 * - POST /v1/setup/claim    unauthenticated, exchanges the one-time setup token (printed to stdout on first boot)
 *                           for the admin token. Single use, 30 min, burns after 10 bad attempts (SetupTokenStore).
 * - GET  /v1/admin/meta     admin only: network facts + demo seller URL + local CLI paths for copy-paste snippets.
 * - GET  /dl/moneyswitch.tgz unauthenticated: the packed Apache-2.0 client CLI (no secrets), so
 *                           `npx -y --package=<server>/dl/moneyswitch.tgz moneyswitch connect …` works without npm publish.
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
    const cliJs = path.join(cliDir(), "dist", "cli.js");
    const mcpJs = path.join(cliDir(), "dist", "mcp.js");
    const tarball = ctx.config.cliTarballPath ?? defaultCliTarballPath();
    return reply.send({
      network: network.caip2,
      chain_id: chainId,
      usdc_address: network.usdcAddress,
      explorer_base: EXPLORER_BASE,
      faucet_url: FAUCET_URL,
      demo_seller_url: ctx.config.demoSellerUrl ?? null,
      cli_tarball_available: fs.existsSync(tarball),
      cli_local_path: fs.existsSync(cliJs) ? cliJs.replace(/\\/g, "/") : null,
      mcp_local_path: fs.existsSync(mcpJs) ? mcpJs.replace(/\\/g, "/") : null,
      wallet_password_from_env: Boolean(ctx.config.walletPassword),
      // v0.5 (SPEC-v0.5 §2): default receiving address for toll booths (the
      // wallet receives and pays) + the base URL buyers use (/t/<slug>/…).
      wallet_address: ctx.wallet.getAddress(),
      public_base: publicBase(ctx, req),
      public_base_from_env: Boolean(ctx.config.publicUrl),
    });
  });

  app.get("/dl/moneyswitch.tgz", async (_req, reply) => {
    const tarball = ctx.config.cliTarballPath ?? defaultCliTarballPath();
    if (!fs.existsSync(tarball)) {
      return reply.status(404).send({ error: "not_found", message: "CLI tarball not built — run `pnpm build`" });
    }
    return reply
      .header("content-type", "application/gzip")
      .header("content-disposition", 'attachment; filename="moneyswitch.tgz"')
      .header("cache-control", "no-cache")
      .send(fs.createReadStream(tarball));
  });
}
