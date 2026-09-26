#!/usr/bin/env node
/**
 * Research harness for docs/desktop-agents.md (SPEC-v0.4 §B "实现前必须用本机
 * 真实版本核实格式").
 *
 * Writes model + MCP config into a THROWAWAY home directory, then asks the real,
 * locally installed `claude` / `codex` binaries to read it back:
 *   - `claude -p` / `codex exec` are pointed at a local mock model server, which
 *     records the path, auth header and model name each tool actually sends;
 *   - `claude mcp list|get`, `codex mcp list --json`, `codex doctor --json`
 *     confirm the MCP entries are recognised.
 *
 * Isolation: every child runs with a hand-built env (no inherited CLAUDE_* /
 * ANTHROPIC_* / OPENAI_* / proxy vars), HOME=USERPROFILE=<tmp>,
 * APPDATA/LOCALAPPDATA under <tmp>, CODEX_HOME=<tmp>/.codex. The real
 * ~/.claude*, ~/.codex are never passed to or written by this script.
 *
 * Usage: node apps/cli/scripts/verify-agent-formats.mjs [outDir]
 *        (default outDir: .data/desktop/research)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const out = path.resolve(process.argv[2] ?? path.join(repo, ".data/desktop/research"));
// A fresh home per run (a previous run's child may still hold files on Windows).
const home = path.join(out, `home-${Date.now()}`);
for (const d of [home, path.join(home, ".claude"), path.join(home, ".codex"), path.join(home, "AppData/Roaming"), path.join(home, "AppData/Local"), path.join(home, "tmp"), path.join(home, "work")]) {
  fs.mkdirSync(d, { recursive: true });
}

const requests = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {}
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers["authorization"] ? String(req.headers["authorization"]).replace(/(Bearer .{20}).*/, "$1…") : null,
      x_api_key: req.headers["x-api-key"] ? String(req.headers["x-api-key"]).slice(0, 8) + "…" : null,
      model: json?.model ?? null,
      stream: json?.stream ?? null,
    });
    if (req.url.startsWith("/anthropic/v1/messages")) {
      if (json?.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
        ev("message_start", { message: { id: "msg_mock", type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "MOCK_OK" } });
        ev("content_block_stop", { index: 0 });
        ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
        ev("message_stop", {});
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "msg_mock", type: "message", role: "assistant", model: json?.model, content: [{ type: "text", text: "MOCK_OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    }
    if (req.url.startsWith("/openai/v1/responses")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      const item = { type: "message", id: "msg_mock", role: "assistant", status: "completed", content: [{ type: "output_text", text: "MOCK_OK", annotations: [] }] };
      ev("response.created", { response: { id: "resp_mock", model: json?.model, status: "in_progress" } });
      ev("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      ev("response.output_text.delta", { output_index: 0, content_index: 0, item_id: "msg_mock", delta: "MOCK_OK" });
      ev("response.output_item.done", { output_index: 0, item });
      ev("response.completed", { response: { id: "resp_mock", model: json?.model, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
      return res.end();
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const mockBase = `http://127.0.0.1:${port}`;

function isolatedEnv() {
  const keep = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: path.parse(home).root.replace(/\\$/, ""),
    HOMEPATH: home.slice(2),
    APPDATA: path.join(home, "AppData/Roaming"),
    LOCALAPPDATA: path.join(home, "AppData/Local"),
    TEMP: path.join(home, "tmp"),
    TMP: path.join(home, "tmp"),
    CODEX_HOME: path.join(home, ".codex"),
    NO_PROXY: "127.0.0.1,localhost",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    MS_FAKE_OPENAI_KEY: "sk-fake-codex-envkey-0000",
  });
  return env;
}

// Async on purpose: the mock model server lives in this same event loop, so a
// blocking spawnSync would deadlock the very request we want to observe.
// Prompts/args are single tokens so shell:true (needed for .cmd shims on
// Windows) never re-splits them.
function run(label, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: isolatedEnv(), cwd: path.join(home, "work"), shell: process.platform === "win32" });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(opts.input ?? "");
    const timer = setTimeout(() => { stderr += " [harness] timeout, killed"; child.kill(); }, opts.timeout ?? 90_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      const rec = { label, cmd: [cmd, ...args].join(" "), status, stdout: stdout.slice(0, 40000), stderr: stderr.slice(0, 2000) };
      results.push(rec);
      resolve(rec);
    });
  });
}
const results = [];

// ---- versions -------------------------------------------------------------
await run("claude --version", "claude", ["--version"]);
await run("codex --version", "codex", ["--version"]);

// ---- Claude Code: settings.json env ----------------------------------------
const claudeSettings = {
  env: {
    ANTHROPIC_BASE_URL: `${mockBase}/anthropic`,
    ANTHROPIC_AUTH_TOKEN: "sk-fake-claude-authtoken-0000",
    ANTHROPIC_MODEL: "claude-sonnet-4-5",
  },
};
fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify(claudeSettings, null, 2));
const before = requests.length;
await run("claude -p (settings.json env -> mock)", "claude", ["-p", "OK"], { timeout: 120_000 });
const claudeReqs = requests.slice(before);

// ---- Claude Code: mcp add -s user ------------------------------------------
await run("claude mcp add -s user", "claude", ["mcp", "add", "moneyswitch", "-s", "user", "-e", "MONEY_API_BASE=http://127.0.0.1:9", "-e", "MONEY_API_KEY=mk_live_fake", "--", "node", "-e", "0"]);
await run("claude mcp get moneyswitch", "claude", ["mcp", "get", "moneyswitch"]);
const claudeJsonPath = path.join(home, ".claude.json");
const claudeJson = fs.existsSync(claudeJsonPath) ? JSON.parse(fs.readFileSync(claudeJsonPath, "utf8")) : null;

// ---- Codex: config.toml ----------------------------------------------------
const toml = `model = "mock-codex-model"
model_provider = "moneyswitch_brain"

[model_providers.moneyswitch_brain]
name = "MoneySwitch brain (mock)"
base_url = "${mockBase}/openai/v1"
wire_api = "responses"
experimental_bearer_token = "sk-fake-codex-bearer-0000"

[model_providers.moneyswitch_envkey]
name = "env_key variant"
base_url = "${mockBase}/openai/v1"
wire_api = "responses"
env_key = "MS_FAKE_OPENAI_KEY"

[mcp_servers.moneyswitch]
command = "node"
args = ["-e", "0"]

[mcp_servers.moneyswitch.env]
MONEY_API_BASE = "http://127.0.0.1:9"
MONEY_API_KEY = "mk_live_fake"
`;
fs.writeFileSync(path.join(home, ".codex/config.toml"), toml);
await run("codex mcp list --json", "codex", ["mcp", "list", "--json"]);
const doctor = await run("codex doctor --json", "codex", ["doctor", "--json"]);
let doctorChecks = null;
try {
  doctorChecks = Object.fromEntries(Object.entries(JSON.parse(doctor.stdout).checks ?? {}).map(([k, v]) => [k, `${v.status}: ${v.summary}`]));
} catch {}
await run("codex --strict-config mcp list", "codex", ["--strict-config", "mcp", "list"]);
const b2 = requests.length;
await run("codex exec (experimental_bearer_token)", "codex", ["exec", "--skip-git-repo-check", "OK"], { timeout: 120_000 });
const codexReqs = requests.slice(b2);
const b3 = requests.length;
await run("codex exec (env_key)", "codex", ["exec", "--skip-git-repo-check", "-c", "model_provider=moneyswitch_envkey", "OK"], { timeout: 120_000 });
const codexEnvReqs = requests.slice(b3);
const b4 = requests.length;
fs.writeFileSync(path.join(home, ".codex/config.toml"), toml.replace('wire_api = "responses"', 'wire_api = "chat"'));
await run("codex exec (wire_api=chat)", "codex", ["exec", "--skip-git-repo-check", "OK"], { timeout: 60_000 });
const codexChatReqs = requests.slice(b4);
fs.writeFileSync(path.join(home, ".codex/config.toml"), toml);

server.close();
const report = {
  generated_at: new Date().toISOString(),
  isolated_home: home,
  mock_base: mockBase,
  claude: {
    model_requests: claudeReqs,
    user_mcp_servers_in_isolated_claude_json: claudeJson ? Object.keys(claudeJson.mcpServers ?? {}) : null,
  },
  codex: { doctor_checks: doctorChecks, bearer_token_requests: codexReqs, env_key_requests: codexEnvReqs, wire_api_chat_requests: codexChatReqs },
  commands: results,
};
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ claude: report.claude, codex: report.codex, statuses: results.map((r) => [r.label, r.status]) }, null, 2));
