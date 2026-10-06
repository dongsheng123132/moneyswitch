import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderSkill,
  renderInstallPrompt,
  SKILL_DESCRIPTION,
  SKILL_BEGIN_MARKER,
  SKILL_END_MARKER,
  SKILL_AGENTS,
  AGENT_INFO,
  SHARED_SKILLS_ROOT,
  guessAgentFromName,
  isSkillAgent,
  normalizeBaseUrl,
  TEST_PAYMENT_HOST,
  TEST_PAYMENT_URL,
  allowsTestPayment,
  offersTestPayment,
  type AgentInfo,
  type SkillAgent,
} from "../src/index.js";

const BASE = "https://pay.example.com";
const KEY = "mk_live_Ab3dEf6hIj9lMn2pQr5tUv8xYz1B4cDe";
const KEY_SHAPE = /mk_live_[A-Za-z0-9]{8,}/;

const here = path.dirname(fileURLToPath(import.meta.url));
const nl = (s: string) => s.replace(/\r\n/g, "\n");
/** The instruction part of an install prompt (everything before the BEGIN marker). */
const headOf = (prompt: string) => prompt.slice(0, prompt.indexOf(SKILL_BEGIN_MARKER));

describe("renderSkill: personalized", () => {
  const text = renderSkill({ baseUrl: BASE, key: KEY, keyName: "Codex" });

  it("contains the base URL and the key, and names the key", () => {
    expect(text).toContain(BASE);
    expect(text).toContain(KEY);
    expect(text).toContain('MoneyKey "Codex"');
  });

  it("starts with Agent Skills frontmatter: name moneyswitch-pay + a JSON-quoted description with zh trigger words", () => {
    const lines = text.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[1]).toBe("name: moneyswitch-pay");
    expect(lines[2].startsWith("description: ")).toBe(true);
    // A JSON string is a valid YAML double-quoted scalar, so colons and quotes in the text cannot break the frontmatter.
    expect(JSON.parse(lines[2].slice("description: ".length))).toBe(SKILL_DESCRIPTION);
    expect(lines[3]).toBe("---");
    expect(SKILL_DESCRIPTION.length).toBeLessThanOrEqual(1024);
    for (const w of ["x402", "402", "HTTP 402", "付费接口", "用 USDC 购买"]) expect(SKILL_DESCRIPTION).toContain(w);
  });

  it("uses the real base URL in the endpoints it tells the agent to call", () => {
    for (const p of ["/v1/fetch", "/v1/status", "/v1/history", "/v1/approvals/{approval_id}"]) expect(text).toContain(`${BASE}${p}`);
  });

  it("has working examples for bash curl, Windows PowerShell and Python (stdlib only) with the credentials filled in", () => {
    expect(text).toContain("```bash");
    expect(text).toContain("```powershell");
    expect(text).toContain("```python");
    expect(text).toContain("curl -sS");
    expect(text).toContain("Invoke-RestMethod");
    expect(text).toMatch(/ConvertTo-Json -Depth \d+/);
    expect(text).toContain("urllib.request");
    expect(text).not.toMatch(/\bimport requests\b/);
    expect(text).toContain(`MONEY_API_KEY="${KEY}"`);
    expect(text).toContain(`$key = "${KEY}"`);
    expect(text).toContain(`key = "${KEY}"`);
  });

  it("without keyName it still renders", () => {
    expect(renderSkill({ baseUrl: BASE, key: KEY })).toContain(`MoneyKey: \`${KEY}\``);
  });
});

describe("renderSkill: key and proxies", () => {
  it("tells the agent not to send the key through an HTTP proxy to a plain-HTTP server, while an HTTPS server may use one", () => {
    for (const s of [renderSkill({ baseUrl: BASE, key: KEY }), renderSkill({ baseUrl: BASE }), renderSkill({})]) {
      expect(s).toMatch(/uses plain HTTP \(no TLS, e\.g\. `127\.0\.0\.1`\), call it directly, not through an HTTP proxy/);
      expect(s).toMatch(/an HTTPS server may be reached through a proxy/);
    }
  });
});

