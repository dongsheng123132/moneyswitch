#!/usr/bin/env node
/**
 * SPEC-v0.4 §C-B end-to-end walkthrough of `moneyswitch ui`, driven by
 * Playwright, entirely inside a throwaway home:
 *
 *   start ui -> log in with the one-time token -> paste the employee key ->
 *   cut a child key for Claude Code and for Codex + configure a (fake) model ->
 *   enable (diff, confirm) -> check written files + backups + that the REAL
 *   claude/codex binaries recognise them -> external edit shows "drifted" ->
 *   disable -> originals restored -> one-click "enable all" -> disable again.
 *
 * Isolation: the console and every claude/codex child process run with
 * HOME/USERPROFILE/APPDATA/LOCALAPPDATA/CODEX_HOME = <repo>/.data/desktop/home
 * and none of this shell's CLAUDE_* / ANTHROPIC_* / proxy variables.
 *
 * Env:
 *   MS_SERVER   MoneySwitch server URL (default http://127.0.0.1:18420)
 *   MS_KEY      employee MoneyKey with can_delegate (default: .data/desktop/employee-key.txt)
 *   UI_PORT     console port (default 18431)
 *   PLAYWRIGHT_FROM  dir whose node_modules has playwright (default .data/walkthrough)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = path.join(repo, ".data", "desktop");
const home = path.join(dataDir, "home");
const shots = path.join(dataDir, "shots");
const SERVER = process.env.MS_SERVER ?? "http://127.0.0.1:18420";
const KEY = process.env.MS_KEY ?? fs.readFileSync(path.join(dataDir, "employee-key.txt"), "utf8").trim();
const UI_PORT = Number(process.env.UI_PORT ?? 18431);
const require = createRequire(path.join(process.env.PLAYWRIGHT_FROM ?? path.join(repo, ".data", "walkthrough"), "package.json"));
const { chromium } = require("playwright");

const log = [];
const note = (step, data) => {
  log.push({ step, ...data });
  console.log(`[e2e] ${step}${data ? " " + JSON.stringify(data).slice(0, 400) : ""}`);
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
};

// ------------------------------------------------------------------ home
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(shots, { recursive: true, force: true });
for (const d of [".claude", ".codex", "AppData/Roaming", "AppData/Local", "tmp", "work"]) fs.mkdirSync(path.join(home, d), { recursive: true });
fs.mkdirSync(shots, { recursive: true });

// Realistic pre-existing configs, so the diff has something to preserve.
const ORIG = {
  settings: JSON.stringify({ env: { DISABLE_TELEMETRY: "1" }, permissions: { allow: ["Bash(git status)"] }, theme: "dark" }, null, 2) + "\n",
  claudeJson: JSON.stringify({ numStartups: 12, hasCompletedOnboarding: true, mcpServers: {} }, null, 2) + "\n",
  codex: `model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n\n[projects.'C:\\work\\demo']\ntrust_level = "trusted"\n\n[mcp_servers.filesystem]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-filesystem", "C:/work"]\n`,
};
const settingsFile = path.join(home, ".claude", "settings.json");
const claudeJsonFile = path.join(home, ".claude.json");
const codexFile = path.join(home, ".codex", "config.toml");
fs.writeFileSync(settingsFile, ORIG.settings);
fs.writeFileSync(claudeJsonFile, ORIG.claudeJson);
fs.writeFileSync(codexFile, ORIG.codex);

function isolatedEnv(extra = {}) {
  const keep = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "USERNAME", "USERDOMAIN"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TEMP: path.join(home, "tmp"),
    TMP: path.join(home, "tmp"),
    CODEX_HOME: path.join(home, ".codex"),
    NO_PROXY: "127.0.0.1,localhost",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...extra,
  };
}

// --------------------------------------------------- mock model provider
// Anthropic-compatible endpoint for the Claude "brain" so `claude -p` can be
// run against what the console wrote. Records what the real CLI sends.
const modelRequests = [];
const modelServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let j = null;
    try {
      j = JSON.parse(body);
    } catch {}
    modelRequests.push({ url: req.url, auth: String(req.headers.authorization ?? "").slice(0, 22), model: j?.model ?? null });
    if (!req.url.includes("/v1/messages")) {
      res.writeHead(404);
      return res.end();
    }
    if (j?.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "MOCK_BRAIN_OK" } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
      ev("message_stop", {});
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: j?.model, content: [{ type: "text", text: "p" }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
await new Promise((r) => modelServer.listen(0, "127.0.0.1", r));
const MOCK_ANTHROPIC = `http://127.0.0.1:${modelServer.address().port}/anthropic`;

// ------------------------------------------------------------ start ui
const cli = path.join(repo, "apps", "cli", "dist", "cli.js");
const ui = spawn(process.execPath, [cli, "ui", "--no-open", "--port", String(UI_PORT)], { env: isolatedEnv(), cwd: path.join(home, "work") });
let uiOut = "";
ui.stderr.on("data", (d) => (uiOut += d));
const link = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`ui did not start: ${uiOut}`)), 20000);
  ui.stdout.on("data", (d) => {
    uiOut += d;
    const m = /(http:\/\/127\.0\.0\.1:\d+\/#[A-Za-z0-9_-]+)/.exec(uiOut);
    if (m) {
      clearTimeout(t);
      resolve(m[1]);
    }
  });
});
note("ui started", { port: UI_PORT, stdoutMasked: uiOut.replace(/#[A-Za-z0-9_-]+/, "#<token>").trim() });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark", locale: "zh-CN" });
await context.addInitScript(() => localStorage.getItem("moneyswitch_lang") || localStorage.setItem("moneyswitch_lang", "zh"));
const page = await context.newPage();
page.on("pageerror", (e) => note("pageerror", { message: e.message }));
let shotNo = 0;
const shot = async (name, opts = {}) => {
  const file = path.join(shots, `${String(++shotNo).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? true });
  note("screenshot", { file: path.relative(repo, file) });
};
const card = (id) => page.getByTestId(`card-${id}`);
const waitToast = async (re) => {
  await page.getByTestId("toast").filter({ hasText: re }).first().waitFor({ timeout: 30000 });
};

try {
  // 1. login -------------------------------------------------------------
  await page.goto(link);
  await page.getByTestId("account-card").waitFor();
  assert(!page.url().includes("#"), "token removed from the address bar");
  await shot("login-ok-empty-account");

  // a second use of the same link must fail
  const p2 = await context.newPage();
  const ctx2 = await browser.newContext({ locale: "zh-CN", colorScheme: "dark" });
  const other = await ctx2.newPage();
  await other.addInitScript(() => localStorage.setItem("moneyswitch_lang", "zh"));
  await other.goto(link);
  await other.getByTestId("login-failed").waitFor();
  await other.screenshot({ path: path.join(shots, `${String(++shotNo).padStart(2, "0")}-link-reuse-refused.png`) });
  note("reused link refused", { ok: true });
  await ctx2.close();
  await p2.close();

  // 2. account -----------------------------------------------------------
  await page.getByTestId("account-server").fill(SERVER);
  await page.getByTestId("account-key").fill(KEY);
  await page.getByTestId("account-connect").click();
  await page.getByTestId("account-key-masked").waitFor();
  await page.getByTestId("account-remaining-today").filter({ hasText: "$" }).waitFor();
  await page.waitForTimeout(500);
  await shot("account-connected");
  const storePath = path.join(home, ".moneyswitch", "desktop.json");
  assert(fs.existsSync(storePath), "desktop.json written in the isolated home");
  const acl = spawnSync("icacls", [storePath], { encoding: "utf8" }).stdout.trim();
  note("desktop.json ACL", { acl: acl.replace(home, "<home>") });

  // 3. Claude Code: wallet (child key) + brain ----------------------------
  const cc = card("claude");
  await cc.getByTestId("child-daily-claude").fill("2.00");
  await cc.getByTestId("child-per-claude").fill("0.50");
  await cc.getByTestId("child-total-claude").fill("20.00");
  await cc.getByTestId("child-create-claude").click();
  await cc.getByTestId("wallet-key-claude").waitFor();
  await cc.getByRole("radio", { name: "自定义" }).click();
  await cc.locator('input[placeholder="https://…"]').fill(MOCK_ANTHROPIC);
  await cc.getByTestId("brain-key-claude").fill("sk-fake-claude-e2e-0000000000");
  await cc.getByTestId("brain-model-claude").fill("claude-sonnet-4-5");
  await cc.getByRole("button", { name: "测试连接" }).click();
  await cc.getByTestId("brain-test-claude").waitFor({ timeout: 30000 });
  await cc.getByTestId("brain-save-claude").click();
  await cc.getByText("已保存").first().waitFor();
  await cc.scrollIntoViewIfNeeded();
  await shot("claude-configured");

  // 4. Codex: wallet (child key) + brain with a fake OpenAI key (test fails) --
  const cx = card("codex");
  await cx.getByTestId("child-daily-codex").fill("1.50");
  await cx.getByTestId("child-per-codex").fill("0.25");
  await cx.getByTestId("child-total-codex").fill("15.00");
  await cx.getByTestId("child-create-codex").click();
  await cx.getByTestId("wallet-key-codex").waitFor();
  await cx.getByTestId("brain-key-codex").fill("sk-fake-openai-e2e-0000000000");
  await cx.getByTestId("brain-model-codex").fill("gpt-6-sol");
  await cx.getByRole("button", { name: "测试连接" }).click();
  await cx.getByTestId("brain-test-codex").waitFor({ timeout: 40000 });
  const codexTest = await cx.getByTestId("brain-test-codex").innerText();
  note("codex test connection (fake key, expected to fail)", { text: codexTest });
  await cx.getByTestId("brain-save-codex").click();
  await cx.getByText("已保存").first().waitFor();
  await cx.scrollIntoViewIfNeeded();
  await shot("codex-configured-test-failed");

  // 5. enable Claude Code: diff -> confirm --------------------------------
  await page.getByTestId("toggle-claude").click();
  await page.getByTestId("plan-claude").waitFor();
  await shot("claude-enable-diff", { fullPage: false });
  const claudeDiff = await page.getByTestId("plan-claude").innerText();
  assert(!claudeDiff.includes("sk-fake-claude-e2e-0000000000"), "model key masked in diff");
  assert(!claudeDiff.includes(KEY), "MoneyKey masked in diff");
  await page.getByTestId("diff-confirm").click();
  await waitToast(/Claude Code：已写入/);
  await page.waitForTimeout(300);

  // 6. enable Codex --------------------------------------------------------
  await page.getByTestId("toggle-codex").click();
  await page.getByTestId("plan-codex").waitFor();
  await shot("codex-enable-diff", { fullPage: false });
  await page.getByTestId("diff-confirm").click();
  await waitToast(/Codex：已写入/);
  await page.waitForTimeout(500);
  await shot("both-enabled");

  // 7. files + backups ------------------------------------------------------
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  const claudeJson = JSON.parse(fs.readFileSync(claudeJsonFile, "utf8"));
  const codexText = fs.readFileSync(codexFile, "utf8");
  const bak = (f) => fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith(path.basename(f) + ".bak-"));
  note("written settings.json env", { env: Object.fromEntries(Object.entries(settings.env).map(([k, v]) => [k, /KEY|TOKEN/.test(k) ? String(v).slice(0, 10) + "…" : v])), permissionsKept: JSON.stringify(settings.permissions) });
  const mcpEntry = claudeJson.mcpServers.moneyswitch;
  note("written ~/.claude.json mcpServers.moneyswitch", { command: mcpEntry.command, args: mcpEntry.args, base: mcpEntry.env.MONEY_API_BASE, key: mcpEntry.env.MONEY_API_KEY.slice(0, 12) + "…", numStartupsKept: claudeJson.numStartups });
  note("written config.toml (secrets cut)", { text: codexText.replace(/(mk_live_|sk-)[A-Za-z0-9_-]+/g, "$1…") });
  note("backups", { settings: bak(settingsFile), claudeJson: bak(claudeJsonFile), codex: bak(codexFile) });
  assert(settings.env.ANTHROPIC_BASE_URL === MOCK_ANTHROPIC.replace(/\/+$/, ""), "base url written");
  assert(settings.env.DISABLE_TELEMETRY === "1", "unrelated env kept");
  assert(mcpEntry.env.MONEY_API_KEY !== KEY && mcpEntry.env.MONEY_API_KEY.startsWith("mk_live_"), "claude got a child key, not the parent");
  assert(bak(settingsFile).length === 1 && bak(codexFile).length === 1 && bak(claudeJsonFile).length === 1, "one backup each");
  assert(fs.readFileSync(path.join(path.dirname(codexFile), bak(codexFile)[0]), "utf8") === ORIG.codex, "codex backup = original");

  // 8. the real CLIs read what was written ------------------------------------
  const runReal = (label, cmd, args, timeout = 120000) => {
    const r = spawnSync([cmd, ...args].join(" "), { shell: true, encoding: "utf8", env: isolatedEnv(), cwd: path.join(home, "work"), timeout });
    note(label, { status: r.status, stdout: (r.stdout ?? "").trim().slice(0, 1200), stderr: (r.stderr ?? "").trim().slice(0, 300) });
    return r;
  };
  runReal("claude --version", "claude", ["--version"]);
  runReal("codex --version", "codex", ["--version"]);
  const cget = runReal("claude mcp get moneyswitch (isolated)", "claude", ["mcp", "get", "moneyswitch"]);
  assert(/Scope: User config/.test(cget.stdout), "claude sees the user-scope moneyswitch MCP server");
  const before = modelRequests.length;
  // spawnSync would block this event loop (the mock provider lives here), so run claude -p async.
  const claudeP = await new Promise((resolve) => {
    const c = spawn("claude -p OK", { shell: true, env: isolatedEnv(), cwd: path.join(home, "work") });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => c.kill(), 120000);
    c.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out: out.trim() });
    });
  });
  const seen = modelRequests.slice(before).filter((r) => r.url.includes("/v1/messages"));
  note("claude -p against the written brain", { exit: claudeP.code, output: claudeP.out.slice(0, 200), requestsSeenByMockProvider: seen });
  assert(seen.some((r) => r.auth.startsWith("Bearer sk-fake-claude") && r.model === "claude-sonnet-4-5"), "claude used the written base url / token / model");
  const cml = runReal("codex mcp list --json (isolated)", "codex", ["mcp", "list", "--json"]);
  const list = JSON.parse(cml.stdout);
  const ms = list.find((s) => s.name === "moneyswitch");
  assert(ms && ms.transport.env.MONEY_API_KEY.startsWith("mk_live_") && ms.transport.env.MONEY_API_KEY !== KEY, "codex sees moneyswitch MCP with a child key");
  assert(list.some((s) => s.name === "filesystem"), "codex still sees the user's other MCP server");
  const doc = runReal("codex doctor --json (isolated) config.load", "codex", ["doctor", "--json"]);
  try {
    const checks = JSON.parse(doc.stdout).checks;
    note("codex doctor", { "config.load": checks["config.load"]?.summary, "auth.credentials": checks["auth.credentials"]?.summary, "mcp.config": checks["mcp.config"]?.summary });
  } catch {}

  // 9. external edit -> drifted ---------------------------------------------
  const codexNow = fs.readFileSync(codexFile, "utf8");
  fs.writeFileSync(codexFile, codexNow.replace('model = "gpt-6-sol"', 'model = "edited-by-hand"'));
  await page.reload();
  await card("codex").getByText("配置被外部修改").waitFor();
  await card("codex").scrollIntoViewIfNeeded();
  await shot("codex-drifted");
  fs.writeFileSync(codexFile, codexNow);
  await page.reload();
  await card("codex").getByText("已启用").waitFor();

  // 10. disable both -> originals restored -------------------------------------
  await page.getByTestId("toggle-claude").click();
  await page.getByTestId("plan-claude").waitFor();
  await shot("claude-disable-diff", { fullPage: false });
  await page.getByTestId("diff-confirm").click();
  await waitToast(/Claude Code：已关闭/);
  await page.getByTestId("toggle-codex").click();
  await page.getByTestId("plan-codex").waitFor();
  await page.getByTestId("diff-confirm").click();
  await waitToast(/Codex：已关闭/);
  await page.waitForTimeout(300);
  await shot("both-disabled-restored");
  const restored = {
    settings: fs.readFileSync(settingsFile, "utf8") === ORIG.settings,
    settingsSemantic: JSON.stringify(JSON.parse(fs.readFileSync(settingsFile, "utf8"))) === JSON.stringify(JSON.parse(ORIG.settings)),
    claudeJsonMcpServers: JSON.parse(fs.readFileSync(claudeJsonFile, "utf8")).mcpServers,
    codexBytes: fs.readFileSync(codexFile, "utf8") === ORIG.codex,
  };
  note("after disable", restored);
  assert(restored.settingsSemantic && restored.codexBytes && Object.keys(restored.claudeJsonMcpServers).length === 0, "originals restored");

  // 11. one-click: revoke the old child keys, then enable all -------------------
  for (const id of ["claude", "codex"]) {
    page.once("dialog", (d) => d.accept());
    await card(id).getByRole("button", { name: "撤销并移除" }).click();
    await card(id).getByTestId(`child-create-${id}`).waitFor();
  }
  await page.getByTestId("bulk-preview").click();
  await page.getByTestId("plan-claude").waitFor();
  await shot("bulk-preview-diff", { fullPage: false });
  await page.getByTestId("diff-confirm").click();
  await waitToast(/已写入/);
  await page.waitForTimeout(800);
  await shot("bulk-enabled");
  const st = await page.evaluate(async () => (await fetch("/api/state")).json());
  note("after bulk", { statuses: st.agents.map((a) => [a.id, a.status, a.wallet?.dailyBudget ?? null]) });
  assert(st.agents.find((a) => a.id === "claude").status === "enabled" && st.agents.find((a) => a.id === "codex").status === "enabled", "bulk enabled both");

  // English UI, manual-agent cards --------------------------------------------
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await page.getByText("Agents on this computer").waitFor();
  await page.waitForTimeout(500);
  await shot("bulk-enabled-en");

  // clean up: turn both off again so the isolated home ends as it started
  await page.getByRole("button", { name: "中文", exact: true }).click();
  for (const id of ["claude", "codex"]) {
    await page.getByTestId(`toggle-${id}`).click();
    await page.getByTestId(`plan-${id}`).waitFor();
    await page.getByTestId("diff-confirm").click();
    await waitToast(/已关闭/);
  }
  note("final", {
    codexBytesEqualOriginal: fs.readFileSync(codexFile, "utf8") === ORIG.codex,
    settingsSemanticEqualOriginal: JSON.stringify(JSON.parse(fs.readFileSync(settingsFile, "utf8"))) === JSON.stringify(JSON.parse(ORIG.settings)),
  });

  // CSRF from a page on another origin (same browser, has the cookie? No: SameSite=Strict + Origin check).
  const csrf = await page.evaluate(async (port) => {
    const r = await fetch(`http://localhost:${port}/api/state`, { credentials: "include" }).catch((e) => ({ status: String(e) }));
    return r.status;
  }, UI_PORT);
  note("cross-origin fetch from the page (localhost vs 127.0.0.1)", { status: csrf });
  note("RESULT", { ok: true });
} catch (e) {
  note("RESULT", { ok: false, error: e.message });
  await shot("failure").catch(() => undefined);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(dataDir, "e2e-log.json"), JSON.stringify(log, null, 2));
  await browser.close();
  ui.kill();
  modelServer.close();
}
