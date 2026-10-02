// Regenerates skills/moneyswitch-pay/SKILL.md (the generic, server-agnostic
// copy that can later be published to ClawHub) from the renderer.
//   pnpm --filter @moneyswitch/skill build && pnpm --filter @moneyswitch/skill gen
// test/skill-file.test.ts fails when the committed file drifts from the renderer.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSkill, SKILL_NAME } from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "..", "..", "..", "skills", SKILL_NAME, "SKILL.md");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, renderSkill({}), "utf8");
console.log(`wrote ${out}`);