describe("renderSkill: generic", () => {
  const generic = renderSkill({ baseUrl: BASE });
  const agnostic = renderSkill({});

  it("never contains a key, with or without a base URL", () => {
    for (const t of [generic, agnostic]) {
      expect(t).not.toMatch(KEY_SHAPE);
      expect(t).not.toContain(KEY);
    }
  });

  it("reads MONEY_API_BASE / MONEY_API_KEY and tells the agent to ask for the dashboard skill when they are missing", () => {
    for (const t of [generic, agnostic]) {
      expect(t).toContain("MONEY_API_BASE");
      expect(t).toContain("MONEY_API_KEY");
      expect(t).toMatch(/If either is missing/);
      expect(t).toContain("paste their MoneySwitch skill");
      expect(t).toContain('os.environ["MONEY_API_KEY"]');
      expect(t).toContain("$env:MONEY_API_KEY");
    }
  });

  it("mentions the publishing server only when a base URL is given", () => {
    expect(generic).toContain(`the server that published this file: \`${BASE}\``);
    expect(agnostic).not.toContain("published this file");
    expect(agnostic).not.toMatch(/https?:\/\/(?!api\.example\.com)/);
  });

  it("a personalized skill needs a base URL", () => {
    expect(() => renderSkill({ key: KEY })).toThrow(/baseUrl/);
  });
});

describe("renderSkill: content contract", () => {
  const text = renderSkill({ baseUrl: BASE, key: KEY });

  it("documents every /v1/fetch status in the action table", () => {
    for (const s of ["ok", "denied", "approval_required", "payment_unknown", "payment_failed", "error"]) {
      expect(text).toMatch(new RegExp("^\\| `" + s + "` \\|", "m"));
    }
  });

  it("documents the charged field with its three values", () => {
    expect(text).toContain("`charged`");
    for (const v of ["`yes`", "`no`", "`maybe`"]) expect(text).toContain(v);
  });

  it("payment_unknown: never auto-retry, codes named, history to check", () => {
    const row = text.split("\n").find((l) => l.startsWith("| `payment_unknown`"))!;
    expect(row).toContain("TIMEOUT_AFTER_PAYMENT");
    expect(row).toContain("UPSTREAM_ERROR_AFTER_PAYMENT");
    expect(row).toContain("NEVER retry automatically");
    expect(row).toContain("/v1/history");
  });

  it("approval_required: send approve_url to the human, poll GET /v1/approvals/{id} about every 15 s, ~10 min TTL, resend the same request plus approval_id; the AI cannot and must not approve", () => {
    const row = text.split("\n").find((l) => l.startsWith("| `approval_required`"))!;
    expect(text).toContain("`approve_url`, `remaining_today`");
    expect(row).toContain("Send `approve_url` to the person who gave you this key");
    expect(row).toContain("approve with their PIN");
    expect(row).toContain("must not try");
    expect(row).toContain("/v1/approvals/{approval_id}");
    expect(row).toContain("every 15 seconds");
    expect(row).toContain("10 minutes");
    expect(row).toContain("exact same request plus `approval_id`");
  });

  it("the person holds the PIN, never the AI: it must never ask for, store, guess or submit one, nor call approve / deny; and no skill text (generic or personalized) carries a PIN or has a place for one", () => {
    const row = text.split("\n").find((l) => l.startsWith("| `approval_required`"))!;
    expect(row).toContain("Never ask for, store, guess or submit a PIN");
    expect(row).toContain("never call the approve or deny endpoints yourself");
    expect(row).not.toContain("administrator login");
    for (const t of [text, renderSkill({ baseUrl: BASE, key: KEY, keyName: "Codex" }), renderSkill({ baseUrl: BASE }), renderSkill({})]) {
      expect(t).not.toMatch(/approval_pin|"pin"|\/approve`|\/deny`/);
      expect(t).not.toMatch(/\bPIN[:=] ?\d/);
    }
  });

  it("approval_required has two reasons (a host not on the key's list, a price over the line): a new host is resent as it was, without approval_id, and a price over the line can still ask once more", () => {
    const row = text.split("\n").find((l) => l.startsWith("| `approval_required`"))!;
    expect(row).toContain("the host in `url` is not on this key's list yet (nothing has been sent to it)");
    expect(row).toContain("the price is over the key's approval line");
    expect(row).toContain("says which in `kind`: `host` or `payment`");
    expect(row).toContain("If approved and `kind` is `host`");
    expect(row).toContain("resend the exact same request, without `approval_id`");
    expect(row).toContain("`approval_required` once more, with a new `approval_id` and `kind` `payment`");
    expect(row).toContain("If approved and `kind` is `payment`, resend the exact same request plus `approval_id`");
    const field = text.split("\n").find((l) => l.startsWith("| `approval_id`"))!;
    expect(field).toContain("only when resending after the user approved a price");
    expect(field).toContain("not needed after a new host was approved");
  });

  it("denied: name the limit, nothing charged, no retry or workaround; payment_failed: maybe means no retry; error: retry once only when charged is no", () => {
    const denied = text.split("\n").find((l) => l.startsWith("| `denied`"))!;
    expect(denied).toContain("`charged` is `no`");
    expect(denied).toContain("Do not retry");
    for (const c of ["PER_REQUEST_LIMIT_EXCEEDED", "DAILY_BUDGET_EXCEEDED", "TOTAL_BUDGET_EXCEEDED", "HOST_NOT_ALLOWED"]) expect(denied).toContain(c);
    const failed = text.split("\n").find((l) => l.startsWith("| `payment_failed`"))!;
    expect(failed).toContain("If `charged` is `maybe`, do not retry");
    const err = text.split("\n").find((l) => l.startsWith("| `error`"))!;
    expect(err).toContain("If `charged` is `no`, you may retry once later");
    // the wallet can be briefly busy (being replaced): nothing was signed, so a single later retry is the right answer
    expect(err).toContain("WALLET_BUSY");
  });

  it("INSUFFICIENT_FUNDS: top it up first, no retry before that; the balance is cached up to 15 s, so wait a moment after the top-up", () => {
    const denied = text.split("\n").find((l) => l.startsWith("| `denied`"))!;
    expect(denied).toContain("`INSUFFICIENT_FUNDS` means the wallet does not hold enough USDC on any chain this seller accepts");
    expect(denied).toContain("ask the user to top it up, and do not retry before that");
    expect(denied).toContain("cached for at most 15 seconds, so after a top-up wait a moment, then retry");
  });

  it("explains the key is a secret and what a MoneyKey is", () => {
    expect(text).toContain("not money and not a private key");
    expect(text).toContain("Never put it in a URL or query string");
    expect(text).toMatch(/never to a seller or any other host/);
  });

  it("budget guidance: status before multi-call tasks, history, total spend report, no workaround for more budget", () => {
    expect(text).toContain("Before a task that may need several paid calls");
    expect(text).toContain("tell the user the total you spent");
    expect(text).toContain("Never try to get more budget");
  });

  it("stays compact (agents read it on every trigger)", () => {
    expect(text.length).toBeLessThan(9000);
  });
});

