#!/usr/bin/env node
// Publish only these six public article sources. Never copy internal launch notes.
// The Markdown is byte-for-byte identical to docs/blog, including absolute image URLs.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTICLES = [
  'cloud-wallet-for-ai-bots.md',
  'cloud-wallet-for-ai-bots.zh.md',
  'one-wallet-many-agents.md',
  'one-wallet-many-agents.zh.md',
  'agent-wallet-trial.md',
  'agent-wallet-trial.zh.md',
];
const OUTPUT = path.join(ROOT, 'site', 'media', 'articles');
const checkOnly = process.argv.includes('--check');

async function main() {
  // Validate every input before writing any output.
  const sources = await Promise.all(ARTICLES.map(async (name) => {
    const bytes = await readFile(path.join(ROOT, 'docs', 'blog', name));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      if (!match[1].startsWith('https://moneyswitch.dev/')) {
        throw new Error(`${name}: article image must use an absolute moneyswitch.dev URL`);
      }
    }
    return { name, bytes };
  }));

  if (!checkOnly) await mkdir(OUTPUT, { recursive: true });
  for (const { name, bytes } of sources) {
    const destination = path.join(OUTPUT, name);
    if (checkOnly) {
      const published = await readFile(destination);
      if (!published.equals(bytes)) throw new Error(`${name}: downloadable article is stale; run node scripts/build-media.mjs`);
      continue;
    }
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, bytes);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, mode: checkOnly ? 'check' : 'build', articles: ARTICLES })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
