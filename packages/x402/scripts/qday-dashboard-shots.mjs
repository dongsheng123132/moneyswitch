#!/usr/bin/env node
/**
 * Screenshot the MoneySwitch dashboard through the Chrome DevTools Protocol, in ONE browser session.
 *
 * Why not `chrome --screenshot`: the dashboard keeps the admin token in `sessionStorage`, which dies with the browser
 * process — a second `--screenshot` invocation lands on the login page. Here a single tab is navigated: first the
 * one-time sign-in link (which writes the token), then each page, capturing along the way.
 *
 *   node packages/x402/scripts/qday-dashboard-shots.mjs --port 9223 --base http://127.0.0.1:4030 \
 *        --login 'http://127.0.0.1:4030/login#ms_setup_…' --out docs/qday/media
 *
 * When the data directory is no longer on its first boot there is no one-time link any more (the server prints the admin
 * token exactly once, ever), so pass the token in instead and let this script write it into sessionStorage:
 *
 *   ... --token ms_admin_… --suffix -live     # → docs/qday/media/dashboard-bills-live.png, …
 *
 * Requires a Chrome started with `--remote-debugging-port=<port>` (the caller does that).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith("--")) acc.push([arg.slice(2), all[i + 1]]);
    return acc;
  }, [])
);
const PORT = Number(args.port ?? 9223);
const BASE = (args.base ?? "http://127.0.0.1:4030").replace(/\/$/, "");
const LOGIN = args.login;
const OUT = args.out ?? ".";
const PAGES = (args.pages ?? "/wallet,/keys,/bills").split(",").map((p) => p.trim()).filter(Boolean);
const WIDTH = Number(args.width ?? 1440);
const HEIGHT = Number(args.height ?? 1000);
// The one-time sign-in link only exists on the very first boot of a data directory. On every later boot the server prints
// nothing, so the admin token has to be handed in (and written into sessionStorage by hand) instead.
const TOKEN = args.token ?? "";
// Appended to the file name, e.g. "-live", so screenshots of the real testnet don't overwrite the fork ones.
const SUFFIX = args.suffix ?? "";
// A CSS selector clicked on every page after it loads (e.g. ".bills-detail-button", so the bill's on-chain transaction
// hash is visible in the screenshot instead of hidden behind "view details"). Pages without a match are untouched.
const CLICK = args.click ?? "";
// Scrolled to the centre after the click, so the part that expands below the fold lands inside the screenshot
// (e.g. ".bills-detail-row" — the bill's transaction hash lives down there).
const SCROLL = args.scroll ?? "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserSocket() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const body = await res.json();
      if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
    } catch {
      /* chrome still starting */
    }
    await sleep(250);
  }
  throw new Error(`no DevTools endpoint on :${PORT}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? "")})`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

async function main() {
  const wsUrl = await browserSocket();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const cdp = new Cdp(ws);

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);

  const loaded = () =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 4000);
      const handler = () => {
        clearTimeout(timer);
        resolve();
      };
      cdp.listeners.get("Page.loadEventFired")?.push(handler);
    });

  async function navigate(url, settleMs = 1800) {
    const wait = loaded();
    await cdp.send("Page.navigate", { url }, sessionId);
    await wait;
    await sleep(settleMs); // SPA data fetch
  }

  async function shot(name) {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const path = join(OUT, name);
    writeFileSync(path, Buffer.from(data, "base64"));
    console.log(`  ${path}`);
  }

  // 1. the admin token must be in sessionStorage for this origin before the first page load
  if (TOKEN) {
    // Land on the origin once (the login page or the app — either way the origin is right), write the token, then reload.
    await navigate(BASE, 1200);
    await cdp.send(
      "Runtime.evaluate",
      { expression: `sessionStorage.setItem("moneyswitch_admin_token", ${JSON.stringify(TOKEN)}); sessionStorage.length`, returnByValue: true },
      sessionId
    );
  } else {
    // The one-time sign-in link (first boot only) writes the admin token into sessionStorage by itself.
    await navigate(LOGIN, 2500);
  }
  const state = await cdp.send(
    "Runtime.evaluate",
    {
      expression:
        "JSON.stringify({ token: !!sessionStorage.getItem('moneyswitch_admin_token'), url: location.hash.length > 0 ? 'hash' : '' })",
      returnByValue: true,
    },
    sessionId
  );
  console.log(`  signed in: ${state.result?.value ?? "unknown"}`);

  // 2. each page in the same tab, so the session survives
  for (const page of PAGES) {
    await navigate(`${BASE}${page}`, 2200);
    if (CLICK) {
      const clicked = await cdp.send(
        "Runtime.evaluate",
        {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(CLICK)}); if (!el) return "no match"; el.click(); return "clicked"; })()`,
          returnByValue: true,
        },
        sessionId
      );
      console.log(`  ${page} · click ${CLICK}: ${clicked.result?.value ?? "unknown"}`);
      await sleep(1200); // let the expanded row render
      if (SCROLL) {
        await cdp.send(
          "Runtime.evaluate",
          { expression: `(() => { const el = document.querySelector(${JSON.stringify(SCROLL)}); if (!el) return "no match"; el.scrollIntoView({ block: "nearest" }); return "scrolled"; })()`, returnByValue: true },
          sessionId
        );
        await sleep(700);
      }
    }
    const name = `dashboard-${page.replace(/^\//, "").replace(/\//g, "-")}${SUFFIX}.png`;
    await shot(name);
  }

  await cdp.send("Target.closeTarget", { targetId });
  ws.close();
}

main().catch((error) => {
  console.error(`✗ dashboard screenshots failed: ${error?.message ?? error}`);
  process.exit(1);
});
