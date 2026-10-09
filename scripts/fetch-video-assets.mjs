#!/usr/bin/env node
// Public release assets only: no credentials, package dependencies or Git LFS.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'site', 'assets', 'video');
const MANIFEST = path.join(OUTPUT, 'manifest.json');
const RELEASE_TAG = 'metropolis-videos-2026-10-09';
const REPOSITORY = 'dongsheng123132/moneyswitch';
const MAX_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DURATION_LIMITS = { 'technical-demo': 180, 'team-pitch': 120 };
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

export function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || manifest.releaseTag !== RELEASE_TAG || !Array.isArray(manifest.videos) || manifest.videos.length !== 2) {
    throw new Error('Manifest must be version 1 with the expected release tag and exactly two videos');
  }
  const ids = new Set();
  const names = new Set();
  for (const video of manifest.videos) {
    if (!video || !Object.hasOwn(DURATION_LIMITS, video.id) || ids.has(video.id)) throw new Error('Video IDs must be technical-demo and team-pitch, each once');
    ids.add(video.id);
    if (typeof video.filename !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,119}\.mp4$/.test(video.filename) || video.filename.includes('..') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(video.filename) || names.has(video.filename)) {
      throw new Error(`${video.id}: filename must be a unique, safe lowercase basename.mp4`);
    }
    names.add(video.filename);
    if (typeof video.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(video.sha256)) throw new Error(`${video.id}: expected a lowercase SHA-256 digest`);
    if (!Number.isSafeInteger(video.bytes) || video.bytes < 1 || video.bytes > MAX_BYTES) throw new Error(`${video.id}: bytes must be between 1 and 256 MiB`);
    if (!Number.isFinite(video.durationSeconds) || video.durationSeconds <= 0 || video.durationSeconds > DURATION_LIMITS[video.id]) throw new Error(`${video.id}: invalid or over-limit durationSeconds`);
    if (![video.width, video.height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 7680)) throw new Error(`${video.id}: width and height must be positive pixel dimensions`);
    const expectedUrl = `https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}/${video.filename}`;
    if (video.url !== expectedUrl) throw new Error(`${video.id}: URL must identify this repository's expected public release asset`);
  }
  return manifest.videos;
}

async function matchesExisting(file, video) {
  let stat;
  try { stat = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${video.filename}: existing asset must be a regular file`);
  if (stat.size !== video.bytes) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex') === video.sha256;
}

function safeDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid release download redirect'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !DOWNLOAD_HOSTS.has(url.hostname)) throw new Error('Release download redirected outside approved HTTPS GitHub hosts');
  return url;
}

async function downloadVerified(video, temporary) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    let url = safeDownloadUrl(video.url);
    let response;
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/octet-stream' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error(`${video.filename}: release redirect limit exceeded or missing Location`);
      url = safeDownloadUrl(new URL(location, url).href);
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`${video.filename}: public download returned HTTP ${response.status}`);
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== video.bytes)) {
      await response.body.cancel();
      throw new Error(`${video.filename}: Content-Length does not match the manifest`);
    }
    let received = 0;
    const hash = createHash('sha256');
    const verify = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > video.bytes) return callback(new Error(`${video.filename}: response exceeded its declared size`));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
    if (received !== video.bytes || hash.digest('hex') !== video.sha256) throw new Error(`${video.filename}: downloaded size or SHA-256 mismatch`);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${video.filename}: download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchVideoAssets(manifest, { outputDirectory = OUTPUT, checkOnly = false } = {}) {
  const videos = validateManifest(manifest);
  await mkdir(outputDirectory, { recursive: true });
  const directory = await lstat(outputDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Video output must be a real directory');
  const staged = [];
  const results = [];
  try {
    for (const video of videos) {
      const destination = path.join(outputDirectory, video.filename);
      if (await matchesExisting(destination, video)) {
        results.push({ filename: video.filename, status: 'verified-existing', bytes: video.bytes });
        continue;
      }
      if (checkOnly) throw new Error(`${video.filename}: asset missing or stale; run node scripts/fetch-video-assets.mjs`);
      const temporary = path.join(outputDirectory, `.${video.filename}.${randomUUID()}.download`);
      staged.push({ temporary, destination });
      await downloadVerified(video, temporary);
      results.push({ filename: video.filename, status: 'downloaded', bytes: video.bytes });
    }
    // Publish to the artifact directory only once every required download passed.
    for (const file of staged) await rename(file.temporary, file.destination);
    return results;
  } finally {
    // Only our own temporary paths are removed; existing assets remain on failure.
    for (const file of staged) await rm(file.temporary, { force: true });
  }
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Usage: node scripts/fetch-video-assets.mjs [--check]');
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const assets = await fetchVideoAssets(manifest, { checkOnly: process.argv.includes('--check') });
  process.stdout.write(`${JSON.stringify({ ok: true, assets })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
