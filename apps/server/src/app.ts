import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppContext } from "./context.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerChildKeyRoutes } from "./routes/children.js";
import { registerGatewayRoutes } from "./routes/gateway.js";
import { registerSetupRoutes } from "./routes/setup.js";
import { registerTollboothRoutes } from "./routes/tollbooths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** apps/dashboard/dist, resolved relative to this file (works from both apps/server/src via tsx and apps/server/dist via node). */
function resolveDashboardDist(): string {
  return path.resolve(__dirname, "..", "..", "dashboard", "dist");
}

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      // Never log Authorization headers (would contain mk_live_/ms_admin_
      // secrets), request bodies (may contain password/private key fields),
      // or wallet password env vars.
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.Authorization",
          'req.body.password',
          'req.body.setup_token',
          'req.body["mk_live_"]',
        ],
        censor: "[REDACTED]",
      },
    },
  });

  // Treat an empty body sent with Content-Type: application/json as {} —
  // many clients set the header on bodiless POSTs (approve/revoke), and
  // Fastify's default parser rejects that with a 400.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  app.get("/healthz", async () => ({ ok: true }));

  registerAdminRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerChildKeyRoutes(app, ctx);
  registerGatewayRoutes(app, ctx);
  registerSetupRoutes(app, ctx);
  registerTollboothRoutes(app, ctx);

  const dashboardDist = ctx.config.dashboardDir || resolveDashboardDist();
  const dashboardIndexPath = path.join(dashboardDist, "index.html");
  const dashboardAvailable = fs.existsSync(dashboardIndexPath);

  if (dashboardAvailable) {
    app.register(fastifyStatic, {
      root: dashboardDist,
      prefix: "/",
      // wildcard:true resolves files per request, so a dashboard rebuild
      // (new hashed asset names) is served without restarting the server.
      // Missing files fall through to the SPA-fallback 404 handler below.
      wildcard: true,
    });
    app.log.info(`Dashboard static assets served from ${dashboardDist}`);
  } else {
    app.log.warn(
      `Dashboard build not found at ${dashboardDist} (apps/dashboard/dist) — ` +
        "server will run without the Dashboard UI. Run `pnpm --filter @moneyswitch/dashboard build` to enable it."
    );
  }

  // SPA fallback: any unmatched GET outside /v1 returns the Dashboard's
  // index.html (client-side router takes over) when the build exists.
  // Unmatched routes under /v1 (including unknown methods) always get a
  // JSON 404, never HTML, so API clients never have to sniff content-type.
  app.setNotFoundHandler((req, reply) => {
    // A missing /assets/* file must 404, not return index.html — otherwise the
    // browser gets HTML for a JS module and renders a blank page.
    if (
      req.method === "GET" &&
      !req.url.startsWith("/v1") &&
      !req.url.startsWith("/t/") &&
      !req.url.startsWith("/assets/") &&
      dashboardAvailable
    ) {
      const html = fs.readFileSync(dashboardIndexPath, "utf-8");
      return reply.status(200).type("text/html").send(html);
    }
    return reply.status(404).send({ error: "not_found" });
  });

  return app;
}
