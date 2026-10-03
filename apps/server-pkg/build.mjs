// Builds the `moneyswitch-server` npm package (AGPL-3.0-only):
//   dist/cli.js      one ESM bundle: apps/server + packages/{core,db,x402,wallet,
//                    tollbooth,mock-facilitator} + apps/demo-seller + fastify,
//                    express, @x402/*, viem, ethers, drizzle… (everything except
//                    the native better-sqlite3, which stays a real dependency so
//                    npm installs its prebuilt binary for the user's platform).
//   dashboard/       copy of apps/dashboard/dist (served as static files).
//   migrations/      copy of packages/db/migrations (*.sql).
// Workspace packages are consumed through their built dist/ (run the root
// `pnpm build` first — it builds this package last).
import { build } from "esbuild";
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8"));
const repo = path.resolve(__dirname, "..", "..");

const dashboardSrc = path.join(repo, "apps", "dashboard", "dist");
const migrationsSrc = path.join(repo, "packages", "db", "migrations");
if (!existsSync(path.join(dashboardSrc, "index.html"))) {
  throw new Error(`Dashboard build missing at ${dashboardSrc} — run \`pnpm --filter @moneyswitch/dashboard build\` first`);
}

for (const d of ["dist", "dashboard", "migrations"]) rmSync(path.join(__dirname, d), { recursive: true, force: true });

await build({
  entryPoints: [path.join(__dirname, "src", "cli.ts")],
  outfile: path.join(__dirname, "dist", "cli.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: true,
  keepNames: true,
  sourcemap: false,
  legalComments: "eof",
  logLevel: "info",
  // Native addon: installed by npm from the registry (prebuilt binaries for
  // win32/darwin/linux x64+arm64), never bundled.
  // @x402/extensions + @x402/paywall: optional runtime-only imports of the
  // x402 SDK that neither the toll booth nor the demo seller ever trigger.
  // pino-pretty: optional fastify logger transport (not used).
  external: ["better-sqlite3", "@x402/extensions", "@x402/extensions/*", "@x402/paywall", "pino-pretty"],
  define: { __MONEYSWITCH_SERVER_VERSION__: JSON.stringify(pkg.version) },
  // Several bundled deps are CommonJS (fastify, express, better-sqlite3's
  // loader…): give the ESM bundle a real `require` for node built-ins.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __msCreateRequire } from 'node:module'; const require = __msCreateRequire(import.meta.url);",
  },
});

cpSync(dashboardSrc, path.join(__dirname, "dashboard"), { recursive: true });
const dashboardIndex = path.join(__dirname, "dashboard", "index.html");
writeFileSync(dashboardIndex, readFileSync(dashboardIndex, "utf8").replace(/\r+\n/g, "\n"));
mkdirSync(path.join(__dirname, "migrations"), { recursive: true });
for (const f of readdirSync(migrationsSrc).filter((f) => f.endsWith(".sql"))) {
  cpSync(path.join(migrationsSrc, f), path.join(__dirname, "migrations", f));
}

console.log(`built moneyswitch-server@${pkg.version}: dist/cli.js + dashboard/ + migrations/`);
