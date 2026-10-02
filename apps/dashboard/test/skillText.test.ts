import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SKILL_BEGIN_MARKER, SKILL_END_MARKER } from "@moneyswitch/skill";
import { buildInstallText, skillBaseUrl, maskedForDisplay, looksLikeMoneyKey, guessAgentFromName, SKILL_AGENTS } from "../src/skillText.ts";
import { skillStrings } from "../src/i18n/strings/skill.ts";

const KEY = "mk_live_Ab3dEf6hIj9lMn2pQr5tUv8xYz1B4cDe";
const BASE = "https://pay.example.com";

describe("buildInstallText", () => {
  it("builds the copy text with the real key and a masked display copy", () => {
    const r = buildInstallText({ baseUrl: BASE, key: KEY, keyName: "Codex", agent: "codex" });
    assert.equal(r.error, null);
    assert.ok(r.text!.includes(KEY));
    assert.ok(r.text!.includes(BASE));
    assert.ok(r.text!.includes(SKILL_BEGIN_MARKER));
    assert.ok(r.text!.includes(SKILL_END_MARKER));
    assert.ok(!r.display!.includes(KEY));
    assert.ok(r.display!.includes("mk_live_Ab3d"));
    assert.ok(r.display!.includes("•"));
    assert.equal(r.display!.split("\n").length, r.text!.split("\n").length);
  });

  it("works for every agent in the selector", () => {
    for (const agent of SKILL_AGENTS) {
      const r = buildInstallText({ baseUrl: BASE, key: KEY, agent });
      assert.equal(r.error, null, agent);
      assert.ok(r.text!.includes("name: moneyswitch-pay"), agent);
    }
  });

  it("reports why nothing can be built instead of throwing", () => {
    assert.equal(buildInstallText({ baseUrl: BASE, key: "", agent: "codex" }).error, "no_key");
    assert.equal(buildInstallText({ baseUrl: BASE, key: "   ", agent: "codex" }).error, "no_key");
    assert.equal(buildInstallText({ baseUrl: BASE, key: 'mk_live_"; rm -rf ~', agent: "codex" }).error, "bad_key");
    assert.equal(buildInstallText({ baseUrl: BASE, key: "ms_admin_Ab3dEf6hIj9lMn2pQr5tUv8x", agent: "codex" }).error, "bad_key");
    assert.equal(buildInstallText({ baseUrl: "javascript:1", key: KEY, agent: "codex" }).error, "bad_url");
  });

  it("trims the pasted key", () => {
    assert.ok(buildInstallText({ baseUrl: BASE, key: `  ${KEY}\n`, agent: "other" }).text!.includes(KEY));
  });
});

describe("skillBaseUrl", () => {
  it("prefers MONEYSWITCH_PUBLIC_URL when the server says it is set, else the browser origin", () => {
    assert.equal(skillBaseUrl({ public_base: "https://pay.example.com", public_base_from_env: true }, "http://127.0.0.1:4020"), "https://pay.example.com");
    assert.equal(skillBaseUrl({ public_base: "http://127.0.0.1:4020", public_base_from_env: false }, "http://localhost:5173"), "http://localhost:5173");
    assert.equal(skillBaseUrl(null, "https://pay.example.com/"), "https://pay.example.com");
    assert.equal(skillBaseUrl(undefined, "http://127.0.0.1:4020"), "http://127.0.0.1:4020");
  });
  it("ignores an unusable public URL", () => {
    assert.equal(skillBaseUrl({ public_base: "not a url", public_base_from_env: true }, "http://127.0.0.1:4020"), "http://127.0.0.1:4020");
  });
});

describe("helpers", () => {
  it("looksLikeMoneyKey", () => {
    assert.equal(looksLikeMoneyKey(KEY), true);
    assert.equal(looksLikeMoneyKey(` ${KEY} `), true);
    assert.equal(looksLikeMoneyKey("mk_live_xxx"), false);
    assert.equal(looksLikeMoneyKey("0x" + "a".repeat(40)), false);
  });
  it("maskedForDisplay hides every occurrence", () => {
    const text = `a ${KEY} b ${KEY} c`;
    const masked = maskedForDisplay(text, KEY);
    assert.ok(!masked.includes(KEY));
    assert.ok(masked.split("•").length > 2);
    assert.equal(maskedForDisplay(text, ""), text);
  });
  it("preselects the agent from the key name", () => {
    assert.equal(guessAgentFromName("Alice · Codex"), "codex");
    assert.equal(guessAgentFromName("OpenClaw"), "openclaw");
    assert.equal(guessAgentFromName("Bob"), null);
  });
});

describe("i18n", () => {
  it("every skill string has an English and a Chinese version with the same placeholders", () => {
    const en = skillStrings.en as Record<string, string>;
    const zh = skillStrings.zh as Record<string, string>;
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
    for (const k of Object.keys(en)) {
      assert.ok(en[k].length > 0, k);
      assert.ok(zh[k].length > 0, k);
      assert.equal(ph(zh[k]), ph(en[k]), k);
    }
  });
  it("has a label for every agent in the selector", () => {
    for (const a of SKILL_AGENTS) assert.ok(`agent_${a}` in skillStrings.en, a);
  });
});
