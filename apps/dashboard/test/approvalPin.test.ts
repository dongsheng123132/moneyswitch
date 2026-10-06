// The approval PIN in the dashboard (SPEC.md §2, §3): the person who holds a key opens the approval link without a login, sees that one request
// and approves or denies it with the key's 4-6 digit PIN; the administrator sets the PIN when issuing the key (shown once, for a person, never in
// the skill text) and later from the key list, where a key with no PIN or a locked PIN is marked. Render tests (react-dom/server, no DOM) plus the
// calls the buttons make.
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
Object.assign(globalThis, { localStorage: fakeStorage, sessionStorage: fakeStorage, window: { location: { origin: "https://pay.example.com", hash: "" } } });

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY = "mk_live_Ab3dEf6hIj9lMn2pQr5tUv8xYz1B4cDe";
const BASE = "https://pay.example.com";
const PIN = "739155"; // (a number that appears nowhere else in the markup, so counting it counts the PIN)

let ApprovalsModule: typeof import("../src/pages/ApprovalsPage.tsx");
let KeyHandoff: typeof import("../src/components/KeyHandoff.tsx").default;
let KeyRowActions: typeof import("../src/components/KeyRowActions.tsx").default;
let KeyPinState: typeof import("../src/components/KeyPinState.tsx").default;
let ApprovalPinField: typeof import("../src/components/ApprovalPinField.tsx").default;
let App: typeof import("../src/App.tsx").default;
let pinRules: typeof import("../src/approvalPin.ts");
let coreWeak: typeof import("../../../packages/core/src/weak-pin.ts");
let api: typeof import("../src/api.ts");
let handoffs: typeof import("../src/keyHandoff.ts");
let LangProvider: typeof import("../src/i18n/index.tsx").LangProvider;
let AuthProvider: typeof import("../src/auth.tsx").AuthProvider;
let en: {
  keys: (typeof import("../src/i18n/strings/keys.ts"))["keysStrings"]["en"];
  approvals: (typeof import("../src/i18n/strings/approvals.ts"))["approvalsStrings"]["en"];
};
let zh: {
  keys: (typeof import("../src/i18n/strings/keys.ts"))["keysStrings"]["zh"];
  approvals: (typeof import("../src/i18n/strings/approvals.ts"))["approvalsStrings"]["zh"];
};

before(async () => {
  ApprovalsModule = await import("../src/pages/ApprovalsPage.tsx");
  KeyHandoff = (await import("../src/components/KeyHandoff.tsx")).default;
  KeyRowActions = (await import("../src/components/KeyRowActions.tsx")).default;
  KeyPinState = (await import("../src/components/KeyPinState.tsx")).default;
  ApprovalPinField = (await import("../src/components/ApprovalPinField.tsx")).default;
  App = (await import("../src/App.tsx")).default;
  pinRules = await import("../src/approvalPin.ts");
  coreWeak = await import("../../../packages/core/src/weak-pin.ts");
  api = await import("../src/api.ts");
  handoffs = await import("../src/keyHandoff.ts");
  LangProvider = (await import("../src/i18n/index.tsx")).LangProvider;
  AuthProvider = (await import("../src/auth.tsx")).AuthProvider;
  const keys = (await import("../src/i18n/strings/keys.ts")).keysStrings;
  const approvals = (await import("../src/i18n/strings/approvals.ts")).approvalsStrings;
  en = { keys: keys.en, approvals: approvals.en };
  zh = { keys: keys.zh, approvals: approvals.zh };
});

beforeEach(() => store.clear());

const render = (el: Parameters<typeof renderToStaticMarkup>[0], lang: "en" | "zh" = "en", location = "/") => {
  store.set("moneyswitch_lang", lang);
  return renderToStaticMarkup(h(LangProvider, null, h(StaticRouter, { location }, h(AuthProvider, null, el))));
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const fill = (s: string, vars: Record<string, string | number>) => esc(s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k])));

/** Runs `fn` with fetch replaced by a recorder that answers `body`; returns what was asked. */
async function recording(body: unknown, fn: () => Promise<unknown>, status = 200) {
  const real = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; auth?: string; body?: string; contentType?: string }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method, auth: headers.Authorization, body: init?.body as string | undefined, contentType: headers["Content-Type"] });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return calls;
}

