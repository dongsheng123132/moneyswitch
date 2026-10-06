// Page-level render tests (react-dom/server, no DOM): the dashboard is exactly the four pages of SPEC.md §2 plus the login, the key form
// offers the ten-minute path's test payment only where it can work, the approval link opens the Approvals page on the right request,
// and the Bills page says for every payment whether the money left (yes / no / maybe). Interactivity (clicks) is not exercised
// here; defaults, structure and the calls the buttons make are.
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";

// api.ts reads sessionStorage; i18n reads localStorage; pages read window.location at render time.
const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
const setOrigin = (origin: string) => Object.assign(globalThis, { window: { location: { origin, hash: "" } } });
Object.assign(globalThis, { localStorage: fakeStorage, sessionStorage: fakeStorage });
setOrigin("https://pay.example.com");

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY = "mk_live_Ab3dEf6hIj9lMn2pQr5tUv8xYz1B4cDe";
const BASE = "https://pay.example.com";
const BAD_ORIGINS = ["http://moneyswitch_srv:4020", "http://example.com.:4020"];

let MoneyKeysPage: typeof import("../src/pages/MoneyKeysPage.tsx").default;
let NoKeysYet: typeof import("../src/pages/MoneyKeysPage.tsx").NoKeysYet;
let LoginPage: typeof import("../src/pages/LoginPage.tsx").default;
let ApprovalsModule: typeof import("../src/pages/ApprovalsPage.tsx");
let BillsModule: typeof import("../src/pages/BillsPage.tsx");
let KeyHandoff: typeof import("../src/components/KeyHandoff.tsx").default;
let KeyRowActions: typeof import("../src/components/KeyRowActions.tsx").default;
let AllowedHostsField: typeof import("../src/components/AllowedHostsField.tsx").default;
let NetworkModeField: typeof import("../src/components/NetworkModeField.tsx").default;
let KeyNetworkBadge: typeof import("../src/components/KeyNetworkBadge.tsx").default;
let NetworkBadge: typeof import("../src/components/NetworkBadge.tsx").default;
let networkModeHelpers: typeof import("../src/networkMode.ts");
let testPaymentAvailable: typeof import("../src/skillText.ts").testPaymentAvailable;
let nav: typeof import("../src/Layout.tsx").NAV;
let LangProvider: typeof import("../src/i18n/index.tsx").LangProvider;
let AuthProvider: typeof import("../src/auth.tsx").AuthProvider;
let TEST_PAYMENT_URL: string;
let en: {
  keys: (typeof import("../src/i18n/strings/keys.ts"))["keysStrings"]["en"];
  skill: (typeof import("../src/i18n/strings/skill.ts"))["skillStrings"]["en"];
  shell: (typeof import("../src/i18n/strings/shell.ts"))["shellStrings"]["en"];
  approvals: (typeof import("../src/i18n/strings/approvals.ts"))["approvalsStrings"]["en"];
  bills: (typeof import("../src/i18n/strings/bills.ts"))["billsStrings"]["en"];
  common: (typeof import("../src/i18n/strings/common.ts"))["common"]["en"];
};
let zhKeys: (typeof import("../src/i18n/strings/keys.ts"))["keysStrings"]["zh"];
let zhBills: (typeof import("../src/i18n/strings/bills.ts"))["billsStrings"]["zh"];
let zhCommon: (typeof import("../src/i18n/strings/common.ts"))["common"]["zh"];
let zhShell: (typeof import("../src/i18n/strings/shell.ts"))["shellStrings"]["zh"];

before(async () => {
  ({ default: MoneyKeysPage, NoKeysYet } = await import("../src/pages/MoneyKeysPage.tsx"));
  LoginPage = (await import("../src/pages/LoginPage.tsx")).default;
  ApprovalsModule = await import("../src/pages/ApprovalsPage.tsx");
  BillsModule = await import("../src/pages/BillsPage.tsx");
  KeyHandoff = (await import("../src/components/KeyHandoff.tsx")).default;
  KeyRowActions = (await import("../src/components/KeyRowActions.tsx")).default;
  AllowedHostsField = (await import("../src/components/AllowedHostsField.tsx")).default;
  NetworkModeField = (await import("../src/components/NetworkModeField.tsx")).default;
  KeyNetworkBadge = (await import("../src/components/KeyNetworkBadge.tsx")).default;
  NetworkBadge = (await import("../src/components/NetworkBadge.tsx")).default;
  networkModeHelpers = await import("../src/networkMode.ts");
  nav = (await import("../src/Layout.tsx")).NAV;
  LangProvider = (await import("../src/i18n/index.tsx")).LangProvider;
  AuthProvider = (await import("../src/auth.tsx")).AuthProvider;
  ({ TEST_PAYMENT_URL, testPaymentAvailable } = await import("../src/skillText.ts"));
  en = {
    keys: (await import("../src/i18n/strings/keys.ts")).keysStrings.en,
    skill: (await import("../src/i18n/strings/skill.ts")).skillStrings.en,
    shell: (await import("../src/i18n/strings/shell.ts")).shellStrings.en,
    approvals: (await import("../src/i18n/strings/approvals.ts")).approvalsStrings.en,
    bills: (await import("../src/i18n/strings/bills.ts")).billsStrings.en,
    common: (await import("../src/i18n/strings/common.ts")).common.en,
  };
  zhKeys = (await import("../src/i18n/strings/keys.ts")).keysStrings.zh;
  zhBills = (await import("../src/i18n/strings/bills.ts")).billsStrings.zh;
  zhCommon = (await import("../src/i18n/strings/common.ts")).common.zh;
  zhShell = (await import("../src/i18n/strings/shell.ts")).shellStrings.zh;
});

beforeEach(() => {
  setOrigin(BASE);
  store.clear();
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0], lang: "en" | "zh" = "en", location = "/") => {
  store.set("moneyswitch_lang", lang);
  return renderToStaticMarkup(h(LangProvider, null, h(StaticRouter, { location }, h(AuthProvider, null, el))));
};

/** The way React escapes text into HTML, so a string with quotes or apostrophes can be searched for in rendered markup. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
/** Applies a "{name}" substitution the way t() does and escapes the result for markup, so assertions track the strings instead of copies of them. */
const fill = (s: string, vars: Record<string, string | number>) => esc(s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k])));
/** Formats that used to exist and must not come back as a way to hand a key to an AI. */
const REMOVED_FORMATS = ["claude mcp add", "mcp_servers", "MCP", "OpenAI", "new-api", "NewAPI", "npx -y"];

