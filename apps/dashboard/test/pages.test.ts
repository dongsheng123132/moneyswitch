// Page-level render tests (react-dom/server, no DOM): the skill is FIRST and DEFAULT on every path that hands out a
// key, the only other format is one plain HTTP example, the pages survive an address the skill renderer refuses, the
// Money Keys handoff / row actions, and the navigation of the atomic product. Interactivity (clicks) is not exercised
// here; defaults and structure are.
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

let MoneyKeysPage: typeof import("../src/pages/MoneyKeysPage.tsx").default;
let ConnectStep: typeof import("../src/pages/SetupPage.tsx").ConnectStep;
let SubKeyCreated: typeof import("../src/pages/employee/MySubKeysPage.tsx").SubKeyCreated;
let OwnKeySkillCard: typeof import("../src/pages/employee/MyBudgetPage.tsx").OwnKeySkillCard;
let KeyHandoff: typeof import("../src/components/KeyHandoff.tsx").default;
let KeyRowActions: typeof import("../src/components/KeyRowActions.tsx").default;
let adminNav: typeof import("../src/Layout.tsx").NAV;
let employeeNav: typeof import("../src/EmployeeLayout.tsx").NAV;
let LangProvider: typeof import("../src/i18n/index.tsx").LangProvider;
let AuthProvider: typeof import("../src/auth.tsx").AuthProvider;
let en: {
  keys: (typeof import("../src/i18n/strings/keys.ts"))["keysStrings"]["en"];
  skill: (typeof import("../src/i18n/strings/skill.ts"))["skillStrings"]["en"];
  setup: (typeof import("../src/i18n/strings/setup.ts"))["setupStrings"]["en"];
  shell: (typeof import("../src/i18n/strings/shell.ts"))["shellStrings"]["en"];
  employee: (typeof import("../src/i18n/strings/employee.ts"))["employeeStrings"]["en"];
};

