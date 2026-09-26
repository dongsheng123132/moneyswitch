/**
 * Separate esbuild entry (dist/desktop.js) for `moneyswitch ui` (SPEC-v0.4 §B),
 * loaded lazily by src/cli.ts so the other subcommands never pay for it.
 */
export { runUi, parseUiArgs, UI_HELP } from "./desktop/ui.js";