describe("the dashboard is the four pages of SPEC.md §2 and the login", () => {
  it("navigation: Wallet, Keys, Approvals, Bills - in that order, nothing else", () => {
    assert.deepEqual(
      nav.map((n) => n.to),
      ["/wallet", "/keys", "/approvals", "/bills"]
    );
    assert.deepEqual(
      nav.map((n) => en.shell[n.label]),
      ["Wallet", "Keys", "Approvals", "Bills"]
    );
    assert.deepEqual(
      nav.map((n) => zhShell[n.label]),
      ["钱包", "Key", "审批", "账单"]
    );
  });

  it("the router knows no other page, and the page folder holds five files: the four pages and the login", () => {
    const app = fs.readFileSync(path.join(here, "../src/App.tsx"), "utf8");
    const paths = [...app.matchAll(/<Route\s+(?:index|path="([^"]*)")/g)].map((m) => m[1] ?? "(index)").sort();
    assert.deepEqual(paths, ["(index)", "*", "/", "/login", "approvals", "bills", "keys", "wallet"].sort());
    assert.deepEqual(fs.readdirSync(path.join(here, "../src/pages")).sort(), ["ApprovalsPage.tsx", "BillsPage.tsx", "LoginPage.tsx", "MoneyKeysPage.tsx", "WalletPage.tsx"]);
  });
});

describe("Login", () => {
  it("asks for the administrator token only: no employee key, no setup wizard; it says where the token comes from and how to get a new one", () => {
    const html = render(h(LoginPage), "en", "/login");
    assert.ok(html.includes('id="login-token"'));
    assert.ok(html.includes(esc(en.shell.login_label)));
    assert.ok(html.includes(esc(en.shell.login_where)), "the first-start link points at /login#ms_setup_…");
    // a lost token: the one command per way of running it (SPEC.md §2 - Docker included), all run on the server itself
    assert.ok(html.includes("moneyswitch-server reset-admin-token --data-dir"), "npm");
    assert.ok(html.includes("docker compose exec server node /app/dist/cli.js reset-admin-token"), "Docker");
    assert.ok(html.includes("pnpm admin:reset-token -- --data-dir"), "from source");
    assert.ok(html.includes(esc(en.shell.login_lostBody)));
    assert.ok(!html.includes("employee"), "no employee login any more");
    assert.ok(!/setup#/.test(html));
  });

  it("is available in Chinese", () => {
    assert.ok(render(h(LoginPage), "zh", "/login").includes("管理员令牌"));
  });
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

  it("with no key yet it says so and offers 'Create your first key' (in both languages)", () => {
    const html = render(h(NoKeysYet, { onCreate() {} }));
    assert.ok(html.includes(en.keys.actionCreateFirst), "the button");
    assert.ok(html.includes(en.keys.emptyNoKeysTitle));
    assert.equal(en.keys.actionCreateFirst, "Create your first key");
    const zh = render(h(NoKeysYet, { onCreate() {} }), "zh");
    assert.ok(zh.includes("新建第一把 Key"));
  });

  it("there is no UI for child keys (SPEC.md §8): no 'allow sub-keys' option in the form, no tree, no sub-key labels", () => {
    const page = fs.readFileSync(path.join(here, "../src/pages/MoneyKeysPage.tsx"), "utf8");
    assert.ok(!/can_delegate|collapsedIds|keys-tree|sub-key|canDelegate/i.test(page), "the Keys page source mentions no delegation or tree");
    assert.ok(!Object.keys(en.keys).some((k) => /delegate|createdByParent|childrenCount|expandRow|collapseRow/i.test(k)), "and the strings have none either");
  });
});

describe("the ten-minute path: the test payment endpoint in the key form", () => {
  const props = { value: "", onChange() {}, allowTest: true, onAllowTestChange() {} };

  it("on a testnet the checkbox is there, checked by default, names the endpoint and says what it adds", () => {
    const html = render(h(AllowedHostsField, { ...props, testAvailable: true }));
    assert.match(html, /<input type="checkbox" checked=""/);
    assert.ok(html.includes(fill(en.keys.testEndpointLabel, { url: TEST_PAYMENT_URL })));
    assert.ok(html.includes(esc(en.keys.testEndpointHint)));
    assert.ok(html.includes("app.moneyswitch.dev:443"));
    assert.ok(!html.includes(esc(en.keys.allowedHostsHintEmpty)), "the key is not empty: the test host is added");
  });

  it("unticked it adds nothing and the empty-hosts warning is back", () => {
    const html = render(h(AllowedHostsField, { ...props, testAvailable: true, allowTest: false }));
    assert.ok(!/<input type="checkbox" checked=""/.test(html));
    assert.ok(!html.includes(esc(en.keys.testEndpointHint)));
    assert.ok(html.includes(esc(en.keys.allowedHostsHintEmpty)));
  });

  it("a mixed instance (testnet and mainnet both enabled): a testnet key gets the checkbox, a mainnet key never does (the availability the page computes, fed to the form)", () => {
    const net = (network: string, is_mainnet: boolean) => ({ network, chain_id: 1, usdc_address: "0x1", network_label: network, explorer_base: "https://x", is_mainnet });
    const mixed = { networks: [net("eip155:10143", false), net("eip155:143", true)] };
    const testnetsOnly = { networks: [net("eip155:10143", false), net("eip155:84532", false)] };
    const mixedTestnetKey = render(h(AllowedHostsField, { ...props, testAvailable: testPaymentAvailable(mixed, "testnet") }));
    assert.ok(mixedTestnetKey.includes('type="checkbox"'));
    assert.match(mixedTestnetKey, /<input type="checkbox" checked=""/, "ticked by default");
    assert.ok(mixedTestnetKey.includes("app.moneyswitch.dev"));
    const mixedMainnetKey = render(h(AllowedHostsField, { ...props, testAvailable: testPaymentAvailable(mixed, "mainnet") }));
    assert.ok(!mixedMainnetKey.includes('type="checkbox"'));
    assert.ok(!mixedMainnetKey.includes("app.moneyswitch.dev"));
    assert.ok(render(h(AllowedHostsField, { ...props, testAvailable: testPaymentAvailable(testnetsOnly, "testnet") })).includes('type="checkbox"'));
  });

  it("where the test payment is not on offer (mainnet default, or unknown) there is no checkbox and no mention of the endpoint", () => {
    const html = render(h(AllowedHostsField, { ...props, testAvailable: false }));
    assert.ok(!html.includes('type="checkbox"'));
    assert.ok(!html.includes("app.moneyswitch.dev"));
    assert.ok(html.includes(esc(en.keys.allowedHostsHintEmpty)));
  });
});

describe("KeyHandoff (the drawer after 'Create key' or 'Reset secret and copy skill')", () => {
  const props = { skillBase: BASE, apiBase: BASE, onDone() {} };
  const created = { id: 1, kind: "created", key: KEY, name: "Codex", allowedHosts: ["api.example.com:443"] } as const;
  const rotated = { id: 2, kind: "rotated", key: KEY, name: "Codex", allowedHosts: ["api.example.com:443"] } as const;

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

  describe("the install text asks for the test payment only when the key allows it and the instance is on a testnet", () => {
    const withTestHost = { ...created, allowedHosts: ["api.example.com:443", "app.moneyswitch.dev:443"] };

    it("testnet + the key may pay the test host: the text the AI gets carries the test endpoint and asks for the tx hash", () => {
      const html = render(h(KeyHandoff, { ...props, handoff: withTestHost, testnet: true }));
      assert.ok(html.includes(TEST_PAYMENT_URL));
      assert.ok(/ONE test payment/.test(html));
      assert.ok(!html.includes("do not make a payment during installation"));
    });

    it("testnet but the key may not pay the test host: no test payment in the text", () => {
      const html = render(h(KeyHandoff, { ...props, handoff: created, testnet: true }));
      assert.ok(!html.includes(TEST_PAYMENT_URL));
      assert.ok(html.includes("do not make a payment during installation"));
    });

    it("the key may pay the test host but the instance is not on a testnet (mainnet default): no test payment", () => {
      const html = render(h(KeyHandoff, { ...props, handoff: withTestHost, testnet: false }));
      assert.ok(!html.includes(TEST_PAYMENT_URL));
      assert.ok(html.includes("do not make a payment during installation"));
    });

    it("the text the AI gets says whether the key is a testnet key (test USDC, no value) or a mainnet key (real USDC)", () => {
      const testnet = render(h(KeyHandoff, { ...props, handoff: { ...created, networkMode: "testnet" } }));
      assert.ok(testnet.includes("This is a **testnet** key"));
      assert.ok(testnet.includes("testnet: test USDC with no real value"));
      assert.ok(!testnet.includes("**mainnet** key: it pays"));
      const mainnet = render(h(KeyHandoff, { ...props, handoff: { ...created, networkMode: "mainnet" } }));
      assert.ok(mainnet.includes("This is a **mainnet** key"));
      assert.ok(mainnet.includes("mainnet: real USDC, real money"));
      assert.ok(!mainnet.includes("This is a **testnet** key"));
      assert.ok(!mainnet.includes(TEST_PAYMENT_URL), "a mainnet key is never asked for the test payment");
      const old = render(h(KeyHandoff, { ...props, handoff: { ...created, networkMode: null } }));
      assert.ok(!old.includes("This is a **testnet** key") && !old.includes("This is a **mainnet** key"), "a key from before network types says nothing");
    });

    it("a reset key is treated like a new one (its hosts come with the reset response)", () => {
      const html = render(h(KeyHandoff, { ...props, handoff: { ...withTestHost, kind: "rotated" as const }, testnet: true }));
      assert.ok(html.includes(TEST_PAYMENT_URL));
    });
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

describe("Approvals page: the link the AI sends opens it on the right request", () => {
  const pendingRow = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    key_id: "key-1",
    url: `https://api.example.com/${id}`,
    method: "GET",
    network: "eip155:10143",
    asset: "0xusdc",
    pay_to: "0x000000000000000000000000000000000000dEaD",
    amount: "0.15",
    status: "pending" as const,
    expires_at: "2026-10-04T12:10:00.000Z",
    decided_at: null,
    created_at: "2026-10-04T12:00:00.000Z",
    ...over,
  });
  const key = { id: "key-1", name: "Codex", used_today: "0.05", daily_budget: "1", per_request_limit: "0.5", approval_threshold: "0.1" };
  const NOW = Date.parse("2026-10-04T12:05:00.000Z");
  const view = (over: Record<string, unknown> = {}) =>
    render(
      h(ApprovalsModule.ApprovalsView, {
        pending: [pendingRow("ap-1"), pendingRow("ap-2")],
        all: null,
        keys: [key as never],
        highlightId: null,
        actingId: null,
        successMsg: null,
        actionError: null,
        error: null,
        now: NOW,
        onAct() {},
        ...over,
      } as never),
      "en",
      "/approvals?id=ap-2"
    );

  it("?id=… marks that request (and only that one), so the page can scroll to it", () => {
    const html = view({ highlightId: "ap-2" });
    assert.match(html, /<div class="approval-card approval-highlight"[^>]*data-approval-id="ap-2"[^>]*data-highlight="true"[^>]*aria-current="true"/);
    assert.equal(html.split("data-highlight").length - 1, 1);
    assert.match(html, /<div class="approval-card"[^>]*data-approval-id="ap-1"/);
  });

  it("each request shows what is being bought, from which key, for how much, and how long is left, with Approve and Deny", () => {
    const html = view({ highlightId: "ap-2" });
    assert.ok(html.includes("Codex"));
    assert.ok(html.includes("https://api.example.com/ap-2"));
    assert.ok(html.includes(fill(en.approvals.countdownLeft, { m: 5, s: "00" })));
    assert.equal(html.split(`>${en.approvals.approve}<`).length - 1, 2);
    assert.equal(html.split(`>${en.approvals.deny}<`).length - 1, 2);
  });

  it("a link to a request that was already handled says what became of it instead of showing nothing", () => {
    const html = view({ pending: [pendingRow("ap-1")], all: [pendingRow("ap-1"), pendingRow("ap-2", { status: "approved", decided_at: "2026-10-04T12:03:00.000Z" })], highlightId: "ap-2" });
    assert.ok(html.includes('data-testid="linked-already"'));
    assert.ok(html.includes(fill(en.approvals.linkedAlready, { status: en.approvals.statusApproved })));
    assert.ok(!html.includes("data-highlight"));
  });

  it("a link to an unknown request says so, once the list has loaded", () => {
    assert.ok(view({ all: [pendingRow("ap-1")], highlightId: "nope" }).includes('data-testid="linked-not-found"'));
    assert.ok(!view({ all: null, highlightId: "nope" }).includes('data-testid="linked-not-found"'), "not before the list is there");
  });

  it("with nothing pending the page says so and points to the keys", () => {
    const html = view({ pending: [] });
    assert.ok(html.includes(esc(en.approvals.emptyTitle)));
    assert.ok(html.includes('href="/keys"'));
  });

  it("Approve and Deny are one authenticated call each to the administrator API (the link itself carries no token)", async () => {
    const real = globalThis.fetch;
    const calls: Array<{ url: string; method?: string; auth?: string }> = [];
    store.set("moneyswitch_admin_token", "ms_admin_testtoken");
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method, auth: (init.headers as Record<string, string>).Authorization });
      return new Response(JSON.stringify({ id: "ap-2", status: "approved" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      assert.equal(await ApprovalsModule.submitDecision("ap-2", "approve"), "approved");
      assert.equal(await ApprovalsModule.submitDecision("ap-2", "deny"), "denied");
    } finally {
      globalThis.fetch = real;
    }
    assert.deepEqual(calls, [
      { url: "/v1/approvals/ap-2/approve", method: "POST", auth: "Bearer ms_admin_testtoken" },
      { url: "/v1/approvals/ap-2/deny", method: "POST", auth: "Bearer ms_admin_testtoken" },
    ]);
  });

  describe("a request to a host outside the key's list (SPEC.md §3)", () => {
    const hostRow = (id: string, over: Record<string, unknown> = {}) =>
      pendingRow(id, { kind: "host", url: "https://API.NewHost.example/v1/data?x=1", host: "api.newhost.example:443", network: "", asset: "", pay_to: "", amount: "0", ...over });
    const hostView = (lang: "en" | "zh", over: Record<string, unknown> = {}) =>
      render(
        h(ApprovalsModule.ApprovalsView, {
          pending: [hostRow("ap-h")],
          all: null,
          keys: [key as never],
          highlightId: null,
          actingId: null,
          successMsg: null,
          actionError: null,
          error: null,
          now: NOW,
          onAct() {},
          ...over,
        } as never),
        lang
      );

    it("is marked 'New host', shows the host:port that will be listed, the URL it came from and the sentence about what approving does; no amount, no payee, no checkbox", () => {
      const html = hostView("en");
      assert.ok(html.includes('data-testid="host-approval"'));
      assert.ok(html.includes(esc(en.approvals.hostBadge)));
      assert.ok(html.includes("api.newhost.example:443"));
      assert.ok(html.includes("https://API.NewHost.example/v1/data?x=1"));
      assert.ok(html.includes(esc(en.approvals.hostSource)));
      assert.ok(html.includes(fill(en.approvals.hostNote, { host: "api.newhost.example:443" })));
      assert.ok(!html.includes('class="approval-amount'), "no price yet, so no amount");
      assert.ok(!html.includes("pay to"), "no payee yet");
      assert.ok(!html.includes("<input"), "nothing to tick: approving is the one decision");
      assert.equal(html.split(`>${en.approvals.approve}<`).length - 1, 1);
      assert.equal(html.split(`>${en.approvals.deny}<`).length - 1, 1);
    });

    it("the marker, the host:port, the source and the sentence are in Chinese too", async () => {
      const zh = (await import("../src/i18n/strings/approvals.ts")).approvalsStrings.zh;
      const html = hostView("zh", { pending: [hostRow("ap-h", { url: "http://Seller.Example:8080/x", host: "seller.example:8080" })] });
      assert.ok(html.includes(esc(zh.hostBadge)));
      assert.equal(zh.hostBadge, "新域名");
      assert.ok(html.includes("seller.example:8080"));
      assert.ok(html.includes("http://Seller.Example:8080/x"));
      assert.ok(html.includes(esc(zh.hostSource)));
      assert.equal(fill(zh.hostNote, { host: "seller.example:8080" }), "批准后，这把 key 以后都可以访问 seller.example:8080；价格要等卖家报价，额度照常检查。");
      assert.ok(html.includes(fill(zh.hostNote, { host: "seller.example:8080" })));
    });

    it("a payment approval looks exactly as before: amount and payee, no marker; so does one from a server that sends no kind", () => {
      for (const row of [pendingRow("ap-p", { kind: "payment" }), pendingRow("ap-q")]) {
        const html = view({ pending: [row] });
        assert.ok(!html.includes("host-approval"));
        assert.ok(!html.includes(esc(en.approvals.hostBadge)));
        assert.ok(!html.includes("approval-host-note"));
        assert.ok(html.includes('class="approval-amount num"'));
        assert.ok(html.includes("0.15"));
        assert.ok(html.includes("pay to"));
      }
    });

    it("the host:port shown is the server's `host` field, as it will be listed: the page reads no URL (IDN, upper case and a trailing dot included)", () => {
      // the server's reading of this URL (core's hostPortOf, tested there and in the server's tests): punycode, lower case, no trailing dot
      const url = "https://BÜCHER.Example./x";
      const html = hostView("en", { pending: [hostRow("ap-h", { url, host: "xn--bcher-kva.example:443" })] });
      assert.ok(html.includes('data-testid="host-approval"'));
      assert.ok(html.includes(`<span class="mono">xn--bcher-kva.example:443</span>`));
      assert.ok(html.includes(fill(en.approvals.hostNote, { host: "xn--bcher-kva.example:443" })));
      assert.ok(html.includes(esc(url)), "the url it came from is shown as it was asked");
      // whatever the URL says, the page shows what the server sent: it does not work the host out itself
      const odd = hostView("en", { pending: [hostRow("ap-h", { url: "https://elsewhere.example/x", host: "listed.example:8443" })] });
      assert.ok(odd.includes(`<span class="mono">listed.example:8443</span>`));
      assert.ok(!odd.includes(`<span class="mono">elsewhere.example:443</span>`));
      assert.equal((ApprovalsModule as Record<string, unknown>).hostPortOf, undefined, "the page has no host:port parser of its own");
      assert.ok(!fs.readFileSync(path.join(here, "../src/pages/ApprovalsPage.tsx"), "utf8").includes("new URL("), "no URL parsing in the page");
      // the recently decided list shows the same field
      const decided = hostView("en", { pending: [], all: [hostRow("ap-d", { url, host: "xn--bcher-kva.example:443", status: "approved", decided_at: "2026-10-04T12:03:00.000Z" })] });
      assert.ok(decided.includes(`<span class="mono">xn--bcher-kva.example:443</span>`));
    });

    it("Approve is the same bodiless call for a new host: no allow_host, no content type", async () => {
      const real = globalThis.fetch;
      const calls: Array<{ url: string; method?: string; body?: unknown; contentType?: string }> = [];
      store.set("moneyswitch_admin_token", "ms_admin_testtoken");
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method, body: init.body, contentType: (init.headers as Record<string, string>)["Content-Type"] });
        return new Response(JSON.stringify({ id: "ap-h", status: "approved" }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      try {
        assert.equal(await ApprovalsModule.submitDecision("ap-h", "approve"), "approved");
      } finally {
        globalThis.fetch = real;
      }
      assert.deepEqual(calls, [{ url: "/v1/approvals/ap-h/approve", method: "POST", body: undefined, contentType: undefined }]);
      assert.ok(!fs.readFileSync(path.join(here, "../src/api.ts"), "utf8").includes("allow_host"), "the allow_host parameter is gone");
    });

    it("when the server refuses to approve because of the DNS look, the page says why, in the page's language, and the request stays in the list", async () => {
      const { ApiError } = await import("../src/api.ts");
      const zh = (await import("../src/i18n/strings/approvals.ts")).approvalsStrings.zh;
      const real = globalThis.fetch;
      store.set("moneyswitch_admin_token", "ms_admin_testtoken");
      let answer = { error: "ALLOW_HOST_PRIVATE_HOST", message: "api.newhost.example is, or resolves to, a private address" };
      globalThis.fetch = (async () => new Response(JSON.stringify(answer), { status: 400, headers: { "content-type": "application/json" } })) as typeof fetch;
      const failure = async () => {
        try {
          await ApprovalsModule.submitDecision("ap-h", "approve");
        } catch (e) {
          return e;
        }
        throw new Error("approving should have been refused");
      };
      try {
        const privateRefusal = await failure();
        assert.ok(privateRefusal instanceof ApiError && privateRefusal.status === 400);
        assert.equal(ApprovalsModule.decisionErrorMessage(privateRefusal, "approve", (k) => en.approvals[k]), en.approvals.errHostPrivate);
        assert.equal(ApprovalsModule.decisionErrorMessage(privateRefusal, "approve", (k) => zh[k]), zh.errHostPrivate);

        answer = { error: "ALLOW_HOST_UNRESOLVED", message: "api.newhost.example could not be resolved in time" };
        const unresolved = await failure();
        assert.equal(ApprovalsModule.decisionErrorMessage(unresolved, "approve", (k) => en.approvals[k]), en.approvals.errHostUnresolved);
        assert.equal(ApprovalsModule.decisionErrorMessage(unresolved, "approve", (k) => zh[k]), zh.errHostUnresolved);

        // any other refusal shows the server's own words
        answer = { error: "ALLOW_HOST_CHILD_KEY", message: "A child key's hosts cannot be widened here" };
        assert.equal(ApprovalsModule.decisionErrorMessage(await failure(), "approve", (k) => en.approvals[k]), "A child key's hosts cannot be widened here");
        assert.equal(ApprovalsModule.decisionErrorMessage(new Error("boom"), "deny", (k) => en.approvals[k]), "boom");
        assert.equal(ApprovalsModule.decisionErrorMessage("?", "deny", (k) => en.approvals[k]), "deny_failed");
      } finally {
        globalThis.fetch = real;
      }
      // the page shows the message, and the refused request is still pending in the list with its buttons
      const html = hostView("en", { actionError: en.approvals.errHostPrivate });
      assert.ok(html.includes(esc(en.approvals.errHostPrivate)));
      assert.ok(html.includes('data-testid="host-approval"'));
      assert.equal(html.split(`>${en.approvals.approve}<`).length - 1, 1);
      assert.ok(zh.errHostPrivate.includes("未批准") && zh.errHostUnresolved.includes("未批准"));
    });

    it("in the recently decided list a host request shows its host:port where a payment shows its amount", () => {
      const decided = hostRow("ap-d", { status: "approved", decided_at: "2026-10-04T12:03:00.000Z" });
      const html = view({ pending: [], all: [decided, pendingRow("ap-e", { status: "used", decided_at: "2026-10-04T12:02:00.000Z" })] });
      assert.ok(html.includes("api.newhost.example:443"));
      assert.ok(html.includes("0.15"));
    });
  });
});

describe("Bills page", () => {
  const payment = (id: string, status: string, over: Record<string, unknown> = {}) => ({
    id,
    key_id: "key-1",
    url: `https://api.example.com/${id}?q=1`,
    host: "api.example.com:443",
    method: "GET",
    network: "eip155:10143",
    asset: "0xusdc",
    pay_to: "0x000000000000000000000000000000000000dEaD",
    amount: "0.01",
    status,
    tx_hash: status === "settled" ? "0x" + "ab".repeat(32) : null,
    error_code: null,
    approval_id: null,
    created_at: "2026-10-04T12:00:00.000Z",
    updated_at: "2026-10-04T12:00:01.000Z",
    kind: "fetch",
    ...over,
  });
  const rows = [
    payment("paid", "settled"),
    payment("refused", "failed", { error_code: "PAYMENT_REJECTED", network: "eip155:84532" }),
    payment("unsure", "unknown", { error_code: "TIMEOUT_AFTER_PAYMENT" }),
    payment("flying", "reserved"),
  ];

  it("chargedOf: settled is yes, failed is no, unknown and still-in-flight are maybe", () => {
    assert.deepEqual(rows.map((r) => BillsModule.chargedOf(r as never)), ["yes", "no", "maybe", "maybe"]);
  });

  it("one row per payment with time, key, amount, URL, chain, transaction and Charged yes / no / maybe", () => {
    const html = render(
      h(BillsModule.BillsTable, {
        payments: rows as never,
        keyNames: new Map([["key-1", "Codex"]]),
        chainLabels: new Map([["eip155:10143", "Monad Testnet"], ["eip155:84532", "Base Sepolia"]]),
      })
    );
    for (const col of [en.bills.colTime, en.bills.colKey, en.bills.colAmount, en.bills.colUrl, en.bills.colChain, en.bills.colTx, en.bills.colCharged]) {
      assert.ok(html.includes(`>${col}<`), col);
    }
    assert.deepEqual([...html.matchAll(/data-charged="(\w+)"/g)].map((m) => m[1]), ["yes", "no", "maybe", "maybe"]);
    assert.ok(html.includes("Codex"));
    assert.ok(html.includes("api.example.com:443/paid"));
    assert.ok(html.includes("Monad Testnet") && html.includes("Base Sepolia"), "the chain is named, not its CAIP-2 id");
    assert.ok(html.includes("0xabababab"), "the settled payment shows its transaction");
    assert.ok(html.includes("PAYMENT_REJECTED") && html.includes("TIMEOUT_AFTER_PAYMENT"), "the reason stays visible next to a no / maybe");
    assert.ok(html.includes(esc(en.bills.chargedMaybeHint)), "a maybe is explained");
  });

  it("a truncated list says so: how many are shown and how many there are, in both languages", () => {
    const bills = { payments: rows as never, truncated: true, total: 61234 };
    const html = render(h(BillsModule.BillsTruncation, { bills }));
    assert.ok(html.includes(fill(en.bills.truncatedNotice, { shown: rows.length, total: 61234 })));
    assert.ok(html.includes("callout-warn"), "it is a warning, not a footnote");
    const zh = render(h(BillsModule.BillsTruncation, { bills }), "zh");
    assert.ok(zh.includes("只显示最近 4 笔付款（共 61234 笔）"), zh);
  });

  it("a list that is whole, or not loaded yet, shows no such notice", () => {
    const whole = render(h(BillsModule.BillsTruncation, { bills: { payments: rows as never, truncated: false, total: rows.length } }));
    assert.ok(!whole.includes("callout") && !whole.includes("Showing only"), whole);
    assert.equal(render(h(BillsModule.BillsTruncation, { bills: null })), "");
  });

  it("the table draws at most BILLS_RENDER_ROWS rows, the newest ones, and says how many match", () => {
    const many = Array.from({ length: BillsModule.BILLS_RENDER_ROWS + 700 }, (_, i) => payment(`p${i}`, "settled"));
    const visible = BillsModule.visibleBills(many as never);
    assert.equal(visible.length, BillsModule.BILLS_RENDER_ROWS);
    assert.equal(visible[0].id, "p0", "the list is newest first, so the newest rows are the ones drawn");
    const html = render(h(BillsModule.BillsTable, { payments: visible, keyNames: new Map(), chainLabels: new Map() }));
    assert.equal([...html.matchAll(/data-charged="/g)].length, BillsModule.BILLS_RENDER_ROWS);
    const note = render(h(BillsModule.BillsRenderCap, { shown: visible.length, matching: many.length }));
    assert.ok(note.includes(fill(en.bills.renderCapNotice, { shown: BillsModule.BILLS_RENDER_ROWS, matching: many.length })), note);
    const zh = render(h(BillsModule.BillsRenderCap, { shown: visible.length, matching: many.length }), "zh");
    assert.ok(zh.includes(`只列出最新的 ${BillsModule.BILLS_RENDER_ROWS} 笔（符合条件的共 ${many.length} 笔）`), zh);
  });

  it("a list that fits in the table is drawn whole and shows no cap notice", () => {
    assert.equal(BillsModule.visibleBills(rows as never), rows, "nothing is copied or cut");
    assert.equal(BillsModule.visibleBills(rows as never, rows.length).length, rows.length, "exactly at the limit is not over it");
    assert.equal(BillsModule.visibleBills(rows as never, 2).length, 2);
    assert.equal(render(h(BillsModule.BillsRenderCap, { shown: rows.length, matching: rows.length })), "");
  });

  it("the CSV keeps its original columns in order and ends with pay_to, method, approval_id, network_kind", () => {
    const csv = BillsModule.billsCsv(
      [
        payment("paid", "settled", { approval_id: "appr-1", network_kind: "testnet" }),
        payment("refused", "failed", { error_code: "PAYMENT_REJECTED", network: "eip155:143", network_kind: "mainnet" }),
        payment("odd", "settled", { network: "eip155:999" }),
      ] as never,
      new Map([["key-1", "Codex"]])
    );
    const [head, first, second, third] = csv.split("\n");
    assert.equal(head, "time,key_id,key_name,host,url,network,amount,charged,tx_hash,error_code,pay_to,method,approval_id,network_kind");
    assert.ok(first.startsWith("2026-10-04T12:00:00.000Z,key-1,Codex,api.example.com:443,https://api.example.com/paid?q=1,eip155:10143,0.01,yes,0x"), first);
    assert.ok(first.endsWith(",,0x000000000000000000000000000000000000dEaD,GET,appr-1,testnet"), first);
    assert.ok(second.endsWith(",PAYMENT_REJECTED,0x000000000000000000000000000000000000dEaD,GET,,mainnet"), second);
    assert.ok(third.endsWith(",0x000000000000000000000000000000000000dEaD,GET,,"), "a chain the server does not know: the column is empty, never guessed");
  });

  it("the CSV does not hand a spreadsheet a formula: a key name or URL that starts with = + - @ is written as text", () => {
    const csv = BillsModule.billsCsv([payment("p", "settled", { url: "@evil.example/x" })] as never, new Map([["key-1", "=1+1"]]));
    const [, line] = csv.split("\n");
    assert.ok(line.startsWith("2026-10-04T12:00:00.000Z,key-1,'=1+1,api.example.com:443,'@evil.example/x,eip155:10143,0.01,yes,"), line);
  });

  describe("mainnet and testnet are told apart and never added together (SPEC.md §2)", () => {
    const mainnetPaid = payment("m1", "settled", { network: "eip155:143", network_kind: "mainnet", amount: "2.50" });
    const mainnetMaybe = payment("m2", "unknown", { network: "eip155:8453", network_kind: "mainnet", amount: "0.50" });
    const testnetPaid = payment("t1", "settled", { network: "eip155:10143", network_kind: "testnet", amount: "0.01" });
    const testnetRefused = payment("t2", "failed", { network_kind: "testnet", amount: "9" });
    const unknownChain = payment("u1", "settled", { network: "eip155:999", network_kind: null, amount: "0.07" });

    it("every row names its chain and marks it Mainnet or Testnet (nothing is guessed for a chain the server does not know)", () => {
      const html = render(
        h(BillsModule.BillsTable, {
          payments: [mainnetPaid, testnetPaid, unknownChain] as never,
          keyNames: new Map(),
          chainLabels: new Map([["eip155:143", "Monad mainnet"], ["eip155:10143", "Monad testnet"]]),
        })
      );
      const rowsHtml = html.split("<tr").slice(2);
      assert.equal(rowsHtml.length, 3);
      assert.ok(rowsHtml[0].includes("Monad mainnet") && rowsHtml[0].includes('data-network-kind="mainnet"') && rowsHtml[0].includes(`>${en.common.kindMainnet}<`));
      assert.ok(rowsHtml[1].includes("Monad testnet") && rowsHtml[1].includes('data-network-kind="testnet"') && rowsHtml[1].includes(`>${en.common.kindTestnet}<`));
      assert.ok(rowsHtml[2].includes("eip155:999") && !rowsHtml[2].includes("data-network-kind"));
    });

    it("the totals are one per kind and never one sum: 2.50 + 0.50 real USDC, 0.01 test USDC (a refused payment counts for neither)", () => {
      assert.deepEqual(BillsModule.billsTotalsByKind([mainnetPaid, mainnetMaybe, testnetPaid, testnetRefused] as never), [
        { kind: "mainnet", total: "3" },
        { kind: "testnet", total: "0.01" },
      ]);
      const html = render(h(BillsModule.BillsSummary, { payments: [mainnetPaid, mainnetMaybe, testnetPaid, testnetRefused] as never }));
      assert.ok(html.includes(esc(en.bills.summaryTotalMainnet)) && html.includes(esc(en.bills.summaryTotalTestnet)));
      assert.ok(/data-total-kind="mainnet"[^]*?3 USDC/.test(html), html);
      assert.ok(/data-total-kind="testnet"[^]*?0\.01 USDC/.test(html), html);
      assert.ok(!html.includes("3.01"), "the two kinds are never added");
      assert.ok(!html.includes(`>${en.bills.summaryTotal}<`), "no single total across kinds");
    });

    it("only one kind in the list: only that one total is shown", () => {
      const onlyTestnet = render(h(BillsModule.BillsSummary, { payments: [testnetPaid] as never }));
      assert.ok(onlyTestnet.includes(esc(en.bills.summaryTotalTestnet)));
      assert.ok(!onlyTestnet.includes(esc(en.bills.summaryTotalMainnet)));
      const onlyMainnet = render(h(BillsModule.BillsSummary, { payments: [mainnetPaid] as never }));
      assert.ok(onlyMainnet.includes(esc(en.bills.summaryTotalMainnet)));
      assert.ok(!onlyMainnet.includes(esc(en.bills.summaryTotalTestnet)));
      const none = render(h(BillsModule.BillsSummary, { payments: [] }));
      assert.ok(none.includes(esc(en.bills.summaryTotal)) && !none.includes("data-total-kind"));
    });

    it("a chain of unknown kind gets a total of its own: it is folded into neither the real money nor the test tokens", () => {
      assert.deepEqual(BillsModule.billsTotalsByKind([mainnetPaid, testnetPaid, unknownChain] as never), [
        { kind: "mainnet", total: "2.5" },
        { kind: "testnet", total: "0.01" },
        { kind: "other", total: "0.07" },
      ]);
    });

    it("the filter offers All / Mainnet / Testnet and keeps exactly the rows of that kind (all keeps everything)", () => {
      const html = render(h(BillsModule.BillsKindFilter, { value: "mainnet", onChange() {} }));
      assert.deepEqual([...html.matchAll(/data-kind-filter="(\w+)"/g)].map((m) => m[1]), ["all", "mainnet", "testnet"]);
      assert.match(html, /class="active"[^>]*data-kind-filter="mainnet"/);
      assert.ok(html.includes(`>${en.bills.kindAny}<`) && html.includes(`>${en.common.kindMainnet}<`) && html.includes(`>${en.common.kindTestnet}<`));
      const all = [mainnetPaid, mainnetMaybe, testnetPaid, testnetRefused, unknownChain] as never[];
      const ids = (filter: "all" | "mainnet" | "testnet") => (all as never as Array<{ id: string }>).filter((p) => BillsModule.kindMatches(p as never, filter)).map((p) => p.id);
      assert.deepEqual(ids("all"), ["m1", "m2", "t1", "t2", "u1"]);
      assert.deepEqual(ids("mainnet"), ["m1", "m2"]);
      assert.deepEqual(ids("testnet"), ["t1", "t2"]);
    });

    it("the labels are in Chinese too", () => {
      assert.equal(zhCommon.kindMainnet, "主网");
      assert.equal(zhCommon.kindTestnet, "测试网");
      const html = render(h(BillsModule.BillsSummary, { payments: [mainnetPaid, testnetPaid] as never }), "zh");
      assert.ok(html.includes(zhBills.summaryTotalMainnet) && html.includes(zhBills.summaryTotalTestnet));
      assert.ok(render(h(BillsModule.BillsKindFilter, { value: "all", onChange() {} }), "zh").includes(`>${zhBills.kindAny}<`));
    });
  });
});

describe("a new key chooses testnet or mainnet first (SPEC.md §2)", () => {
  const field = (over: Record<string, unknown> = {}, lang: "en" | "zh" = "en") =>
    render(h(NetworkModeField, { kinds: ["testnet", "mainnet"], value: "testnet", onChange() {}, confirmed: false, onConfirmedChange() {}, ...over } as never), lang);
  const net = (network: string, is_mainnet: boolean) => ({ network, chain_id: 1, usdc_address: "0x1", network_label: network, explorer_base: "https://x", is_mainnet });
  /** The radio buttons of the rendered field, in order, with whether each is selected. */
  const radios = (html: string) =>
    [...html.matchAll(/<input type="radio"[^>]*>/g)].map((m) => ({ value: /value="(\w+)"/.exec(m[0])![1], checked: m[0].includes('checked=""') }));

  it("both kinds enabled: both are offered, the testnet is selected by default, and there is no real-money question yet", () => {
    const kinds = networkModeHelpers.enabledNetworkKinds({ networks: [net("eip155:10143", false), net("eip155:143", true)] });
    assert.deepEqual(kinds, ["testnet", "mainnet"]);
    const html = field({ kinds, value: networkModeHelpers.effectiveNetworkMode(kinds, null) });
    assert.deepEqual(radios(html), [{ value: "testnet", checked: true }, { value: "mainnet", checked: false }]);
    assert.ok(html.includes(esc(en.keys.networkModeTestnetHint)) && html.includes(esc(en.keys.networkModeMainnetHint)));
    assert.ok(html.includes(esc(en.keys.networkModeFixed)), "it says the choice cannot be changed later");
    assert.ok(!html.includes('type="checkbox"') && !html.includes(esc(en.keys.realMoneyLabel)));
  });

  it("only one kind enabled: only that kind is shown, already selected", () => {
    const testnetOnly = networkModeHelpers.enabledNetworkKinds({ networks: [net("eip155:10143", false), net("eip155:84532", false)] });
    assert.deepEqual(testnetOnly, ["testnet"]);
    const t = field({ kinds: testnetOnly, value: networkModeHelpers.effectiveNetworkMode(testnetOnly, null) });
    assert.deepEqual(radios(t), [{ value: "testnet", checked: true }]);
    const mainnetOnly = networkModeHelpers.enabledNetworkKinds({ networks: [net("eip155:143", true)] });
    assert.deepEqual(mainnetOnly, ["mainnet"]);
    const m = field({ kinds: mainnetOnly, value: networkModeHelpers.effectiveNetworkMode(mainnetOnly, null) });
    assert.deepEqual(radios(m), [{ value: "mainnet", checked: true }]);
  });

  it("a kind the instance does not enable can never be the choice, even if the form still holds it", () => {
    assert.equal(networkModeHelpers.effectiveNetworkMode(["testnet"], "mainnet"), "testnet");
    assert.equal(networkModeHelpers.effectiveNetworkMode(["mainnet"], "testnet"), "mainnet");
    assert.equal(networkModeHelpers.effectiveNetworkMode(["testnet", "mainnet"], "mainnet"), "mainnet");
    assert.equal(networkModeHelpers.effectiveNetworkMode(["testnet", "mainnet"], null), "testnet");
  });

  it("a mainnet key asks 'this key spends real money' and cannot be issued until that is ticked; a testnet key asks nothing", () => {
    assert.equal(networkModeHelpers.realMoneyConfirmed("testnet", false), true);
    assert.equal(networkModeHelpers.realMoneyConfirmed("mainnet", false), false);
    assert.equal(networkModeHelpers.realMoneyConfirmed("mainnet", true), true);
    const unticked = field({ value: "mainnet", error: en.keys.errRealMoney });
    assert.ok(unticked.includes(esc(en.keys.realMoneyLabel)));
    assert.match(unticked, /<input type="checkbox" name="confirm_real_money"\/?>/);
    assert.ok(unticked.includes(esc(en.keys.errRealMoney)));
    const ticked = field({ value: "mainnet", confirmed: true });
    assert.match(ticked, /<input type="checkbox" name="confirm_real_money" checked=""/);
    assert.ok(!ticked.includes(esc(en.keys.errRealMoney)));
    assert.equal(en.keys.realMoneyLabel, "This key spends real money (mainnet USDC)");
  });

  it("is in Chinese: 测试网 / 主网 and 「这把 key 花真钱（主网 USDC）」", () => {
    const html = field({ value: "mainnet" }, "zh");
    assert.ok(html.includes("测试网") && html.includes("主网"));
    assert.ok(html.includes("这把 key 花真钱（主网 USDC）"));
    assert.equal(zhKeys.networkLegacy, "旧 key");
  });

  it("an unticked mainnet key cannot be submitted on the Keys page: the form is invalid, the button is disabled, and the handler returns before the API call", () => {
    const page = fs.readFileSync(path.join(here, "../src/pages/MoneyKeysPage.tsx"), "utf8");
    assert.ok(/if \(!realMoneyConfirmed\(networkMode, form\.confirm_real_money\)\) e\.confirm_real_money = t\("errRealMoney"\);/.test(page), "the confirmation is a validation error");
    assert.ok(/const hasErrors = Object\.keys\(errors\)\.length > 0;/.test(page), "any validation error makes the form invalid");
    assert.ok(/disabled=\{creating \|\| hasErrors\}/.test(page), "the submit button is disabled while the form is invalid");
    assert.ok(/async function submitCreate[\s\S]*?if \(hasErrors\) return;[\s\S]*?await createKey\(/.test(page), "submitting returns before createKey when the form is invalid");
    // switching kind clears the tick, so a mainnet key is never confirmed by an old tick
    assert.ok(page.includes("setForm({ ...form, network_mode, confirm_real_money: false })"));
    // and the pure rule behind it
    assert.equal(networkModeHelpers.realMoneyConfirmed("mainnet", false), false);
  });

  it("the key form on the page offers the network type first (the page is the form's only user)", () => {
    const page = fs.readFileSync(path.join(here, "../src/pages/MoneyKeysPage.tsx"), "utf8");
    assert.ok(page.indexOf("<NetworkModeField") < page.indexOf("preset-row"), "before the presets and every limit");
    assert.ok(page.includes("network_mode: networkMode"), "what was chosen is what the server is asked for");
  });
});

describe("the key list marks every key Testnet / Mainnet (SPEC.md §2)", () => {
  it("a testnet key and a mainnet key carry their kind", () => {
    const testnet = render(h(KeyNetworkBadge, { mode: "testnet", active: true }));
    assert.ok(testnet.includes('data-network-kind="testnet"') && testnet.includes(`>${en.common.kindTestnet}<`));
    const mainnet = render(h(KeyNetworkBadge, { mode: "mainnet", active: true }));
    assert.ok(mainnet.includes('data-network-kind="mainnet"') && mainnet.includes(`>${en.common.kindMainnet}<`));
    assert.ok(!testnet.includes(esc(en.keys.networkLegacy)) && !mainnet.includes(esc(en.keys.networkLegacy)));
  });

  it("a key from before network types is a 'Legacy key', names the chains it really pays on, and, while active, suggests revoking it and issuing a new one", () => {
    for (const mode of [null, undefined]) {
      const html = render(h(KeyNetworkBadge, { mode, active: true, chains: ["Monad testnet", "Base Sepolia"] }));
      assert.ok(html.includes('data-network-kind="legacy"') && html.includes(`>${en.keys.networkLegacy}<`));
      assert.ok(html.includes('data-testid="legacy-chains"') && html.includes(fill(en.keys.networkLegacyChains, { chains: "Monad testnet, Base Sepolia" })));
      assert.ok(html.includes("key-legacy-hint") && html.includes(esc(en.keys.networkLegacyHint)));
    }
    assert.equal(en.keys.networkLegacy, "Legacy key");
    assert.ok(/[Rr]evoke/.test(en.keys.networkLegacyHint) && /new/.test(en.keys.networkLegacyHint));
    assert.ok(/撤销/.test(zhKeys.networkLegacyHint));
  });

  it("the chains are the API's: a mixed instance's legacy key lists the testnets only, never the mainnet; no 'all chains' wording is left, in either language", () => {
    const html = render(h(KeyNetworkBadge, { mode: null, active: true, chains: ["Monad testnet"] }));
    assert.ok(html.includes("Monad testnet") && !html.includes("Monad mainnet"));
    for (const text of [en.keys.networkLegacy, en.keys.networkLegacyChains, en.keys.networkLegacyHint, zhKeys.networkLegacy, zhKeys.networkLegacyChains, zhKeys.networkLegacyHint]) {
      assert.ok(!/all chains|every chain|所有链/.test(text), text);
    }
    const zh = render(h(KeyNetworkBadge, { mode: null, active: true, chains: ["Monad 测试网"] }), "zh");
    assert.ok(zh.includes(">旧 key<") && zh.includes("付款链：Monad 测试网"), zh);
    const none = render(h(KeyNetworkBadge, { mode: null, active: true, chains: [] }));
    assert.ok(none.includes(esc(en.keys.networkLegacyNoChains)));
    assert.ok(render(h(KeyNetworkBadge, { mode: null, active: true })).includes(esc(en.keys.networkLegacyNoChains)), "no list from the server: nothing is claimed");
  });

  it("a dead old key (revoked, expired) keeps the mark and its chains but is not told to be revoked", () => {
    const html = render(h(KeyNetworkBadge, { mode: null, active: false, chains: ["Monad testnet"] }));
    assert.ok(html.includes(`>${en.keys.networkLegacy}<`) && html.includes("Monad testnet"));
    assert.ok(!html.includes("key-legacy-hint"));
  });

  it("a typed key shows its type only: no legacy mark, no chain line", () => {
    for (const mode of ["testnet", "mainnet"] as const) {
      const html = render(h(KeyNetworkBadge, { mode, active: true, chains: ["Monad testnet"] }));
      assert.ok(!html.includes("legacy") && !html.includes("legacy-chains"));
    }
  });

  it("the Keys page passes the key's own chain list (from the API) to the mark, named with the instance's labels", () => {
    const page = fs.readFileSync(path.join(here, "../src/pages/MoneyKeysPage.tsx"), "utf8");
    assert.ok(page.includes("chains={(k.networks ?? []).map((c) => chainLabels.get(c) ?? c)}"));
    assert.ok(page.includes("new Map((meta?.networks ?? []).map((n) => [n.network, n.network_label] as const))"));
  });
});

describe("the network badge in the top bar", () => {
  const net = (network: string, network_label: string, is_mainnet: boolean) => ({ network, chain_id: 1, usdc_address: "0x1", network_label, explorer_base: "https://x", is_mainnet });
  const monadTestnet = net("eip155:10143", "Monad testnet", false);
  const baseSepolia = net("eip155:84532", "Base Sepolia", false);
  const monadMainnet = net("eip155:143", "Monad mainnet", true);
  const badge = (meta: unknown, lang: "en" | "zh" = "en") => render(h(NetworkBadge, { meta } as never), lang);

  it("both kinds enabled: it says 'Mainnet + Testnet' (not just the default network's name) and the dot is in the real-money colour", () => {
    for (const networks of [[monadTestnet, monadMainnet], [monadMainnet, baseSepolia], [monadTestnet, baseSepolia, monadMainnet]]) {
      const html = badge({ network: networks[0].network, network_label: networks[0].network_label, is_mainnet: networks[0].is_mainnet, networks });
      assert.ok(html.includes('data-network-badge="mixed"'), html);
      assert.ok(html.includes(`>${en.common.networkBoth}<`) || html.includes(`</span>${en.common.networkBoth}</span>`), html);
      assert.ok(html.includes("network-dot network-dot-real"));
      assert.ok(!html.includes("Monad testnet") && !html.includes("Base Sepolia"), "the default network's name is not shown alone");
    }
    assert.equal(en.common.networkBoth, "Mainnet + Testnet");
  });

  it("a single-kind instance is unchanged: the default network's name, the ordinary dot", () => {
    for (const [networks, label, mainnet] of [
      [[monadTestnet], "Monad testnet", false],
      [[monadTestnet, baseSepolia], "Monad testnet", false],
      [[monadMainnet], "Monad mainnet", true],
    ] as const) {
      const html = badge({ network: networks[0].network, network_label: label, is_mainnet: mainnet, networks });
      assert.ok(html.includes('data-network-badge="single"') && html.includes(label), html);
      assert.ok(html.includes('class="network-dot"') && !html.includes("network-dot-real"));
      assert.ok(!html.includes(en.common.networkBoth));
    }
  });

  it("before the instance's facts are known it falls back to the old words", () => {
    assert.ok(badge(null).includes(en.common.networkTestnet));
    assert.ok(badge({ is_mainnet: true }).includes(en.common.networkMainnet));
    assert.ok(badge({ is_mainnet: false }).includes(en.common.networkTestnet));
  });

  it("is in Chinese too: 主网 + 测试网", () => {
    assert.equal(zhCommon.networkBoth, "主网 + 测试网");
    const html = badge({ networks: [monadTestnet, monadMainnet] }, "zh");
    assert.ok(html.includes("主网 + 测试网"), html);
  });

  it("the top bar uses it (the badge is not written inline in the layout any more)", () => {
    const layout = fs.readFileSync(path.join(here, "../src/Layout.tsx"), "utf8");
    assert.ok(layout.includes("<NetworkBadge meta={meta} />") && !layout.includes("network-badge"));
  });
});

describe("Approvals page: a payment approval names its chain and says mainnet or testnet", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "ap-n",
    key_id: "key-1",
    url: "https://api.example.com/x",
    method: "GET",
    network: "eip155:143",
    network_kind: "mainnet",
    asset: "0xusdc",
    pay_to: "0x000000000000000000000000000000000000dEaD",
    amount: "0.15",
    status: "pending" as const,
    kind: "payment",
    expires_at: "2026-10-04T12:10:00.000Z",
    decided_at: null,
    created_at: "2026-10-04T12:00:00.000Z",
    ...over,
  });
  const view = (pending: unknown[], over: Record<string, unknown> = {}) =>
    render(
      h(ApprovalsModule.ApprovalsView, {
        pending,
        all: null,
        keys: [],
        highlightId: null,
        actingId: null,
        successMsg: null,
        actionError: null,
        error: null,
        now: Date.parse("2026-10-04T12:05:00.000Z"),
        onAct() {},
        networks: [{ network: "eip155:143", chain_id: 143, usdc_address: "0x1", network_label: "Monad mainnet", explorer_base: "https://x", is_mainnet: true }],
        ...over,
      } as never)
    );

  it("a mainnet price shows the chain's name and the Mainnet mark next to the amount", () => {
    const html = view([row()]);
    assert.match(html, /data-testid="approval-chain"[^>]*><span>Monad mainnet<\/span> <span data-network-kind="mainnet">/);
    assert.ok(html.includes(`>${en.common.kindMainnet}<`));
  });

  it("a testnet price carries the Testnet mark, and a chain the page has no name for is shown by its CAIP-2 id", () => {
    const html = view([row({ network: "eip155:84532", network_kind: "testnet" })]);
    assert.match(html, /data-testid="approval-chain"[^>]*><span>eip155:84532<\/span> <span data-network-kind="testnet">/);
    assert.ok(html.includes(`>${en.common.kindTestnet}<`));
  });

  it("a new-host approval has no chain yet, so no chain line", () => {
    const html = view([row({ kind: "host", host: "api.newhost.example:443", network: "", network_kind: null, amount: "0" })]);
    assert.ok(!html.includes("approval-chain"));
  });
});