const NOW = Date.parse("2026-10-04T12:05:00.000Z");
const link = (over: Record<string, unknown> = {}) => ({
  id: "ap-1",
  key_name: "Alice's agent",
  url: "https://api.example.com/paid?x=1",
  method: "GET",
  network: "eip155:143",
  network_kind: "mainnet" as const,
  network_label: "Monad mainnet",
  asset: "0xusdc",
  pay_to: "0x000000000000000000000000000000000000dEaD",
  amount: "0.15",
  status: "pending" as const,
  kind: "payment" as const,
  pin_state: "set" as const,
  pin_failures: 0,
  expires_at: "2026-10-04T12:10:00.000Z",
  decided_at: null,
  created_at: "2026-10-04T12:00:00.000Z",
  ...over,
});
const linkView = (over: Record<string, unknown> = {}, lang: "en" | "zh" = "en") =>
  render(
    h(ApprovalsModule.ApprovalLinkView, {
      approval: link(),
      error: null,
      now: NOW,
      pin: "",
      onPinChange() {},
      acting: false,
      outcome: null,
      actionError: null,
      onDecide() {},
      loginHref: "/login?next=%2Fapprovals%3Fid%3Dap-1",
      origin: "https://pay.example.com",
      ...over,
    } as never),
    lang,
    "/approvals?id=ap-1"
  );

const page_ = () => fs.readFileSync(path.join(here, "../src/pages/MoneyKeysPage.tsx"), "utf8");

