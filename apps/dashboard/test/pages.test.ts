// Page-level render tests (react-dom/server, no DOM): which way to connect an agent is FIRST and DEFAULT on every
// path that hands out a key, that the pages survive an address the skill renderer refuses, and the Money Keys
// handoff / row actions. Interactivity (clicks) is not exercised here; defaults and structure are.
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";

// api.ts reads sessionStorage; i18n reads localStorage; pages read window.location.origin at render time.
const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
const setOrigin = (origin: string) => Object.assign(globalThis, { window: { location: { origin, hash: "" } } });
Object.assign(globalThis, { localStorage: fakeStorage, sessionStorage: fakeStorage });
setOrigin("https://pay.example.com");

const KEY = "mk_live_Ab3dEf6hIj9lMn2pQr5tUv8xYz1B4cDe";
const CHILD_KEY = "mk_live_Chld1234567890ChildSecretKeyZ9yX";
const PARENT_KEY = "mk_live_Prnt1234567890ParentSecretKeyAbCd";
const BASE = "https://pay.example.com";
const BAD_ORIGINS = ["http://moneyswitch_srv:4020", "http://example.com.:4020"];

let ConnectAgentPage: typeof import("../src/pages/ConnectAgentPage.tsx").default;
let MoneyKeysPage: typeof import("../src/pages/MoneyKeysPage.tsx").default;
let EmployeeConnectPage: typeof import("../src/pages/employee/EmployeeConnectPage.tsx").default;
let ConnectStep: typeof import("../src/pages/SetupPage.tsx").ConnectStep;
let SubKeyCreated: typeof import("../src/pages/employee/MySubKeysPage.tsx").SubKeyCreated;
let KeyHandoff: typeof import("../src/components/KeyHandoff.tsx").default;
let KeyRowActions: typeof import("../src/components/KeyRowActions.tsx").default;
let LangProvider: typeof import("../src/i18n/index.tsx").LangProvider;
let AuthProvider: typeof import("../src/auth.tsx").AuthProvider;
let en: {
  connect: (typeof import("../src/i18n/strings/connect.ts"))["connectStrings"]["en"];
  keys: (typeof import("../src/i18n/strings/keys.ts"))["keysStrings"]["en"];
  skill: (typeof import("../src/i18n/strings/skill.ts"))["skillStrings"]["en"];
  setup: (typeof import("../src/i18n/strings/setup.ts"))["setupStrings"]["en"];
};

before(async () => {
  ConnectAgentPage = (await import("../src/pages/ConnectAgentPage.tsx")).default;
  MoneyKeysPage = (await import("../src/pages/MoneyKeysPage.tsx")).default;
  EmployeeConnectPage = (await import("../src/pages/employee/EmployeeConnectPage.tsx")).default;
  ConnectStep = (await import("../src/pages/SetupPage.tsx")).ConnectStep;
  SubKeyCreated = (await import("../src/pages/employee/MySubKeysPage.tsx")).SubKeyCreated;
  KeyHandoff = (await import("../src/components/KeyHandoff.tsx")).default;
  KeyRowActions = (await import("../src/components/KeyRowActions.tsx")).default;
  LangProvider = (await import("../src/i18n/index.tsx")).LangProvider;
  AuthProvider = (await import("../src/auth.tsx")).AuthProvider;
  en = {
    connect: (await import("../src/i18n/strings/connect.ts")).connectStrings.en,
    keys: (await import("../src/i18n/strings/keys.ts")).keysStrings.en,
    skill: (await import("../src/i18n/strings/skill.ts")).skillStrings.en,
    setup: (await import("../src/i18n/strings/setup.ts")).setupStrings.en,
  };
});

beforeEach(() => {
  setOrigin(BASE);
  store.clear();
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0], lang: "en" | "zh" = "en") => {
  store.set("moneyswitch_lang", lang);
  return renderToStaticMarkup(h(LangProvider, null, h(StaticRouter, { location: "/" }, h(AuthProvider, null, el))));
};

/** The way React escapes text into HTML, so a string with quotes or apostrophes can be searched for in rendered markup. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
/** Applies a "{name}" substitution the way t() does and escapes the result for markup, so assertions track the strings instead of copies of them. */
const fill = (s: string, vars: Record<string, string | number>) => esc(s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k])));

