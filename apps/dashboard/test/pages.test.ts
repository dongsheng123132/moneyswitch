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
};
let zhShell: (typeof import("../src/i18n/strings/shell.ts"))["shellStrings"]["zh"];

before(async () => {
  ({ default: MoneyKeysPage, NoKeysYet } = await import("../src/pages/MoneyKeysPage.tsx"));
  LoginPage = (await import("../src/pages/LoginPage.tsx")).default;
  ApprovalsModule = await import("../src/pages/ApprovalsPage.tsx");
  BillsModule = await import("../src/pages/BillsPage.tsx");
  KeyHandoff = (await import("../src/components/KeyHandoff.tsx")).default;
  KeyRowActions = (await import("../src/components/KeyRowActions.tsx")).default;
  AllowedHostsField = (await import("../src/components/AllowedHostsField.tsx")).default;
  nav = (await import("../src/Layout.tsx")).NAV;
  LangProvider = (await import("../src/i18n/index.tsx")).LangProvider;
  AuthProvider = (await import("../src/auth.tsx")).AuthProvider;
  ({ TEST_PAYMENT_URL } = await import("../src/skillText.ts"));
  en = {
    keys: (await import("../src/i18n/strings/keys.ts")).keysStrings.en,
    skill: (await import("../src/i18n/strings/skill.ts")).skillStrings.en,
    shell: (await import("../src/i18n/strings/shell.ts")).shellStrings.en,
    approvals: (await import("../src/i18n/strings/approvals.ts")).approvalsStrings.en,
    bills: (await import("../src/i18n/strings/bills.ts")).billsStrings.en,
  };
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
});