describe("the approval link opens without a login (SPEC.md §3)", () => {
  it("not signed in: /approvals?id=… is the PIN page (no sidebar, no login redirect); the administrator's link back to it goes through the login", () => {
    const html = render(h(App), "en", "/approvals?id=ap-1");
    assert.ok(html.includes("login-shell") && html.includes('class="approval-card"'), "the page with the request's card (loading)");
    assert.ok(!html.includes("app-shell") && !html.includes("sidebar"), "no administrator navigation");
    assert.ok(html.includes('href="/login?next=%2Fapprovals%3Fid%3Dap-1"'), "the administrator signs in and comes back to this request");
    assert.ok(html.includes(esc(en.approvals.adminSignIn)));
  });

  it("signed in as the administrator: the same link is the Approvals page, not the PIN page", () => {
    store.set("moneyswitch_admin_token", "ms_admin_testtoken");
    const html = render(h(App), "en", "/approvals?id=ap-1");
    assert.ok(html.includes("app-shell"));
    assert.ok(!html.includes('id="approval-pin"'));
  });

  it("only a link with an id is public: the source gives /approvals?id=… the PIN page and every other path the login", () => {
    const app = fs.readFileSync(path.join(here, "../src/App.tsx"), "utf8");
    assert.ok(/location\.pathname === "\/approvals" && new URLSearchParams\(location\.search\)\.get\("id"\)/.test(app));
    assert.ok(/if \(!token\) return <Navigate to=\{loginUrlFor/.test(app), "everything else still asks for the administrator's login");
  });
});

describe("the approval link's page", () => {
  it("shows that one request: the key's name, what it asks for, the chain with its Mainnet mark, the URL and how long is left", () => {
    const html = linkView();
    assert.ok(html.includes(esc("Alice's agent")));
    assert.ok(html.includes("0.15"), "the price");
    assert.match(html, /data-testid="approval-chain"[^>]*><span>Monad mainnet<\/span> <span data-network-kind="mainnet">/);
    assert.ok(html.includes(esc("https://api.example.com/paid?x=1")));
    assert.ok(html.includes('data-approval-id="ap-1"'));
    assert.ok(html.includes(fill(en.approvals.countdownLeft, { m: 5, s: "00" })));
    assert.ok(html.includes(esc(en.approvals.linkLead)));
  });

  it("a new host shows its host:port and no amount or chain, as on the administrator's page", () => {
    const html = linkView({ approval: link({ kind: "host", host: "api.newhost.example:443", network: "", network_kind: null, network_label: null, amount: "0", pay_to: "" }) });
    assert.ok(html.includes('data-testid="host-approval"') && html.includes("api.newhost.example:443"));
    assert.ok(html.includes(esc(en.approvals.hostBadge)));
    assert.ok(!html.includes("approval-chain"));
  });

  it("asks for the PIN: a masked numeric field of at most six digits, with Approve and Deny, both disabled until 4 to 6 digits are typed", () => {
    const html = linkView();
    assert.match(html, /<input id="approval-pin" type="password" inputMode="numeric" pattern="\[0-9\]\*" maxLength="6" autoComplete="off"/);
    assert.ok(html.includes(esc(en.approvals.pinLabel)) && html.includes(esc(en.approvals.pinHint)));
    const buttons = [...html.matchAll(/<button type="button" class="btn (danger|success)"([^>]*)>/g)];
    assert.deepEqual(buttons.map((m) => m[1]).sort(), ["danger", "success"]);
    for (const m of buttons) assert.ok(m[2].includes('disabled=""'), "disabled while the field is empty");
    for (const pin of ["123", "1234567"]) for (const m of [...linkView({ pin }).matchAll(/<button type="button" class="btn (?:danger|success)"([^>]*)>/g)]) assert.ok(m[1].includes('disabled=""'), pin);
    for (const pin of ["1234", "12345", "123456"]) {
      const enabled = [...linkView({ pin }).matchAll(/<button type="button" class="btn (?:danger|success)"([^>]*)>/g)];
      assert.equal(enabled.length, 2);
      for (const m of enabled) assert.ok(!m[1].includes("disabled"), pin);
    }
    assert.ok(linkView({ pin: "1234", acting: true }).split('disabled=""').length - 1 === 2, "both disabled while a call is out");
  });

  it("above the field it says: never tell the AI the code or paste it into a chat, type it only on this page - and shows the address the page was opened at", () => {
    const html = linkView({ origin: "https://pay.example.com" });
    assert.ok(html.includes('data-testid="pin-warning"') && html.includes(esc(en.approvals.pinWarning)));
    assert.ok(html.includes(fill(en.approvals.pinOrigin, { origin: "https://pay.example.com" })));
    assert.match(html, /data-testid="pin-origin">Current address: https:\/\/pay\.example\.com</);
    assert.ok(html.indexOf("pin-warning") < html.indexOf('id="approval-pin"'), "the warning comes before the field");
    assert.ok(html.indexOf("pin-origin") < html.indexOf('id="approval-pin"'), "and so does the address");
    const zhHtml = linkView({ origin: "https://pay.example.com" }, "zh");
    assert.ok(zhHtml.includes("不要把确认码告诉 AI，也不要贴进聊天；只在这个页面输入。"));
    assert.ok(zhHtml.includes("当前网址：https://pay.example.com"));
    // another address is shown as it is: a person can tell a look-alike site from the real one
    assert.ok(linkView({ origin: "https://pay.example.com.evil.test" }).includes("https://pay.example.com.evil.test"));
    // the page passes window.location.origin
    const src = fs.readFileSync(path.join(here, "../src/pages/ApprovalsPage.tsx"), "utf8");
    assert.ok(src.includes("origin={window.location.origin}"));
  });

  it("wrong tries so far are shown above the field once there are any: 'N wrong tries (5 lock it)'; none, none shown", () => {
    assert.ok(!linkView({ approval: link({ pin_failures: 0 }) }).includes('data-testid="pin-failures"'));
    const html = linkView({ approval: link({ pin_failures: 3 }) });
    assert.ok(html.includes('data-testid="pin-failures"') && html.includes(fill(en.approvals.pinFailures, { n: 3, max: 5 })));
    assert.ok(html.indexOf("pin-failures") < html.indexOf('id="approval-pin"'));
    assert.ok(linkView({ approval: link({ pin_failures: 2 }) }, "zh").includes("已输错 2 次（5 次锁定）"));
    // locked / no PIN: the field and its warning are gone, whatever the count
    const locked = linkView({ approval: link({ pin_state: "locked", pin_failures: 5 }) });
    assert.ok(!locked.includes("pin-warning") && !locked.includes('id="approval-pin"'));
  });

  it("no implicit submit: Enter in the field decides nothing (the form's submit is cancelled), so a stray key never approves", () => {
    const src = fs.readFileSync(path.join(here, "../src/pages/ApprovalsPage.tsx"), "utf8");
    assert.ok(src.includes("<form onSubmit={(e) => e.preventDefault()} noValidate>"));
    assert.ok(!/<button type="submit"/.test(src.slice(src.indexOf("export function ApprovalLinkView"))));
  });

  it("the field keeps digits only, at most six", () => {
    const src = fs.readFileSync(path.join(here, "../src/pages/ApprovalsPage.tsx"), "utf8");
    assert.ok(src.includes('onPinChange(e.target.value.replace(/\\D/g, "").slice(0, 6))'));
    assert.equal(ApprovalsModule.PIN_RE.test("1234"), true);
    assert.equal(ApprovalsModule.PIN_RE.test("123"), false);
    assert.equal(ApprovalsModule.PIN_RE.test("12a45"), false);
  });

  it("a request already decided (or expired) says what became of it and offers no PIN field", () => {
    for (const status of ["approved", "denied", "expired", "used"] as const) {
      const html = linkView({ approval: link({ status, decided_at: "2026-10-04T12:03:00.000Z" }) });
      assert.ok(html.includes('data-testid="linked-already"'), status);
      assert.ok(!html.includes('id="approval-pin"'), status);
    }
    assert.ok(linkView({ approval: link({ status: "approved" }) }).includes(fill(en.approvals.linkedAlready, { status: en.approvals.statusApproved })));
  });

  it("a key with no PIN (issued before this version) says only the administrator can approve; a locked PIN says to ask the administrator; neither shows the field", () => {
    const none = linkView({ approval: link({ pin_state: "none" }) });
    assert.ok(none.includes('data-testid="pin-not-set"') && none.includes(esc(en.approvals.pinNotSet)) && !none.includes('id="approval-pin"'));
    const locked = linkView({ approval: link({ pin_state: "locked" }) });
    assert.ok(locked.includes('data-testid="pin-locked"') && locked.includes(esc(en.approvals.pinLocked)) && !locked.includes('id="approval-pin"'));
  });

  it("what this visitor just did is said at once; a refusal is shown under the field", () => {
    assert.ok(linkView({ outcome: "approved" }).includes(esc(en.approvals.successApproved)));
    assert.ok(linkView({ outcome: "denied" }).includes(esc(en.approvals.successDenied)));
    assert.ok(!linkView({ outcome: "approved" }).includes('id="approval-pin"'));
    assert.ok(linkView({ actionError: "That confirmation code is not right. 3 tries left before it locks." }).includes("3 tries left"));
  });

  it("an unknown request says so; before it loads there is a placeholder; any other error is shown", () => {
    const missing = linkView({ approval: null, error: "not_found" });
    assert.ok(missing.includes('data-testid="linked-not-found"') && missing.includes(esc(en.approvals.linkedNotFound)));
    assert.ok(!missing.includes("approval-link-card"));
    assert.ok(linkView({ approval: null }).includes("skeleton") || linkView({ approval: null }).includes('class="approval-card"'));
    assert.ok(linkView({ approval: null, error: "boom" }).includes("boom"));
  });

  it("is in Chinese too", () => {
    const html = linkView({}, "zh");
    for (const k of ["linkLead", "pinLabel", "pinHint", "adminSignIn"] as const) assert.ok(html.includes(esc(zh.approvals[k])), k);
    assert.ok(zh.approvals.pinWrong.includes("{n}"));
    assert.ok(linkView({ approval: link({ pin_state: "none" }) }, "zh").includes(esc(zh.approvals.pinNotSet)));
  });

  it("the key's name is shown, never its id: the link view carries no key id", () => {
    const html = linkView();
    assert.ok(!html.includes("key-1") && !html.includes("key_id"));
    assert.ok(!/mk_live_/.test(html));
  });
});

describe("what the refusals say (pinErrorMessage)", () => {
  const t = (key: keyof typeof en.approvals, vars?: Record<string, string | number>) => (en.approvals[key] as string).replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k]));
  const refused = (error: string, extra: Partial<{ attemptsLeft: number }> = {}) => new api.ApiError(403, error, null, error, extra.attemptsLeft ?? null);

  it("a wrong PIN says how many tries are left; locked, not set, inactive key, already handled and a malformed PIN each have their own words", () => {
    assert.equal(ApprovalsModule.pinErrorMessage(refused("APPROVAL_PIN_WRONG", { attemptsLeft: 3 }), "approve", t), "That confirmation code is not right. 3 tries left before it locks.");
    assert.equal(ApprovalsModule.pinErrorMessage(refused("APPROVAL_PIN_LOCKED"), "approve", t), en.approvals.pinLocked);
    assert.ok(!en.approvals.pinLocked.includes("in a row") && !zh.approvals.pinLocked.includes("连续"), "the lock is cumulative, not 'in a row'");
    assert.equal(ApprovalsModule.pinErrorMessage(refused("APPROVAL_PIN_NOT_SET"), "deny", t), en.approvals.pinNotSet);
    assert.equal(ApprovalsModule.pinErrorMessage(refused("APPROVAL_KEY_NOT_ACTIVE"), "approve", t), en.approvals.keyNotActive);
    assert.equal(ApprovalsModule.pinErrorMessage(refused("APPROVAL_NOT_PENDING"), "approve", t), en.approvals.alreadyHandled);
    assert.equal(ApprovalsModule.pinErrorMessage(refused("APPROVAL_PIN_INVALID"), "approve", t), en.approvals.pinFormat);
  });

  it("a new host's DNS refusals keep their own text, and anything else passes the server's message through", () => {
    assert.equal(ApprovalsModule.pinErrorMessage(new api.ApiError(400, "x", null, "ALLOW_HOST_PRIVATE_HOST"), "approve", t), en.approvals.errHostPrivate);
    assert.equal(ApprovalsModule.pinErrorMessage(new api.ApiError(400, "x", null, "ALLOW_HOST_UNRESOLVED"), "approve", t), en.approvals.errHostUnresolved);
    assert.equal(ApprovalsModule.pinErrorMessage(new api.ApiError(400, "something else", null, "OTHER"), "approve", t), "something else");
    assert.equal(ApprovalsModule.pinErrorMessage(new Error("offline"), "approve", t), "offline");
  });
});