describe("Connect agent page", () => {
  it("opens on the skill tab: it is the first tab, active, with the skill block and none of the MCP/OpenAI/REST content", () => {
    const html = render(h(ConnectAgentPage));
    const skillTab = html.indexOf(en.skill.tabSkill);
    const mcpTab = html.indexOf(en.connect.tabMcp);
    assert.ok(skillTab >= 0 && mcpTab > skillTab, "the skill tab comes before the MCP tab");
    assert.match(html, new RegExp(`<button type="button" class="tab-btn active">${en.skill.tabSkill.replace(/[()]/g, "\\$&")}`), "the skill tab is the active one");
    assert.ok(html.includes(en.skill.recommended));
    assert.ok(html.includes(en.skill.tabOther), "the other ways are grouped under their own label");
    assert.ok(html.includes(en.skill.blockTitle), "the skill block is shown");
    assert.ok(!html.includes(en.connect.oneLineTitle), "the MCP section is not shown by default");
  });

  it("renders in Chinese too", () => {
    const html = render(h(ConnectAgentPage), "zh");
    assert.ok(html.includes("交给你的 AI（skill）"));
    assert.ok(html.includes("class=\"tab-btn active\">交给你的 AI（skill）"));
  });

  for (const origin of BAD_ORIGINS) {
    it(`survives an address the skill cannot use (${origin}): the page renders and explains instead of crashing`, () => {
      setOrigin(origin);
      let html = "";
      assert.doesNotThrow(() => (html = render(h(ConnectAgentPage))));
      assert.ok(html.includes(en.skill.tabSkill));
      assert.ok(html.includes(fill(en.skill.badUrl, { url: origin })), "names the address and how to fix it");
      assert.ok(!html.includes("copy-btn"), "no copy button for text that would carry a wrong address");
    });
  }
});

describe("Money Keys page", () => {
  for (const origin of BAD_ORIGINS) {
    it(`survives an address the skill cannot use (${origin}): the key list page still renders (it is where keys are revoked)`, () => {
      setOrigin(origin);
      let html = "";
      assert.doesNotThrow(() => (html = render(h(MoneyKeysPage))));
      assert.ok(html.includes(en.keys.createKeyBtn));
    });
  }

  it("renders with the normal address", () => {
    const html = render(h(MoneyKeysPage));
    assert.ok(html.includes(en.keys.createKeyBtn));
  });
});

describe("Employee connect page", () => {
  it("survives an address the skill cannot use: renders, explains, still shows the other ways", () => {
    store.set("moneyswitch_employee_key", KEY);
    for (const origin of BAD_ORIGINS) {
      setOrigin(origin);
      let html = "";
      assert.doesNotThrow(() => (html = render(h(EmployeeConnectPage))), origin);
      assert.ok(html.includes(fill(en.skill.badUrl, { url: origin })), origin);
      assert.ok(html.includes("npx"), "the CLI/MCP sections are still there");
    }
  });
});

