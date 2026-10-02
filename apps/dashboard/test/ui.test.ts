// Server-side render of the new UI pieces (no DOM needed): what the user would see, minus interactivity.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// api.ts reads sessionStorage; i18n reads localStorage. Provide tiny stand-ins before importing them.
const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
Object.assign(globalThis, { localStorage: fakeStorage, sessionStorage: fakeStorage, window: { location: { origin: "https://pay.example.com" } } });

const KEY = "mk_live_Ab3dEf6hIj9lMn2pQr5tUv8xYz1B4cDe";
const BASE = "https://pay.example.com";

let SkillForAi: typeof import("../src/components/SkillForAi.tsx").default;
let ConfirmDialog: typeof import("../src/components/ConfirmDialog.tsx").default;
let EmployeeConnectPage: typeof import("../src/pages/employee/EmployeeConnectPage.tsx").default;
let LangProvider: typeof import("../src/i18n/index.tsx").LangProvider;
let AuthProvider: typeof import("../src/auth.tsx").AuthProvider;

before(async () => {
  SkillForAi = (await import("../src/components/SkillForAi.tsx")).default;
  ConfirmDialog = (await import("../src/components/ConfirmDialog.tsx")).default;
  EmployeeConnectPage = (await import("../src/pages/employee/EmployeeConnectPage.tsx")).default;
  LangProvider = (await import("../src/i18n/index.tsx")).LangProvider;
  AuthProvider = (await import("../src/auth.tsx")).AuthProvider;
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0], lang: "en" | "zh" = "en") => {
  store.set("moneyswitch_lang", lang);
  return renderToStaticMarkup(h(LangProvider, null, el));
};

describe("SkillForAi", () => {
  it("shows the agent selector, one big copy button, the save path and a masked preview - never the full key", () => {
    const html = render(h(SkillForAi, { baseUrl: BASE, secret: KEY, keyName: "Codex" }));
    for (const label of ["Codex", "Claude Code", "OpenClaw", "Hermes", "Other"]) assert.ok(html.includes(`>${label}</button>`), label);
    assert.match(html, /role="radiogroup"/);
    assert.ok(html.includes("Copy for Codex"));
    assert.ok(html.includes("btn big copy-btn"));
    assert.ok(html.includes("~/.codex/skills/moneyswitch-pay/SKILL.md"));
    assert.ok(html.includes("secret-notice"), "uses the existing secret styling");
    assert.ok(html.includes("One key per agent"));
    assert.ok(!html.includes(KEY), "the full key must not be in the DOM text");
    assert.ok(html.includes("mk_live_Ab3d"), "masked prefix visible in the preview");
    assert.ok(html.includes("name: moneyswitch-pay"));
  });

  it("preselects the agent from the key name", () => {
    assert.ok(render(h(SkillForAi, { baseUrl: BASE, secret: KEY, keyName: "OpenClaw" })).includes("Copy for OpenClaw"));
    assert.ok(render(h(SkillForAi, { baseUrl: BASE, secret: KEY, keyName: "Alice - Claude Code" })).includes("Copy for Claude Code"));
    assert.ok(render(h(SkillForAi, { baseUrl: BASE, secret: KEY, keyName: "research bot" })).includes("Copy for Codex"));
  });

  it("without a key: a hint and no copy button; with a malformed key: a warning", () => {
    const none = render(h(SkillForAi, { baseUrl: BASE, secret: "", showLostKeyHint: true }));
    assert.ok(none.includes("Paste a MoneyKey"));
    assert.ok(!none.includes("copy-btn"));
    assert.ok(none.includes("Reset secret and copy skill"));
    const bad = render(h(SkillForAi, { baseUrl: BASE, secret: 'mk_live_"oops' }));
    assert.ok(bad.includes("does not look like a MoneyKey"));
    assert.ok(!bad.includes("copy-btn"));
  });

  it("renders in Chinese", () => {
    const html = render(h(SkillForAi, { baseUrl: BASE, secret: KEY, keyName: "Codex" }), "zh");
    assert.ok(html.includes("复制，给 Codex"));
    assert.ok(html.includes("一个 AI 一把 key"));
    assert.ok(!html.includes(KEY));
  });

  it("nudge can be hidden", () => {
    assert.ok(!render(h(SkillForAi, { baseUrl: BASE, secret: KEY, showNudge: false })).includes("One key per agent"));
  });
});

describe("ConfirmDialog (reset secret)", () => {
  const props = { title: 'Reset the secret of "codex"?', confirmLabel: "Reset secret", onConfirm() {}, onCancel() {} };
  it("explains the consequence and offers Cancel + confirm", () => {
    const html = render(h(ConfirmDialog, { ...props, open: true }, "The old secret stops working immediately"));
    assert.match(html, /role="alertdialog"/);
    assert.ok(html.includes("Reset the secret of"));
    assert.ok(html.includes("The old secret stops working immediately"));
    assert.ok(html.includes(">Cancel<"));
    assert.ok(html.includes(">Reset secret<"));
  });
  it("renders nothing when closed and shows an error when given one", () => {
    assert.equal(render(h(ConfirmDialog, { ...props, open: false }, "x")), "");
    assert.ok(render(h(ConfirmDialog, { ...props, open: true, error: "boom" }, "x")).includes("boom"));
  });
});

describe("employee portal: connect page", () => {
  it("leads with the skill block built from the logged-in key, before the CLI/MCP sections", () => {
    store.set("moneyswitch_employee_key", KEY);
    const html = render(h(AuthProvider, null, h(EmployeeConnectPage)));
    const skillAt = html.indexOf("Give your AI the ability to pay");
    const cliAt = html.indexOf("claude mcp add");
    assert.ok(skillAt >= 0, "skill section present");
    assert.ok(cliAt > skillAt, "manual MCP comes after the skill");
    assert.ok(!html.includes("moneyswitch connect"), "retired config-writing command is absent");
    assert.ok(html.includes("Copy for Codex"));
    assert.ok(html.includes("name: moneyswitch-pay"));
    assert.ok(html.includes("mk_live_Ab3d"));
    assert.ok(!html.includes(KEY), "the real key is never rendered as text");
    store.delete("moneyswitch_employee_key");
  });
});