describe("the calls (api.ts)", () => {
  it("reading the link sends no Authorization, even from a browser where the administrator is signed in", async () => {
    store.set("moneyswitch_admin_token", "ms_admin_testtoken");
    const calls = await recording({ approval: link() }, async () => {
      assert.equal((await api.getApprovalByLink("ap-1")).key_name, "Alice's agent");
    });
    assert.deepEqual(calls, [{ url: "/v1/approvals?id=ap-1", method: undefined, auth: undefined, body: undefined, contentType: undefined }]);
  });

  it("Approve and Deny with a PIN are one POST each with {pin} in the body and no Authorization", async () => {
    store.set("moneyswitch_admin_token", "ms_admin_testtoken");
    const calls = await recording({ id: "ap-1", status: "approved" }, async () => {
      await api.decideWithPin("ap-1", "approve", "1234");
      await api.decideWithPin("ap-1", "deny", "1234");
    });
    assert.deepEqual(calls, [
      { url: "/v1/approvals/ap-1/approve", method: "POST", auth: undefined, body: JSON.stringify({ pin: "1234" }), contentType: "application/json" },
      { url: "/v1/approvals/ap-1/deny", method: "POST", auth: undefined, body: JSON.stringify({ pin: "1234" }), contentType: "application/json" },
    ]);
  });

  it("a refused PIN reaches the caller as an ApiError with the code and the tries left", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "APPROVAL_PIN_WRONG", message: "That PIN is not right.", attempts_left: 2 }), { status: 403, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      await assert.rejects(api.decideWithPin("ap-1", "approve", "0000"), (e: unknown) => e instanceof api.ApiError && e.status === 403 && e.error === "APPROVAL_PIN_WRONG" && e.attemptsLeft === 2);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("setting a key's PIN is an authenticated POST: with a PIN in the body, or none for a random one", async () => {
    store.set("moneyswitch_admin_token", "ms_admin_testtoken");
    const calls = await recording({ id: "k1", approval_pin: "4821" }, async () => {
      assert.equal((await api.setApprovalPin("k1", "4821")).approval_pin, "4821");
      await api.setApprovalPin("k1");
    });
    assert.deepEqual(calls, [
      { url: "/v1/keys/k1/approval-pin", method: "POST", auth: "Bearer ms_admin_testtoken", body: JSON.stringify({ approval_pin: "4821" }), contentType: "application/json" },
      { url: "/v1/keys/k1/approval-pin", method: "POST", auth: "Bearer ms_admin_testtoken", body: undefined, contentType: undefined },
    ]);
  });

  it("issuing a key sends the typed PIN, and only when one was typed", async () => {
    store.set("moneyswitch_admin_token", "ms_admin_testtoken");
    const base = { name: "a", total_budget: "5", daily_budget: "1", per_request_limit: "1", allowed_hosts: [] };
    const calls = await recording({ id: "k1", key: KEY, approval_pin: "1234" }, async () => {
      await api.createKey({ ...base, approval_pin: "1234" });
      await api.createKey(base);
    });
    assert.equal(JSON.parse(calls[0].body!).approval_pin, "1234");
    assert.equal("approval_pin" in JSON.parse(calls[1].body!), false);
    const page = fs.readFileSync(path.join(here, "../src/pages/MoneyKeysPage.tsx"), "utf8");
    assert.ok(page.includes("approval_pin: form.approval_pin ? form.approval_pin : undefined"), "the page sends it only when typed");
    assert.ok(page.includes("const pinIssue = pinProblem(form.approval_pin);") && page.includes('t("errPin")'), "a malformed PIN is a validation error");
  });
});

