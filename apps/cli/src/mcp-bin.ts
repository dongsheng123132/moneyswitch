/**
 * Thin re-export used purely as a separate esbuild entry point so that
 * `dist/mcp.js` (bundled from @moneyswitch/mcp, Apache-2.0) is only
 * evaluated when `moneyswitch mcp` actually runs, not on every `moneyswitch`
 * invocation. See src/cli.ts.
 */
import "@moneyswitch/mcp";
