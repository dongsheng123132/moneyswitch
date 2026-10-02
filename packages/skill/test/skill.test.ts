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
  guessAgentFromName,
  isSkillAgent,
  normalizeBaseUrl,
} from "../src/index.js";

const BASE = "https://pay.example.com";
const KEY = "mk_live_Ab3dEf6hIj9lMn2pQr5tUv8xYz1B4cDe";
const KEY_SHAPE = /mk_live_[A-Za-z0-9]{8,}/;

const here = path.dirname(fileURLToPath(import.meta.url));
const nl = (s: string) => s.replace(/\r\n/g, "\n");

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

  it("approval_required: poll GET /v1/approvals/{id} about every 15 s, ~10 min TTL, resend the same request plus approval_id", () => {
    const row = text.split("\n").find((l) => l.startsWith("| `approval_required`"))!;
    expect(row).toContain("/v1/approvals/{approval_id}");
    expect(row).toContain("every 15 seconds");
    expect(row).toContain("10 minutes");
    expect(row).toContain("exact same request plus `approval_id`");
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
    expect(head).toMatch(/If you cannot write there, show me the path and the content/);
    expect(head).toContain(`GET ${BASE}/v1/status`);
    expect(head).toMatch(/never repeat it in chat/);
    expect(head).toMatch(/never commit it to git/);
    expect(head).not.toContain(KEY);
    // the key is present exactly where the skill needs it, not more often than the skill itself
    const keyCount = (s: string) => s.split(KEY).length - 1;
    expect(keyCount(p)).toBe(keyCount(renderSkill({ baseUrl: BASE, key: KEY, keyName: "Codex" })));
  });

  it.each([
    ["codex", "~/.agents/skills/moneyswitch-pay/SKILL.md", "%USERPROFILE%\\.agents\\skills\\moneyswitch-pay\\SKILL.md"],
    ["claude-code", "~/.claude/skills/moneyswitch-pay/SKILL.md", "%USERPROFILE%\\.claude\\skills\\moneyswitch-pay\\SKILL.md"],
    ["openclaw", "~/.openclaw/skills/moneyswitch-pay/SKILL.md", "%USERPROFILE%\\.openclaw\\skills\\moneyswitch-pay\\SKILL.md"],
    ["hermes", "~/.hermes/skills/moneyswitch-pay/SKILL.md", "%USERPROFILE%\\.hermes\\skills\\moneyswitch-pay\\SKILL.md"],
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

  it("Codex mentions its second, legacy-but-still-read location in a hint", () => {
    const text = renderInstallPrompt({ ...base, agent: "codex" });
    expect(text.slice(0, text.indexOf(SKILL_BEGIN_MARKER))).toContain("Codex also reads ~/.codex/skills/moneyswitch-pay/SKILL.md");
  });

  it("'other' does not guess a path: generic skills-directory phrase", () => {
    const text = renderInstallPrompt({ ...base, agent: "other" });
    const head = text.slice(0, text.indexOf(SKILL_BEGIN_MARKER));
    expect(head).toContain("inside your skills directory");
    expect(head).not.toMatch(/~\/\.\w+\/skills/);
  });

  it("validates its inputs like renderSkill", () => {
    expect(() => renderInstallPrompt({ ...base, key: 'x"y', agent: "codex" })).toThrow(/invalid key/);
    expect(() => renderInstallPrompt({ ...base, baseUrl: "javascript:1", agent: "codex" })).toThrow(/invalid baseUrl/);
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