describe("a PIN that is too easy to guess is refused in the forms (SPEC.md §3)", () => {
  const weak = ["1111", "000000", "1234", "2345", "4321", "0123", "123456", "654321", "1212", "1004", "2000", "6969", "1122", "2580", "1313", "1010", "0101", "5683", "0852", "2468", "1357"];

  it("pinProblem: weak ones, malformed ones, and good ones; an empty field is fine (the server makes a random PIN)", () => {
    for (const pin of weak) assert.equal(pinRules.pinProblem(pin), "weak", pin);
    for (const pin of ["12", "abcd", "1234567", "12 34"]) assert.equal(pinRules.pinProblem(pin), "format", pin);
    for (const pin of ["4821", "7396", "9035", "0042", "13579", "739155"]) assert.equal(pinRules.pinProblem(pin), null, pin);
    assert.equal(pinRules.pinProblem(""), null);
  });

  it("the Dashboard's rule and the server's (packages/core/src/weak-pin.ts) agree on every 4-, 5- and 6-digit PIN", () => {
    for (const digits of [4, 5, 6]) {
      for (let n = 0; n < 10 ** digits; n++) {
        const pin = String(n).padStart(digits, "0");
        if (pinRules.isWeakApprovalPin(pin) !== coreWeak.isWeakApprovalPin(pin)) assert.fail("the two rules differ on " + pin);
      }
    }
  });

  it("the message is 'Too easy to guess, pick another' / '太好猜了，换一个', and the key form and 'Set confirmation code' both show it and do not submit", () => {
    assert.equal(en.keys.pinWeak, "Too easy to guess, pick another");
    assert.equal(zh.keys.pinWeak, "太好猜了，换一个");
    const page = fs.readFileSync(path.join(here, "../src/pages/MoneyKeysPage.tsx"), "utf8");
    assert.ok(page.includes('if (pinIssue) e.approval_pin = pinIssue === "weak" ? t("pinWeak") : t("errPin");') || /e\.approval_pin = pinIssue === "weak" \? t\("pinWeak"\) : t\("errPin"\)/.test(page), "the form validates it");
    assert.ok(/async function onSetPin[\s\S]*?pinProblem\(pinInput\)[\s\S]*?return;[\s\S]*?await setApprovalPin\(/.test(page), "the dialog returns before the call");
    assert.ok(page.includes('err.error === "APPROVAL_PIN_WEAK"') && page.includes('e.error === "APPROVAL_PIN_WEAK"'), "and so does a refusal from the server");
    const html = render(h(ApprovalPinField, { id: "p", value: "1111", onChange() {}, error: en.keys.pinWeak }));
    assert.ok(html.includes(esc(en.keys.pinWeak)));
  });
});

describe("the key form and the key list", () => {
  it("the form field is a numeric input of at most six digits, labelled for the person who uses the key, in both languages", () => {
    const html = render(h(ApprovalPinField, { id: "p", value: "12", onChange() {}, hint: true }));
    assert.match(html, /<input id="p" inputMode="numeric" pattern="\[0-9\]\*" maxLength="6" autoComplete="off"/);
    assert.ok(html.includes(esc(en.keys.pinFieldLabel)) && html.includes(esc(en.keys.pinFieldHint)));
    assert.ok(render(h(ApprovalPinField, { id: "p", value: "", onChange() {} }), "zh").includes("确认码（给用这把 key 的人，4–6 位数字；留空则随机生成）"));
    assert.ok(render(h(ApprovalPinField, { id: "p", value: "1", onChange() {}, error: en.keys.errPin })).includes(esc(en.keys.errPin)));
    const page = fs.readFileSync(path.join(here, "../src/pages/MoneyKeysPage.tsx"), "utf8");
    assert.ok(page.includes('<ApprovalPinField\n') || page.includes("<ApprovalPinField\r\n"), "the key form uses it");
    assert.ok(page.includes('id="set-approval-pin"'), "and so does 'Set confirmation code'");
  });

  it("a key with no PIN is marked 'No confirmation code · only the administrator can approve'; a locked one says to set it again; a usable one and a child key say nothing", () => {
    const none = render(h(KeyPinState, { state: "none" }));
    assert.ok(none.includes('data-testid="key-pin-none"') && none.includes(esc(en.keys.pinNone)));
    assert.equal(render(h(KeyPinState, { state: "none" }), "zh").includes("无确认码 · 只能管理员批"), true);
    const locked = render(h(KeyPinState, { state: "locked" }));
    assert.ok(locked.includes('data-testid="key-pin-locked"') && locked.includes(esc(en.keys.pinLocked)));
    assert.equal(render(h(KeyPinState, { state: "locked" }), "zh").includes("确认码已锁定 · 重新设置即可解锁"), true);
    for (const state of ["set", null, undefined]) assert.equal(render(h(KeyPinState, { state: state as never })), "", String(state));
    assert.equal(render(h(KeyPinState, { state: "set", failures: 0 })), "", "no wrong tries, nothing to say");
    const failed = render(h(KeyPinState, { state: "set", failures: 3 }));
    assert.ok(failed.includes('data-testid="key-pin-failures"') && failed.includes(fill(en.keys.pinFailures, { n: 3, max: 5 })));
    assert.ok(render(h(KeyPinState, { state: "set", failures: 3 }), "zh").includes("已输错 3 次（5 次锁定）"));
    assert.equal(render(h(KeyPinState, { state: null, failures: 3 })), "", "a child key has no count of its own");
    assert.ok(render(h(KeyPinState, { state: "locked", failures: 5 })).includes('data-testid="key-pin-locked"'));
    assert.ok(page_().includes("failures={k.approval_pin_failures}"), "the list passes the count");
    const page = fs.readFileSync(path.join(here, "../src/pages/MoneyKeysPage.tsx"), "utf8");
    assert.ok(page.includes('{k.status === "active" && <KeyPinState state={k.approval_pin_state} failures={k.approval_pin_failures} />}'), "only an active key is marked");
  });

  it("'Set confirmation code' is offered next to the reset for a root key, and not for a child key", () => {
    const base = { status: "active", childrenCount: 0, confirmingRevoke: false, revoking: false, onRotate() {}, onAskRevoke() {}, onRevoke() {}, onCancelRevoke() {} };
    assert.ok(render(h(KeyRowActions, { ...base, onSetPin() {} })).includes(`>${en.keys.pinSetBtn}<`));
    assert.ok(!render(h(KeyRowActions, base)).includes(en.keys.pinSetBtn));
    assert.equal(render(h(KeyRowActions, { ...base, status: "revoked", onSetPin() {} })), "", "a dead key offers nothing");
    const page = fs.readFileSync(path.join(here, "../src/pages/MoneyKeysPage.tsx"), "utf8");
    assert.ok(page.includes("k.parent_id == null"), "the page offers it for a root key only");
    assert.ok(en.keys.pinSetBody.length > 0 && zh.keys.pinSetBtn === "设置确认码");
  });
});

describe("the PIN is handed over once, for a person, and never in the skill text", () => {
  const created = (over: Record<string, unknown> = {}) => ({ id: 1, kind: "created", key: KEY, name: "Codex", allowedHosts: ["api.example.com:443"], networkMode: null, approvalPin: PIN, ...over }) as never;
  const props = { skillBase: BASE, apiBase: BASE, onDone() {} };

  it("a new key shows its PIN next to the key, with the note that it is for a person and what it is for - in English and Chinese", () => {
    const html = render(h(KeyHandoff, { ...props, handoff: created() }));
    assert.ok(html.includes('data-testid="approval-pin-handoff"'));
    assert.ok(html.includes(esc(en.keys.pinHandoffTitle)) && html.includes(esc(en.keys.pinHandoffNote)));
    assert.match(html, /data-testid="approval-pin-value">739155</);
    assert.ok(html.indexOf("approval-pin-handoff") > html.indexOf("secret-notice"), "after the key box");
    const zhHtml = render(h(KeyHandoff, { ...props, handoff: created() }), "zh");
    assert.ok(zhHtml.includes("确认码（给人，不要发给 AI）"));
    assert.ok(zhHtml.includes("AI 遇到新网站或超过审批线时会把审批链接发给持 key 的人，打开后输入这个确认码就能批准"));
  });

  it("the handoff note and the set-PIN dialog both say: never give the code to the AI or paste it into a chat", () => {
    const html = render(h(KeyHandoff, { ...props, handoff: created() }));
    assert.ok(en.keys.pinHandoffNote.startsWith("Never give it to the AI or paste it into a chat."));
    assert.ok(html.includes(esc(en.keys.pinHandoffNote)));
    assert.ok(zh.keys.pinHandoffNote.startsWith("不要把确认码告诉 AI，也不要贴进聊天。"));
    assert.ok(en.keys.pinSetBody.includes("Never give the code to the AI or paste it into a chat."));
    assert.ok(zh.keys.pinSetBody.includes("不要把确认码告诉 AI，也不要贴进聊天。"));
    assert.ok(page_().includes('<p>{t("pinSetBody")}</p>'), "the dialog shows it");
  });

  it("the PIN appears exactly once (its own block): not in the skill preview, not in the key box, not in the raw HTTP example", () => {
    for (const initialTopTab of ["skill", "other"] as const) {
      const html = render(h(KeyHandoff, { ...props, handoff: created(), initialTopTab }));
      assert.equal(html.split(PIN).length - 1, 1, initialTopTab);
    }
    const src = fs.readFileSync(path.join(here, "../src/components/SkillForAi.tsx"), "utf8");
    assert.ok(!/pin/i.test(src.replace(/(?:spin|mapping|pinned)/gi, "")), "the skill component has no PIN input at all");
  });

  it("after 'Reset secret' there is no PIN block: a reset never changes it (the old one still works)", () => {
    const html = render(h(KeyHandoff, { ...props, handoff: created({ kind: "rotated", approvalPin: null }) }));
    assert.ok(!html.includes("approval-pin-handoff"));
    const fromRotated = handoffs.handoffFromRotated({ key: KEY, name: "Codex", allowed_hosts: [] });
    assert.equal(fromRotated.approvalPin, null);
  });

  it("the handoff of a new key carries the PIN the server returned", () => {
    const h1 = handoffs.handoffFromCreated({ key: KEY, name: "Codex", allowed_hosts: [], approval_pin: "4821" });
    assert.equal(h1.approvalPin, "4821");
    assert.equal(handoffs.handoffFromCreated({ key: KEY, name: "Codex", allowed_hosts: [] }).approvalPin, null);
  });

  it("setting a PIN later shows it once above the list, with the same note", () => {
    const page = fs.readFileSync(path.join(here, "../src/pages/MoneyKeysPage.tsx"), "utf8");
    assert.ok(page.includes("<ApprovalPinNotice pin={pinNotice.pin} />"));
    assert.ok(page.includes("setPinNotice({ name: pinTarget.name, pin: res.approval_pin })"));
    assert.ok(page.includes('onClick={() => setPinNotice(null)}'), "dismissed with Done: it is not kept");
  });
});

describe("the login stays the administrator's alone", () => {
  it("the login page takes the administrator token only: no confirmation code, no restricted mode", () => {
    const login = fs.readFileSync(path.join(here, "../src/pages/LoginPage.tsx"), "utf8");
    assert.ok(login.includes('candidate.startsWith("ms_admin_")'));
    assert.ok(!/ms_appr_|approval_pin|PIN/.test(login));
    const auth = fs.readFileSync(path.join(here, "../src/auth.tsx"), "utf8");
    assert.ok(!/ms_appr_|restricted/i.test(auth));
  });
});