before(async () => {
  MoneyKeysPage = (await import("../src/pages/MoneyKeysPage.tsx")).default;
  ConnectStep = (await import("../src/pages/SetupPage.tsx")).ConnectStep;
  SubKeyCreated = (await import("../src/pages/employee/MySubKeysPage.tsx")).SubKeyCreated;
  OwnKeySkillCard = (await import("../src/pages/employee/MyBudgetPage.tsx")).OwnKeySkillCard;
  KeyHandoff = (await import("../src/components/KeyHandoff.tsx")).default;
  KeyRowActions = (await import("../src/components/KeyRowActions.tsx")).default;
  adminNav = (await import("../src/Layout.tsx")).NAV;
  employeeNav = (await import("../src/EmployeeLayout.tsx")).NAV;
  LangProvider = (await import("../src/i18n/index.tsx")).LangProvider;
  AuthProvider = (await import("../src/auth.tsx")).AuthProvider;
  en = {
    keys: (await import("../src/i18n/strings/keys.ts")).keysStrings.en,
    skill: (await import("../src/i18n/strings/skill.ts")).skillStrings.en,
    setup: (await import("../src/i18n/strings/setup.ts")).setupStrings.en,
    shell: (await import("../src/i18n/strings/shell.ts")).shellStrings.en,
    employee: (await import("../src/i18n/strings/employee.ts")).employeeStrings.en,
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
/** Formats that used to exist and must not come back as a way to hand a key to an AI. */
const REMOVED_FORMATS = ["claude mcp add", "mcp_servers", "MCP", "OpenAI", "new-api", "NewAPI", "npx -y"];

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

describe("KeyHandoff (the drawer after 'Create key' or 'Reset secret and copy skill')", () => {
  const props = {
    skillBase: BASE,
    apiBase: BASE,
    onTryPlayground() {},
    onDone() {},
  };
  const created = { id: 1, kind: "created", key: KEY, name: "Codex" } as const;
  const rotated = { id: 2, kind: "rotated", key: KEY, name: "Codex" } as const;

  it("a new key opens on the skill tab: skill first, selected, the block with a copy button, the plain HTTP example not shown", () => {
    const html = render(h(KeyHandoff, { ...props, handoff: created }));
    assert.ok(html.includes(en.keys.createdBanner));
    assert.match(html, /role="tab" aria-selected="true" class="tab-btn active">Give this to your AI \(skill\)/);
    assert.match(html, /role="tab" aria-selected="false" class="tab-btn ">Plain HTTP \(advanced\)/);
    assert.ok(html.includes("Copy for Codex"), "named key -> agent preselected");
    assert.ok(html.includes("secret-notice"));
    assert.ok(!html.includes(en.skill.otherIntro), "the other way is behind its tab");
    assert.ok(!html.includes(en.skill.rawHttpTitle));
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

  it("the only other way is ONE raw HTTP example for POST /v1/fetch (initialTopTab=other); MCP, Codex TOML, OpenAI and new-api are gone", () => {
    const html = render(h(KeyHandoff, { ...props, handoff: created, initialTopTab: "other" }));
    assert.match(html, /aria-selected="true" class="tab-btn active">Plain HTTP \(advanced\)/);
    assert.ok(html.includes(en.skill.otherIntro));
    assert.ok(html.includes(en.skill.rawHttpTitle));
    assert.ok(html.includes(`curl ${BASE}/v1/fetch`), "the curl example for /v1/fetch");
    assert.equal(html.split("curl ").length - 1, 1, "exactly one example");
    assert.ok(!html.includes(en.skill.blockTitle), "the skill block is behind its own tab");
    for (const removed of REMOVED_FORMATS) assert.ok(!html.includes(removed), `${removed} is not offered any more`);
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

describe("Setup wizard, last step 'give the skill to your AI'", () => {
  const created = { id: "k1", name: "Codex", key: KEY } as unknown as Parameters<typeof ConnectStep>[0]["created"];

  it("offers the skill FIRST (agent selector + copy button) and the plain HTTP example only under 'other ways'", () => {
    const html = render(h(ConnectStep, { created, usedAt: null, skillBase: BASE }));
    const skillAt = html.indexOf(en.skill.blockTitle);
    const otherAt = html.indexOf(en.setup.s5_otherWays);
    const httpAt = html.indexOf(`curl ${BASE}/v1/fetch`);
    assert.ok(skillAt >= 0, "skill block present");
    assert.ok(html.includes("Copy for Codex"));
    assert.ok(html.includes('role="radiogroup"'));
    assert.ok(otherAt > skillAt, "other ways come after the skill");
    assert.ok(httpAt > otherAt, "the HTTP example sits under the 'other ways' heading");
    assert.match(html, /<details class="setup-other"><summary>/);
    assert.ok(html.includes(en.setup.s5_waiting));
    for (const removed of REMOVED_FORMATS) assert.ok(!html.includes(removed), `${removed} is not offered any more`);
  });

  it("says it is connected once the key was used", () => {
    assert.ok(render(h(ConnectStep, { created, usedAt: "2026-10-02T00:00:00Z", skillBase: BASE })).includes(en.setup.s5_connected));
  });

  it("without a key: the hint and the way to the Money Keys page, no skill block", () => {
    const html = render(h(ConnectStep, { created: null, usedAt: null, skillBase: BASE }));
    assert.ok(html.includes(en.setup.s5_noKey));
    assert.ok(html.includes('href="/keys"'));
    assert.ok(!html.includes(en.skill.blockTitle));
  });

  it("a wrong page address is explained instead of crashing the wizard", () => {
    const html = render(h(ConnectStep, { created, usedAt: null, skillBase: "http://moneyswitch_srv:4020" }));
    assert.ok(html.includes(fill(en.skill.badUrl, { url: "http://moneyswitch_srv:4020" })));
    assert.ok(html.includes("/v1/fetch"), "the plain HTTP route is still offered");
  });

  it("Chinese", () => {
    const html = render(h(ConnectStep, { created, usedAt: null, skillBase: BASE }), "zh");
    assert.ok(html.includes("复制，给 Codex"));
    assert.ok(html.includes("其他方式（进阶）：纯 HTTP"));
  });
});

describe("Employee portal: the skill for the holder's own key and for a sub-key", () => {
  const created = { id: "c1", name: "Codex", key: CHILD_KEY } as unknown as Parameters<typeof SubKeyCreated>[0]["created"];

  it("a new sub-key: the skill for the NEW key (not the holder's own) before the raw HTTP example", () => {
    store.set("moneyswitch_employee_key", PARENT_KEY);
    const html = render(h(SubKeyCreated, { created, origin: BASE, onDone() {} }));
    const skillAt = html.indexOf(en.skill.blockTitle);
    const otherAt = html.indexOf(en.skill.tabOther);
    const httpAt = html.indexOf(`curl ${BASE}/v1/fetch`);
    assert.ok(skillAt >= 0 && otherAt > skillAt && httpAt > otherAt, "skill, then 'other way', then the HTTP example");
    assert.ok(html.includes("Copy for Codex"), "named after the agent");
    assert.ok(html.includes("mk_live_Chld"), "the preview carries the sub-key");
    assert.ok(!html.includes("mk_live_Prnt"), "never the holder's own key");
    assert.ok(html.includes("secret-notice"));
    for (const removed of REMOVED_FORMATS) assert.ok(!html.includes(removed), `${removed} is not offered any more`);
  });

  it("a wrong page address is explained, the key itself is still shown", () => {
    const html = render(h(SubKeyCreated, { created, origin: "http://moneyswitch_srv:4020", onDone() {} }));
    assert.ok(html.includes(CHILD_KEY));
    assert.ok(html.includes(fill(en.skill.badUrl, { url: "http://moneyswitch_srv:4020" })));
  });

  it("the holder's OWN key has its skill on the budget page (there is no separate connect page any more)", () => {
    const html = render(h(OwnKeySkillCard, { secret: KEY, origin: BASE }));
    assert.ok(html.includes(en.skill.employeeTitle));
    assert.ok(html.includes(en.skill.blockTitle));
    assert.ok(html.includes("Copy for Codex"));
    assert.ok(html.includes("name: moneyswitch-pay"));
    assert.ok(html.includes("mk_live_Ab3d"), "masked preview");
    assert.ok(!html.includes(KEY), "the real key is never rendered as text");
    for (const removed of REMOVED_FORMATS) assert.ok(!html.includes(removed), `${removed} is not offered any more`);
  });

  it("the holder's own skill survives a wrong page address", () => {
    const html = render(h(OwnKeySkillCard, { secret: KEY, origin: "http://moneyswitch_srv:4020" }));
    assert.ok(html.includes(fill(en.skill.badUrl, { url: "http://moneyswitch_srv:4020" })));
  });
});

describe("every way to copy the skill that exists after the trim", () => {
  it("create key, reset secret (drawer and row button), setup wizard, sub-key created and the holder's own key all offer 'Copy for <agent>'", () => {
    const handoff = { id: 1, kind: "created", key: KEY, name: "Codex" } as const;
    const drawerProps = { skillBase: BASE, apiBase: BASE, onTryPlayground() {}, onDone() {} };
    const row = { childrenCount: 0, confirmingRevoke: false, revoking: false, onRotate() {}, onAskRevoke() {}, onRevoke() {}, onCancelRevoke() {} };
    const wizardKey = { id: "k1", name: "Codex", key: KEY } as unknown as Parameters<typeof ConnectStep>[0]["created"];
    const subKey = { id: "c1", name: "Codex", key: CHILD_KEY } as unknown as Parameters<typeof SubKeyCreated>[0]["created"];
    assert.ok(render(h(KeyHandoff, { ...drawerProps, handoff })).includes("Copy for Codex"), "create key");
    assert.ok(render(h(KeyHandoff, { ...drawerProps, handoff: { ...handoff, kind: "rotated" } })).includes("Copy for Codex"), "reset secret (drawer)");
    assert.ok(render(h(KeyRowActions, { ...row, status: "active" })).includes(">Reset secret and copy skill<"), "reset secret (row button)");
    assert.ok(render(h(ConnectStep, { created: wizardKey, usedAt: null, skillBase: BASE })).includes("Copy for Codex"), "setup wizard");
    assert.ok(render(h(SubKeyCreated, { created: subKey, origin: BASE, onDone() {} })).includes("Copy for Codex"), "sub-key created");
    assert.ok(render(h(OwnKeySkillCard, { secret: KEY, origin: BASE })).includes("Copy for Codex"), "the holder's own key");
  });
});

describe("navigation of the atomic product", () => {
  it("admin: Overview, Test payment, Keys, Usage, Approvals, Wallet (and nothing else)", () => {
    assert.deepEqual(
      adminNav.map((n) => n.to),
      ["/", "/playground", "/keys", "/usage", "/approvals", "/wallet"]
    );
    assert.deepEqual(
      adminNav.map((n) => en.shell[n.label]),
      ["Overview", "Test payment", "Money Keys", "Usage", "Approvals", "Wallet"]
    );
  });

  it("employee: budget, test payment, history, sub-keys (sub-keys only for a key that can delegate)", () => {
    assert.deepEqual(
      employeeNav.map((n) => n.to),
      ["/me/budget", "/me/playground", "/me/history", "/me/children"]
    );
    assert.deepEqual(
      employeeNav.map((n) => en.employee[n.key]),
      ["My budget", "Test payment", "History", "My sub-keys"]
    );
    assert.deepEqual(
      employeeNav.filter((n) => "requiresDelegate" in n && n.requiresDelegate).map((n) => n.to),
      ["/me/children"]
    );
  });
});

describe("Payment test entry", () => {
  it("opens direct x402 requests by default for administrators, with no chat tab", async () => {
    const Page = (await import("../src/pages/PlaygroundPage.tsx")).default;
    const html = render(h(Page));
    assert.ok(html.includes('id="paid-fetch-url"'));
    assert.ok(html.includes('data-action-id="payment.fetch"'));
    assert.ok(!html.includes("pg-tabs"), "no tab bar: there is nothing but the paid request");
    assert.ok(!/\bChat\b/.test(html), "no chat");
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
    assert.ok(!html.includes("pg-tabs"));
  });
});
