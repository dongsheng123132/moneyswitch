import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SKILL_BEGIN_MARKER, SKILL_END_MARKER } from "@moneyswitch/skill";
import {
  buildInstallText,
  skillBaseUrl,
  maskedForDisplay,
  looksLikeMoneyKey,
  guessAgentFromName,
  SKILL_AGENTS,
  testPaymentAvailable,
  withTestHost,
  TEST_PAYMENT_HOST,
  TEST_PAYMENT_URL,
} from "../src/skillText.ts";
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

  it("an unusable address is reported as bad_url even before a key exists (no key can fix the address)", () => {
    assert.equal(buildInstallText({ baseUrl: "http://moneyswitch_srv:4020", key: "", agent: "codex" }).error, "bad_url");
    assert.equal(buildInstallText({ baseUrl: "http://moneyswitch_srv:4020", key: KEY, agent: "codex" }).error, "bad_url");
    assert.equal(buildInstallText({ baseUrl: "", key: KEY, agent: "codex" }).error, "bad_url");
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

  // The pages call it while they render and the Dashboard has no error boundary: a throw unmounts the whole app.
  // These are real browser origins that the skill renderer (shell-safe alphabet) refuses.
  it("never throws, whatever the browser origin is", () => {
    const origins = ["http://moneyswitch_srv:4020", "http://example.com.:4020", "http://-bad-host:80", "http://[::1", "", "   ", "not a url"];
    for (const origin of origins) {
      assert.doesNotThrow(() => skillBaseUrl(null, origin), origin);
      assert.doesNotThrow(() => skillBaseUrl(undefined, origin), origin);
      assert.doesNotThrow(() => skillBaseUrl({ public_base: "bad_host", public_base_from_env: true }, origin), origin);
    }
  });

  it("hands an unusable origin on as it is, so buildInstallText can report bad_url instead of the page crashing", () => {
    const base = skillBaseUrl(null, "http://moneyswitch_srv:4020");
    assert.equal(base, "http://moneyswitch_srv:4020");
    assert.equal(buildInstallText({ baseUrl: base, key: KEY, agent: "codex" }).error, "bad_url");
  });

  it("MONEYSWITCH_PUBLIC_URL still rescues a page opened from an unusable origin", () => {
    const base = skillBaseUrl({ public_base: "https://pay.example.com", public_base_from_env: true }, "http://moneyswitch_srv:4020");
    assert.equal(base, "https://pay.example.com");
    assert.equal(buildInstallText({ baseUrl: base, key: KEY, agent: "codex" }).error, null);
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

describe("the ten-minute path: when the test payment is on offer", () => {
  const monadTestnet = { network: "eip155:10143", chain_id: 10143, usdc_address: "0x1", network_label: "Monad Testnet", explorer_base: "https://x", is_mainnet: false };
  const baseSepolia = { ...monadTestnet, network: "eip155:84532", chain_id: 84532, network_label: "Base Sepolia" };
  const monadMainnet = { ...monadTestnet, network: "eip155:143", chain_id: 143, network_label: "Monad Mainnet", is_mainnet: true };

  it("a testnet default with Monad testnet enabled: yes", () => {
    assert.equal(testPaymentAvailable({ is_mainnet: false, networks: [monadTestnet] }), true);
    assert.equal(testPaymentAvailable({ is_mainnet: false, networks: [baseSepolia, monadTestnet] }), true, "Base Sepolia default, Monad testnet enabled too");
  });

  it("ONLY when every enabled network is a testnet: a mainnet enabled next to the testnet is no, even with a testnet default", () => {
    const baseMainnet = { ...monadTestnet, network: "eip155:8453", chain_id: 8453, network_label: "Base", is_mainnet: true };
    // the default (is_mainnet describes it) is a testnet, but a mainnet is also enabled: the key is immutable and the test host would be allowed on every chain
    assert.equal(testPaymentAvailable({ is_mainnet: false, networks: [monadTestnet, monadMainnet] }), false);
    assert.equal(testPaymentAvailable({ is_mainnet: false, networks: [monadMainnet, monadTestnet] }), false);
    assert.equal(testPaymentAvailable({ is_mainnet: false, networks: [baseSepolia, monadTestnet, baseMainnet] }), false);
    assert.equal(testPaymentAvailable({ is_mainnet: false, networks: [monadTestnet, baseMainnet] }), false);
    // and still yes when everything enabled is a testnet
    assert.equal(testPaymentAvailable({ is_mainnet: false, networks: [monadTestnet, baseSepolia] }), true);
  });

  it("a mainnet default, an unknown instance, or no Monad testnet (the only chain the test receiver accepts): no", () => {
    assert.equal(testPaymentAvailable({ is_mainnet: true, networks: [monadMainnet, monadTestnet] }), false);
    assert.equal(testPaymentAvailable(null), false);
    assert.equal(testPaymentAvailable(undefined), false);
    assert.equal(testPaymentAvailable({ is_mainnet: undefined, networks: [monadTestnet] }), false);
    assert.equal(testPaymentAvailable({ is_mainnet: false, networks: [baseSepolia] }), false);
    assert.equal(testPaymentAvailable({ is_mainnet: false, networks: undefined }), false);
  });

  it("withTestHost: typed hosts stay, the test host is added once when ticked, and never when not", () => {
    assert.deepEqual(withTestHost(["api.example.com:443", " ", ""], true), ["api.example.com:443", TEST_PAYMENT_HOST]);
    assert.deepEqual(withTestHost([""], true), [TEST_PAYMENT_HOST]);
    assert.deepEqual(withTestHost(["APP.MONEYSWITCH.DEV:443"], true), ["APP.MONEYSWITCH.DEV:443"], "no duplicate in another letter case");
    assert.deepEqual(withTestHost(["api.example.com:443"], false), ["api.example.com:443"]);
    assert.deepEqual(withTestHost([], false), []);
  });

  it("buildInstallText passes the offer on: the text asks for the test payment only for a testnet and a key that may pay the host", () => {
    const hosts = ["api.example.com:443", TEST_PAYMENT_HOST];
    const on = buildInstallText({ baseUrl: BASE, key: KEY, agent: "codex", testPayment: { allowedHosts: hosts, testnet: true } });
    assert.ok(on.text!.includes(TEST_PAYMENT_URL));
    assert.ok(on.display!.includes(TEST_PAYMENT_URL));
    for (const offer of [{ allowedHosts: hosts, testnet: false }, { allowedHosts: ["api.example.com:443"], testnet: true }, null, undefined]) {
      const off = buildInstallText({ baseUrl: BASE, key: KEY, agent: "codex", testPayment: offer });
      assert.ok(!off.text!.includes(TEST_PAYMENT_URL), JSON.stringify(offer));
      assert.ok(off.text!.includes("do not make a payment during installation"));
    }
  });
});