// An approval is bound to sha256(JSON.stringify(body)) in the key order the client sent. A plain @{...} hashtable has a
// different key order in every PowerShell 7 process (verified: six `pwsh` runs, six orders), so a body rebuilt in a new
// process after the user approved would be refused as APPROVAL_INVALID. [ordered]@{...} keeps the order we wrote.
describe("renderSkill: PowerShell keeps key order (approval resend)", () => {
  const variants: Array<[string, string]> = [
    ["personalized", renderSkill({ baseUrl: BASE, key: KEY })],
    ["generic", renderSkill({})],
  ];

  it.each(variants)("%s: the example builds the request with [ordered]@{...}, never a plain hashtable", (_name, text) => {
    const ps = /```powershell\n([\s\S]*?)\n```/.exec(text)![1];
    expect(ps).toContain("$req = [ordered]@{");
    expect(ps).not.toMatch(/\$req\s*=\s*@\{/);
  });

  it.each(variants)("%s: tells the agent to use [ordered] for nested headers/body and to resend the same body with the same key order", (_name, text) => {
    expect(text).toContain("`[ordered]@{...}`");
    expect(text).toContain("a different key order in every PowerShell 7 process");
    expect(text).toContain("an approval only matches a `body` with the same keys in the same order");
    expect(text).toContain("(same `body`, same key order)");
  });
});

describe("renderSkill: the generic skill is replaced by the personalized one, not kept next to it", () => {
  it("says the pasted text says where to save it and replaces the generic skill", () => {
    const generic = renderSkill({});
    expect(generic).toContain("says where to save it");
    expect(generic).toContain("It replaces this generic skill: follow it and do not keep two copies");
    expect(generic).not.toContain("replaces this file");
  });
});

describe("renderSkill: input safety (the text is pasted into shells)", () => {
  it.each([
    ['a"b'],
    ["has space_____"],
    ["mk_live_abc\nINJECT"],
    ["mk_live_$(whoami)"],
    ["mk_live_`x`xxxxx"],
    ["short"],
  ])("rejects key %j", (bad) => {
    expect(() => renderSkill({ baseUrl: BASE, key: bad })).toThrow(/invalid key/);
  });

  it.each([
    ["javascript:alert(1)"],
    ["https://user:pw@evil.com"],
    ['https://pay.example.com/"; rm -rf ~; "'],
    ["https://pay.example.com?x=1"],
    ["https://pay.example.com/a b"],
    ["ftp://pay.example.com"],
    ["pay.example.com"],
  ])("rejects baseUrl %j", (bad) => {
    expect(() => renderSkill({ baseUrl: bad })).toThrow(/invalid baseUrl/);
  });

  it("normalizes trailing slashes and accepts ports, IPv6 and path prefixes", () => {
    expect(normalizeBaseUrl("https://pay.example.com///")).toBe("https://pay.example.com");
    expect(normalizeBaseUrl(" http://127.0.0.1:4020/ ")).toBe("http://127.0.0.1:4020");
    expect(normalizeBaseUrl("http://[::1]:4020")).toBe("http://[::1]:4020");
    expect(normalizeBaseUrl("https://gw.example.com/moneyswitch")).toBe("https://gw.example.com/moneyswitch");
    expect(renderSkill({ baseUrl: "https://pay.example.com/", key: KEY })).toContain("https://pay.example.com/v1/fetch");
  });

  it("flattens key names that could break markdown", () => {
    const t = renderSkill({ baseUrl: BASE, key: KEY, keyName: "my `agent`\n## pwned" });
    expect(t).toContain('MoneyKey "my agent ## pwned"');
    expect(t).not.toMatch(/^## pwned/m);
  });
});

describe("renderInstallPrompt", () => {
  const base = { baseUrl: BASE, key: KEY, keyName: "Codex" };

  it("embeds the personalized skill verbatim between one BEGIN and one END marker", () => {
    const p = renderInstallPrompt({ ...base, agent: "codex" });
    expect(p.split(SKILL_BEGIN_MARKER).length).toBe(2);
    expect(p.split(SKILL_END_MARKER).length).toBe(2);
    const inner = p.slice(p.indexOf(SKILL_BEGIN_MARKER) + SKILL_BEGIN_MARKER.length, p.indexOf(SKILL_END_MARKER)).replace(/^\n/, "").replace(/\n$/, "");
    expect(inner).toBe(renderSkill({ baseUrl: BASE, key: KEY, keyName: "Codex" }).replace(/\n+$/, ""));
    expect(inner.startsWith("---\nname: moneyswitch-pay")).toBe(true);
  });

  it("the instruction part is bilingual, says where to save, what to do if it cannot, status check, and never shows the key", () => {
    const p = renderInstallPrompt({ ...base, agent: "claude-code" });
    const head = p.slice(0, p.indexOf(SKILL_BEGIN_MARKER));
    expect(head).toMatch(/[一-鿿]/);
    expect(head).toMatch(/Save everything between the BEGIN and END markers, verbatim/);
    expect(head).toMatch(/If you cannot write there, report the path and blocker, without the key/);
    expect(head).toContain(`GET ${BASE}/v1/status`);
    expect(head).toContain("do not make a payment during installation");
    expect(head).toContain("Reply in at most two short lines");
    expect(head).toMatch(/never repeat it in chat/);
    expect(head).toMatch(/never commit it to git/);
    expect(head).not.toContain(KEY);
    // the key is present exactly where the skill needs it, not more often than the skill itself
    const keyCount = (s: string) => s.split(KEY).length - 1;
    expect(keyCount(p)).toBe(keyCount(renderSkill({ baseUrl: BASE, key: KEY, keyName: "Codex" })));
  });

  it.each([
    ["codex", "~/.codex/skills/moneyswitch-pay/SKILL.md", "%USERPROFILE%\\.codex\\skills\\moneyswitch-pay\\SKILL.md"],
    ["claude-code", "~/.claude/skills/moneyswitch-pay/SKILL.md", "%USERPROFILE%\\.claude\\skills\\moneyswitch-pay\\SKILL.md"],
    ["openclaw", "~/.openclaw/workspace/skills/moneyswitch-pay/SKILL.md", "%USERPROFILE%\\.openclaw\\workspace\\skills\\moneyswitch-pay\\SKILL.md"],
  ] as const)("%s saves to %s (Windows: %s)", (agent, p, win) => {
    const text = renderInstallPrompt({ ...base, agent });
    const head = text.slice(0, text.indexOf(SKILL_BEGIN_MARKER));
    expect(head).toContain(`    ${p}\n`);
    // the Windows spelling must be intact: no backslash may have eaten a character
    expect(head).toContain(`(Windows: ${win};`);
    // exactly one agent's directory is named as the target
    for (const other of SKILL_AGENTS) {
      const op = AGENT_INFO[other].path;
      if (op && other !== agent) expect(head).not.toContain(`    ${op}\n`);
    }
  });

  it("Codex: its own $CODEX_HOME/skills, never the cross-agent ~/.agents/skills that OpenClaw also reads", () => {
    const head = headOf(renderInstallPrompt({ ...base, agent: "codex" }));
    expect(head).toContain("    ~/.codex/skills/moneyswitch-pay/SKILL.md\n");
    expect(head).toContain("or $CODEX_HOME/skills/moneyswitch-pay/SKILL.md if CODEX_HOME is set");
    expect(head).not.toContain("    ~/.agents/skills/moneyswitch-pay");
    expect(head).not.toContain("Codex also reads");
  });

  it("OpenClaw: the per-agent workspace skills folder (outranks the shared folders and is where a ClawHub install lands), not the shared ~/.openclaw/skills", () => {
    const head = headOf(renderInstallPrompt({ ...base, agent: "openclaw" }));
    expect(head).toContain("    ~/.openclaw/workspace/skills/moneyswitch-pay/SKILL.md\n");
    expect(head).toContain("use <workspace>/skills/moneyswitch-pay/SKILL.md there");
    // ~/.openclaw/skills is only named as the thing NOT to use
    expect(head).not.toContain("    ~/.openclaw/skills/moneyswitch-pay");
    expect(head).toContain("Not ~/.openclaw/skills");
  });

  it("Hermes: $HERMES_HOME/skills (default ~/.hermes, native Windows %LOCALAPPDATA%\\hermes, profiles have their own), not a hard-coded %USERPROFILE%\\.hermes", () => {
    const head = headOf(renderInstallPrompt({ ...base, agent: "hermes" }));
    expect(head).toContain("    $HERMES_HOME/skills/moneyswitch-pay/SKILL.md\n");
    expect(head).toContain("HERMES_HOME is ~/.hermes by default, " + ["%LOCALAPPDATA%", "hermes"].join("\\") + " on native Windows");
    expect(head).toContain("a Hermes profile has its own HERMES_HOME");
    expect(head).not.toContain(["%USERPROFILE%", ".hermes"].join("\\"));
    expect(head).not.toContain("    ~/.hermes/skills/moneyswitch-pay");
  });

  it("'other' does not guess a path: generic skills-directory phrase", () => {
    const text = renderInstallPrompt({ ...base, agent: "other" });
    const head = headOf(text);
    expect(head).toContain("inside your skills directory");
    // no suggested location: the only skills folder named is the one NOT to use
    expect(head).not.toMatch(/^ {4}[~$]\S*skills/m);
  });

  it.each(SKILL_AGENTS)("%s: replace an existing moneyswitch-pay skill in place (ClawHub / /skill.md copy), never keep two, never use a shared folder", (agent) => {
    const head = headOf(renderInstallPrompt({ ...base, agent }));
    expect(head).toContain("Replace this agent's existing moneyswitch-pay atomically (back up first)");
    expect(head).toContain("do not search unrelated agents' folders");
    expect(head).toContain("leave shared copies unchanged");
    expect(head).toContain(`Never save it in a folder that other agents share (for example ${SHARED_SKILLS_ROOT})`);
    expect(head).toMatch(/留底后原子替换/);
    expect(head).toMatch(/共用目录/);
  });

  it("validates its inputs like renderSkill", () => {
    expect(() => renderInstallPrompt({ ...base, key: 'x"y', agent: "codex" })).toThrow(/invalid key/);
    expect(() => renderInstallPrompt({ ...base, baseUrl: "javascript:1", agent: "codex" })).toThrow(/invalid baseUrl/);
  });

  describe("the test payment of the ten-minute path", () => {
    const hosts = ["api.example.com:443", TEST_PAYMENT_HOST];

    // Feedback from a real agent run (2026-10-04): a cautious agent hesitated at an mk_live_ key next to a payment
    // instruction, and "two sentences" did not fit the three items it was asked to report.
    it("says on its very first line that this is a testnet with test USDC of no real value, and asks for three short lines", () => {
      const p = renderInstallPrompt({ ...base, agent: "codex", testPayment: { allowedHosts: hosts, testnet: true } });
      const first = p.split("\n")[0];
      expect(first).toMatch(/测试网/);
      expect(first).toMatch(/testnet: test USDC with no real value/);
      expect(headOf(p)).toMatch(/at most three short lines: setup result; the test payment's tx_hash; today's remaining budget \(remaining_today\)/);
    });

    it("does not claim testnet on its first line when no test payment is offered", () => {
      const first = renderInstallPrompt({ ...base, agent: "codex" }).split("\n")[0];
      expect(first).not.toMatch(/testnet|测试网/);
    });

    it("on a testnet, for a key that may pay the test host: after the status call, ONE test payment to the test endpoint, then its tx_hash is reported", () => {
      const head = headOf(renderInstallPrompt({ ...base, agent: "codex", testPayment: { allowedHosts: hosts, testnet: true } }));
      expect(head).toContain(`GET ${BASE}/v1/status`);
      expect(head).toContain(`POST ${BASE}/v1/fetch`);
      expect(head).toContain(TEST_PAYMENT_URL);
      expect(head).toContain('"max_price":"0.01"');
      expect(head).toMatch(/ONE test payment/);
      expect(head).toMatch(/tx_hash/);
      expect(head).toMatch(/never retry it/);
      // the status call comes first, then the payment
      expect(head.indexOf("/v1/status")).toBeLessThan(head.indexOf(TEST_PAYMENT_URL));
      expect(head).not.toContain("do not make a payment during installation");
      expect(head).not.toContain(KEY);
    });

    it("the skill inside is exactly the same: the test payment lives in the instruction, not in the skill", () => {
      const withTest = renderInstallPrompt({ ...base, agent: "codex", testPayment: { allowedHosts: hosts, testnet: true } });
      const without = renderInstallPrompt({ ...base, agent: "codex" });
      const inner = (p: string) => p.slice(p.indexOf(SKILL_BEGIN_MARKER), p.indexOf(SKILL_END_MARKER));
      expect(inner(withTest)).toBe(inner(without));
      expect(inner(withTest)).not.toContain(TEST_PAYMENT_URL);
    });

    it.each([
      ["a key that may not pay the test host", { allowedHosts: ["api.example.com:443"], testnet: true }],
      ["a key with no hosts at all", { allowedHosts: [], testnet: true }],
      ["the test host on another port", { allowedHosts: ["app.moneyswitch.dev:8443"], testnet: true }],
      ["mainnet, even for a key that may pay the test host", { allowedHosts: hosts, testnet: false }],
      ["no offer at all", null],
    ])("%s: the prompt is the old one (status only, no payment during installation)", (_label, offer) => {
      const head = headOf(renderInstallPrompt({ ...base, agent: "codex", testPayment: offer }));
      expect(head).toContain("do not make a payment during installation");
      expect(head).not.toContain(TEST_PAYMENT_URL);
      expect(head).not.toMatch(/test payment/i);
      expect(head).toBe(headOf(renderInstallPrompt({ ...base, agent: "codex" })));
    });

    it("the host is matched like the server's gate matches it: host:port or the bare host name, in any letter case", () => {
      expect(allowsTestPayment([TEST_PAYMENT_HOST])).toBe(true);
      expect(allowsTestPayment(["APP.MoneySwitch.dev:443"])).toBe(true);
      expect(allowsTestPayment(["  app.moneyswitch.dev "])).toBe(true);
      expect(allowsTestPayment(["app.moneyswitch.dev:80", "moneyswitch.dev:443", "evil-app.moneyswitch.dev:443"])).toBe(false);
      expect(allowsTestPayment([])).toBe(false);
      expect(allowsTestPayment(undefined)).toBe(false);
      expect(offersTestPayment({ allowedHosts: [TEST_PAYMENT_HOST], testnet: true })).toBe(true);
      expect(offersTestPayment({ allowedHosts: [TEST_PAYMENT_HOST], testnet: false })).toBe(false);
      expect(offersTestPayment(undefined)).toBe(false);
    });
  });
});

describe("renderSkill: the network type of the key (SPEC.md §1, §6)", () => {
  const section = (text: string) => {
    const i = text.indexOf("## Network");
    return i < 0 ? null : text.slice(i, text.indexOf("\n## ", i + 3) < 0 ? undefined : text.indexOf("\n## ", i + 3));
  };

  it("a testnet key's text says it is a testnet key: test USDC with no real value, testnets only", () => {
    const text = renderSkill({ baseUrl: BASE, key: KEY, keyName: "Codex", networkMode: "testnet" });
    const net = section(text)!;
    expect(net).toContain("This is a **testnet** key");
    expect(net).toContain("test USDC that has no real value");
    expect(net).toContain("UNSUPPORTED_PAYMENT");
    expect(net).not.toContain("real money");
    expect(net).not.toContain("**mainnet** key");
  });

  it("a mainnet key's text says it is a mainnet key: real USDC, real money, mainnets only", () => {
    const text = renderSkill({ baseUrl: BASE, key: KEY, keyName: "Codex", networkMode: "mainnet" });
    const net = section(text)!;
    expect(net).toContain("This is a **mainnet** key");
    expect(net).toContain("real USDC");
    expect(net).toContain("real money");
    expect(net).toContain("UNSUPPORTED_PAYMENT");
    expect(net).not.toContain("**testnet** key");
  });

  it("the paragraph comes before the instructions to pay, so it is read first", () => {
    for (const networkMode of ["testnet", "mainnet"] as const) {
      const text = renderSkill({ baseUrl: BASE, key: KEY, networkMode });
      expect(text.indexOf("## Network")).toBeGreaterThan(text.indexOf("## Credentials"));
      expect(text.indexOf("## Network")).toBeLessThan(text.indexOf("## Call a paid API"));
    }
  });

  it("a key from before network types (null / not given) has no such paragraph: its text is what it was", () => {
    const plain = renderSkill({ baseUrl: BASE, key: KEY, keyName: "Codex" });
    expect(section(plain)).toBeNull();
    expect(renderSkill({ baseUrl: BASE, key: KEY, keyName: "Codex", networkMode: null })).toBe(plain);
  });

  it("the generic skill explains that a key is one of two types and how to tell which (GET /v1/status: network_mode)", () => {
    const generic = renderSkill({});
    const net = section(generic)!;
    expect(net).toContain("**testnet** key");
    expect(net).toContain("**mainnet** key");
    expect(net).toContain("real USDC");
    expect(net).toContain("`network_mode`");
    expect(net).toContain("pays on the testnets only where the server enables both kinds");
    expect(net).not.toContain("every chain the server enables");
    expect(net).toContain("$MONEY_API_BASE/v1/status");
    expect(net).toContain("UNSUPPORTED_PAYMENT");
    // it never claims to be one of them, and a network type given to the generic text does not change it
    expect(generic).not.toContain("This is a **testnet** key");
    expect(renderSkill({ networkMode: "mainnet" })).toBe(generic);
    expect(renderSkill({ baseUrl: BASE, networkMode: "testnet" })).toContain("A MoneyKey is one of two types");
  });

  it("the status call is said to return the network type, and UNSUPPORTED_PAYMENT is explained in the table of results", () => {
    const text = renderSkill({ baseUrl: BASE, key: KEY, networkMode: "testnet" });
    expect(text).toContain("`approval_threshold` and `network_mode`");
    expect(text).toMatch(/`UNSUPPORTED_PAYMENT`: the seller offers no payment this key can make/);
  });

  it("no network text puts a key anywhere but where it was", () => {
    for (const networkMode of ["testnet", "mainnet", null] as const) {
      const text = renderSkill({ baseUrl: BASE, key: KEY, networkMode });
      expect(text.split(KEY).length - 1).toBe(renderSkill({ baseUrl: BASE, key: KEY }).split(KEY).length - 1);
    }
    expect(KEY_SHAPE.test(renderSkill({ networkMode: "mainnet" }))).toBe(false);
  });
});

describe("renderInstallPrompt: the network type in the first line and in the skill", () => {
  const base = { baseUrl: BASE, key: KEY, keyName: "Codex", agent: "codex" as SkillAgent };

  it("a testnet key: the first line says test USDC with no value, and the skill below it is the testnet key's", () => {
    const p = renderInstallPrompt({ ...base, networkMode: "testnet" });
    expect(headOf(p).split("\n")[0]).toContain("testnet: test USDC with no real value");
    expect(p).toContain("This is a **testnet** key");
    expect(headOf(p)).toContain("do not make a payment during installation");
  });

  it("a mainnet key: the first line says real USDC, real money; never the test payment", () => {
    const p = renderInstallPrompt({ ...base, networkMode: "mainnet" });
    expect(headOf(p).split("\n")[0]).toContain("mainnet: real USDC, real money");
    expect(headOf(p).split("\n")[0]).not.toContain("testnet");
    expect(p).toContain("This is a **mainnet** key");
    // even if a test payment were handed in for it (the dashboard never does), a mainnet key's first line stays a mainnet line
    const hosts = ["api.example.com:443", TEST_PAYMENT_HOST];
    const odd = renderInstallPrompt({ ...base, networkMode: "mainnet", testPayment: { allowedHosts: hosts, testnet: false } });
    expect(odd).not.toContain(TEST_PAYMENT_URL);
  });

  it("a key from before network types: the first line and the skill say nothing about it, as before", () => {
    const plain = renderInstallPrompt(base);
    expect(headOf(plain).split("\n")[0]).not.toMatch(/testnet|mainnet/);
    expect(plain).not.toContain("This is a **testnet** key");
    expect(renderInstallPrompt({ ...base, networkMode: null })).toBe(plain);
  });

  it("a testnet key that is offered the test payment keeps the line it had", () => {
    const hosts = ["api.example.com:443", TEST_PAYMENT_HOST];
    const p = renderInstallPrompt({ ...base, networkMode: "testnet", testPayment: { allowedHosts: hosts, testnet: true } });
    expect(headOf(p).split("\n")[0]).toContain("testnet: test USDC with no real value");
    expect(headOf(p)).toContain(TEST_PAYMENT_URL);
    // offered the test payment without a network type (the older call): the line is the testnet line too
    const old = renderInstallPrompt({ ...base, testPayment: { allowedHosts: hosts, testnet: true } });
    expect(headOf(old).split("\n")[0]).toContain("testnet: test USDC with no real value");
  });
});

describe("agents", () => {
  it("guesses the agent from a key name", () => {
    expect(guessAgentFromName("Codex")).toBe("codex");
    expect(guessAgentFromName("my Claude Code")).toBe("claude-code");
    expect(guessAgentFromName("OpenClaw-2")).toBe("openclaw");
    expect(guessAgentFromName("hermes bot")).toBe("hermes");
    expect(guessAgentFromName("research bot")).toBeNull();
    expect(guessAgentFromName(null)).toBeNull();
  });
  it("isSkillAgent", () => {
    expect(isSkillAgent("codex")).toBe(true);
    expect(isSkillAgent("cursor")).toBe(false);
    expect(isSkillAgent(undefined)).toBe(false);
  });
});

// One key per agent: the personalized skill holds that agent's own key, so it has to be saved where ONLY that agent
// loads it. Codex and OpenClaw both read ~/.agents/skills, and OpenClaw ranks it above ~/.openclaw/skills, so a Codex
// skill saved there would make OpenClaw pay with Codex's key (verified with OpenClaw 2026.9.3: "Skill precedence collision").
describe("agents: no agent's install folder is loaded by another agent", () => {
  /** (writer, reader) pairs where `reader` also loads the folder `writer` saves its key into. */
  function conflicts(info: Record<SkillAgent, AgentInfo>): string[] {
    const out: string[] = [];
    for (const writer of SKILL_AGENTS) {
      const root = info[writer].installRoot;
      if (!root) continue;
      for (const reader of SKILL_AGENTS) {
        if (reader !== writer && info[reader].loads.includes(root)) out.push(`${writer} saves into ${root}, which ${reader} also loads`);
      }
    }
    return out;
  }

  it("holds for every agent", () => {
    expect(conflicts(AGENT_INFO)).toEqual([]);
  });

  it("is not vacuous: the old layout (Codex into the shared ~/.agents/skills) is reported as a conflict with OpenClaw", () => {
    const old = { ...AGENT_INFO, codex: { ...AGENT_INFO.codex, installRoot: SHARED_SKILLS_ROOT } };
    expect(conflicts(old)).toContain(`codex saves into ${SHARED_SKILLS_ROOT}, which openclaw also loads`);
    // OpenClaw's shared managed folder is reported too when another agent saves its key there
    const viaManaged = { ...AGENT_INFO, hermes: { ...AGENT_INFO.hermes, installRoot: "~/.openclaw/skills" } };
    expect(conflicts(viaManaged)).toContain("hermes saves into ~/.openclaw/skills, which openclaw also loads");
  });

  it("nothing is installed into the shared ~/.agents/skills, and every path sits inside its install folder", () => {
    for (const a of SKILL_AGENTS) {
      const info = AGENT_INFO[a];
      expect(info.installRoot, a).not.toBe(SHARED_SKILLS_ROOT);
      if (info.path) {
        expect(info.path, a).not.toContain(".agents/skills");
        expect(info.path, a).toBe(`${info.installRoot}/moneyswitch-pay/SKILL.md`);
        // every agent loads its own install folder, or the skill would never be found
        expect(info.loads, a).toContain(info.installRoot);
      } else {
        expect(info.installRoot, a).toBeNull();
      }
    }
  });

  it("records the sharing that motivates the rule: Codex and OpenClaw both load ~/.agents/skills", () => {
    expect(AGENT_INFO.codex.loads).toContain(SHARED_SKILLS_ROOT);
    expect(AGENT_INFO.openclaw.loads).toContain(SHARED_SKILLS_ROOT);
    // OpenClaw does not read Codex's own folder (its docs: "$CODEX_HOME/skills is not an OpenClaw skill root")
    expect(AGENT_INFO.openclaw.loads).not.toContain("~/.codex/skills");
  });
});

describe("browser safety", () => {
  const srcDir = path.resolve(here, "..", "src");
  it("the source uses no node: imports, require, process or Buffer", () => {
    for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith(".ts"))) {
      // comments may mention these words; only real code counts
      const code = fs
        .readFileSync(path.join(srcDir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/from\s+["']node:/);
      expect(code, f).not.toMatch(/\brequire\s*\(/);
      expect(code, f).not.toMatch(/\bprocess\./);
      expect(code, f).not.toMatch(/\bBuffer\b/);
    }
  });
});

describe("skills/moneyswitch-pay/SKILL.md (the copy that may be published to ClawHub)", () => {
  const file = path.resolve(here, "..", "..", "..", "skills", "moneyswitch-pay", "SKILL.md");

  it("equals the renderer's generic output (regenerate with: pnpm --filter @moneyswitch/skill build && pnpm --filter @moneyswitch/skill gen)", () => {
    expect(nl(fs.readFileSync(file, "utf8"))).toBe(renderSkill({}));
  });

  it("carries no secret and no server-specific URL", () => {
    const t = fs.readFileSync(file, "utf8");
    expect(t).not.toMatch(KEY_SHAPE);
    expect(t).toContain("name: moneyswitch-pay");
  });
});
