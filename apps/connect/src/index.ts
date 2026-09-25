#!/usr/bin/env node
import { runCli } from "./lib/cli.js";

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`moneyswitch-connect: unexpected error: ${(err as Error)?.message ?? err}\n`);
    process.exit(1);
  }
);
