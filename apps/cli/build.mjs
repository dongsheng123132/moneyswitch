import { build } from "esbuild";
import { rmSync, mkdirSync, readdirSync, renameSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(__dirname, "dist");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir,
  sourcemap: false,
  logLevel: "info",
};

// dist/cli.js: the moneyswitch bin. connect/status/remove logic bundled in;
// "./mcp.js" import left external (a real relative runtime import) so the
// @moneyswitch/mcp bundle is only loaded when `moneyswitch mcp` runs.
await build({
  ...shared,
  entryPoints: [path.join(__dirname, "src/cli.ts")],
  entryNames: "cli",
  external: ["./mcp.js", "./desktop.js", "./sell.js"],
});

// dist/sell.js: `moneyswitch sell` (SPEC-v0.5 §4) — express + the official
// @x402/express/@x402/core/@x402/evm SDK + packages/tollbooth, bundled.
// Express is CommonJS, so give the ESM bundle a real `require` for node
// built-ins. @x402/extensions (bazaar) and @x402/paywall are optional
// runtime-only imports of the SDK that this toll booth never triggers.
await build({
  ...shared,
  entryPoints: [path.join(__dirname, "src/sell.ts")],
  entryNames: "sell",
  external: ["@x402/extensions", "@x402/extensions/*", "@x402/paywall"],
  banner: { js: "import { createRequire as __msCreateRequire } from 'node:module'; const require = __msCreateRequire(import.meta.url);" },
});

// dist/desktop.js: `moneyswitch ui` (SPEC-v0.4 §B), the local desktop console
// server. Lazy-loaded by cli.js; smol-toml is bundled in.
await build({
  ...shared,
  entryPoints: [path.join(__dirname, "src/desktop.ts")],
  entryNames: "desktop",
});

// dist/ui/: the console's browser app (React bundled, no CDN, CSP 'self').
const uiDir = path.join(outdir, "ui");
mkdirSync(uiDir, { recursive: true });
await build({
  entryPoints: [path.join(__dirname, "src/desktop/web/main.tsx")],
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "esm",
  outfile: path.join(uiDir, "app.js"),
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "info",
});
copyFileSync(path.join(__dirname, "src/desktop/web/index.html"), path.join(uiDir, "index.html"));

// dist/mcp.js: @moneyswitch/mcp (Apache-2.0) bundled standalone, including
// @modelcontextprotocol/sdk and zod so the published package has ~0 runtime
// npm dependencies.
await build({
  ...shared,
  entryPoints: [path.join(__dirname, "src/mcp-bin.ts")],
  entryNames: "mcp",
});

// pack/moneyswitch.tgz: the same tarball "npm publish" would upload, served by
// the MoneySwitch server at GET /dl/moneyswitch.tgz so the Dashboard's one-line
// "npx -y --package=<server>/dl/moneyswitch.tgz moneyswitch connect ..." works
// before (and without) an npm release. --ignore-scripts: prepack would re-run
// this very build. Kept outside dist/ so it never ends up inside the package.
const packDir = path.join(__dirname, "pack");
rmSync(packDir, { recursive: true, force: true });
mkdirSync(packDir, { recursive: true });
execSync(`npm pack --ignore-scripts --silent --pack-destination "${packDir}"`, {
  cwd: __dirname,
  stdio: ["ignore", "ignore", "inherit"],
});
const packed = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
if (!packed) throw new Error("npm pack produced no tarball");
renameSync(path.join(packDir, packed), path.join(packDir, "moneyswitch.tgz"));

console.log("built dist/cli.js + dist/mcp.js + dist/desktop.js + dist/sell.js + dist/ui/ + pack/moneyswitch.tgz");