describe("KeyHandoff (the drawer after 'Create key' or 'Reset secret and copy skill')", () => {
  const props = {
    skillBase: BASE,
    apiBase: BASE,
    src: { kind: "tarball", url: `${BASE}/dl/moneyswitch.tgz` } as const,
    firstModel: "moneyswitch-demo-chat",
    onTryPlayground() {},
    onDone() {},
  };
  const created = { id: 1, kind: "created", key: KEY, name: "Codex" } as const;
  const rotated = { id: 2, kind: "rotated", key: KEY, name: "Codex" } as const;

  it("a new key opens on the skill tab: skill first, selected, the block with a copy button, the other ways not shown", () => {
    const html = render(h(KeyHandoff, { ...props, handoff: created }));
    assert.ok(html.includes(en.keys.createdBanner));
    assert.match(html, /role="tab" aria-selected="true" class="tab-btn active">Give this to your AI \(skill\)/);
    assert.match(html, /role="tab" aria-selected="false" class="tab-btn ">Other ways \(advanced\)/);
    assert.ok(html.includes("Copy for Codex"), "named key -> agent preselected");
    assert.ok(html.includes("secret-notice"));
    assert.ok(!html.includes(en.skill.otherIntro), "the other ways are behind their tab");
    assert.ok(!html.includes("claude mcp add"));
  });

  it("the full key is shown once (the key box) and not again in the skill preview", () => {
    const html = render(h(KeyHandoff, { ...props, handoff: created }));
    assert.equal(html.split(KEY).length - 1, 1);
    assert.ok(html.includes("mk_live_Ab3d"), "masked preview");
  });

  it("after 'Reset secret' the banner says it is a NEW secret for that key and the skill is still first", () => {
    const html = render(h(KeyHandoff, { ...props, handoff: rotated }));
    assert.ok(html.includes(fill(en.skill.rotatedBanner, { name: "Codex" })));
    assert.ok(!html.includes(en.keys.createdBanner));
    assert.match(html, /aria-selected="true" class="tab-btn active">Give this to your AI \(skill\)/);
  });

  it("the other ways are still there: connect command, MCP, OpenAI, message for a colleague (initialTopTab=other)", () => {
    const html = render(h(KeyHandoff, { ...props, handoff: created, initialTopTab: "other" }));
    assert.match(html, /aria-selected="true" class="tab-btn active">Other ways \(advanced\)/);
    assert.ok(html.includes(en.skill.otherIntro));
    for (const label of [en.keys.tabConnect, en.keys.tabClaude, en.keys.tabCodex, en.keys.tabOpenai, en.keys.tabEmployee]) assert.ok(html.includes(label), label);
    assert.ok(html.includes("npx -y --package="), "the one-line connect command is the default of the other ways");
    assert.ok(!html.includes(en.skill.blockTitle), "the skill block is behind its own tab");
  });

  it("a wrong page address does not break the drawer: the key is still shown, the skill explains", () => {
    const html = render(h(KeyHandoff, { ...props, skillBase: "http://moneyswitch_srv:4020", handoff: created }));
    assert.ok(html.includes(KEY));
    assert.ok(html.includes(fill(en.skill.badUrl, { url: "http://moneyswitch_srv:4020" })));
    assert.ok(!html.includes("Copy for Codex"));
  });
});

describe("KeyRowActions (key list row)", () => {
  const base = { childrenCount: 0, confirmingRevoke: false, revoking: false, onRotate() {}, onAskRevoke() {}, onRevoke() {}, onCancelRevoke() {} };

  it("an active key offers 'Reset secret and copy skill' and Revoke", () => {
    const html = render(h(KeyRowActions, { ...base, status: "active" }));
    assert.ok(html.includes(">Reset secret and copy skill<"));
    assert.ok(html.includes(`>${en.keys.revokeBtn}<`));
  });

  it("a key that is already dead (revoked, expired, an ancestor revoked or expired) offers nothing", () => {
    for (const status of ["revoked", "expired", "ancestor_revoked", "ancestor_expired"]) {
      assert.equal(render(h(KeyRowActions, { ...base, status })), "", status);
    }
  });

  it("the revoke confirmation keeps the reset button next to it and names the sub-keys", () => {
    const html = render(h(KeyRowActions, { ...base, status: "active", confirmingRevoke: true, childrenCount: 2 }));
    assert.ok(html.includes(fill(en.keys.revokeConfirmTextWithChildren, { n: 2 })));
    assert.ok(html.includes(">Reset secret and copy skill<"));
  });
});

describe("Setup wizard, last step 'Connect an agent'", () => {
  const created = { id: "k1", name: "Codex", key: KEY } as unknown as Parameters<typeof ConnectStep>[0]["created"];
  const cliSrc = { kind: "tarball", url: `${BASE}/dl/moneyswitch.tgz` } as const;

  it("offers the skill FIRST (agent selector + copy button) and the CLI/MCP command only under 'other ways'", () => {
    const html = render(h(ConnectStep, { created, usedAt: null, cliSrc, skillBase: BASE }));
    const skillAt = html.indexOf(en.skill.blockTitle);
    const otherAt = html.indexOf(en.setup.s5_otherWays);
    const cliAt = html.indexOf("npx -y --package=");
    assert.ok(skillAt >= 0, "skill block present");
    assert.ok(html.includes("Copy for Codex"));
    assert.ok(html.includes('role="radiogroup"'));
    assert.ok(otherAt > skillAt, "other ways come after the skill");
    assert.ok(cliAt > otherAt, "the CLI command sits under the 'other ways' heading");
    assert.match(html, /<details class="setup-other"><summary>/);
    assert.ok(html.includes(en.setup.s5_waiting));
    // The skill block shows the key masked; (as before) the advanced CLI snippet shows its command in full.
    assert.ok(!html.slice(0, otherAt).includes(KEY), "the full key is not in the skill block");
  });

  it("says it is connected once the key was used", () => {
    assert.ok(render(h(ConnectStep, { created, usedAt: "2026-10-02T00:00:00Z", cliSrc, skillBase: BASE })).includes(en.setup.s5_connected));
  });

  it("without a key: the hint and the way to the Connect page, no skill block", () => {
    const html = render(h(ConnectStep, { created: null, usedAt: null, cliSrc, skillBase: BASE }));
    assert.ok(html.includes(en.setup.s5_noKey));
    assert.ok(!html.includes(en.skill.blockTitle));
  });

  it("a wrong page address is explained instead of crashing the wizard", () => {
    const html = render(h(ConnectStep, { created, usedAt: null, cliSrc, skillBase: "http://moneyswitch_srv:4020" }));
    assert.ok(html.includes(fill(en.skill.badUrl, { url: "http://moneyswitch_srv:4020" })));
    assert.ok(html.includes("npx -y --package="), "the CLI route is still offered");
  });

  it("Chinese", () => {
    const html = render(h(ConnectStep, { created, usedAt: null, cliSrc, skillBase: BASE }), "zh");
    assert.ok(html.includes("复制，给 Codex"));
    assert.ok(html.includes("其他接入方式（进阶）"));
  });
});

describe("Employee portal: sub-key created", () => {
  const created = { id: "c1", name: "Codex", key: CHILD_KEY } as unknown as Parameters<typeof SubKeyCreated>[0]["created"];

  it("offers the skill for the NEW sub-key (not the holder's own key) before the raw OpenAI snippet", () => {
    store.set("moneyswitch_employee_key", PARENT_KEY);
    const html = render(h(SubKeyCreated, { created, origin: BASE, onDone() {} }));
    const skillAt = html.indexOf(en.skill.blockTitle);
    const otherAt = html.indexOf(en.skill.tabOther);
    const baseUrlAt = html.lastIndexOf(`${BASE}/v1`); // the skill preview also mentions ${BASE}/v1/fetch: take the last one
    assert.ok(skillAt >= 0 && otherAt > skillAt && baseUrlAt > otherAt, "skill, then 'other ways', then the OpenAI base URL");
    assert.ok(html.includes("Copy for Codex"), "named after the agent");
    assert.ok(html.includes("mk_live_Chld"), "the preview carries the sub-key");
    assert.ok(!html.includes("mk_live_Prnt"), "never the holder's own key");
    assert.ok(html.includes("secret-notice"));
  });

  it("a wrong page address is explained, the key itself is still shown", () => {
    const html = render(h(SubKeyCreated, { created, origin: "http://moneyswitch_srv:4020", onDone() {} }));
    assert.ok(html.includes(CHILD_KEY));
    assert.ok(html.includes(fill(en.skill.badUrl, { url: "http://moneyswitch_srv:4020" })));
  });
});


describe("Payment test entry", () => {
  it("opens direct x402 requests by default for administrators", async () => {
    const Page = (await import("../src/pages/PlaygroundPage.tsx")).default;
    const html = render(h(Page));
    assert.ok(html.includes('id="paid-fetch-url"'));
    assert.ok(html.includes('data-action-id="payment.fetch"'));
  });
  it("lets employees test x402 without re-entering or exposing their key", async () => {
    store.set("moneyswitch_employee_key", KEY);
    const Page = (await import("../src/pages/employee/EmployeePlaygroundPage.tsx")).default;
    const html = render(h(Page));
    assert.ok(html.includes('id="paid-fetch-url"'));
    assert.ok(html.includes('data-action-id="payment.fetch"'));
    assert.ok(!html.includes(KEY));
    assert.ok(!html.includes('href="/wallet"'));
    assert.ok(html.includes("spending limit, not wallet balance"));
  });
});
