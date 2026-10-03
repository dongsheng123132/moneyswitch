// Render tests (react-dom/server, no DOM) for the Wallet page (SPEC.md §2): "Create wallet" when there is none, the 12 words shown once
// and only for the wallet they belong to, the plain statement when they were never written down, the address and balance on every chain,
// the reason a locked wallet is locked, the replaced wallets, and the replace form. Interactivity (clicks) is not exercised here;
// defaults, structure and the calls the buttons make are.
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import type { WalletHealth, WalletInfo } from "../src/api.ts";

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
Object.assign(globalThis, { localStorage: fakeStorage, sessionStorage: fakeStorage, window: { location: { origin: "https://pay.example.com", hash: "" } } });

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const TESTNET = "eip155:10143";
const BASE_SEPOLIA = "eip155:84532";

let WalletPage: typeof import("../src/pages/WalletPage.tsx");
let freshPhrase: typeof import("../src/freshPhrase.ts").freshPhrase;
let api: typeof import("../src/api.ts");
let LangProvider: typeof import("../src/i18n/index.tsx").LangProvider;
let en: (typeof import("../src/i18n/strings/wallet.ts"))["walletStrings"]["en"];

before(async () => {
  WalletPage = await import("../src/pages/WalletPage.tsx");
  freshPhrase = (await import("../src/freshPhrase.ts")).freshPhrase;
  api = await import("../src/api.ts");
  LangProvider = (await import("../src/i18n/index.tsx")).LangProvider;
  en = (await import("../src/i18n/strings/wallet.ts")).walletStrings.en;
});

beforeEach(() => {
  store.clear();
  freshPhrase.clear();
});

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const fill = (s: string, vars: Record<string, string | number>) => esc(s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k])));
const render = (el: Parameters<typeof renderToStaticMarkup>[0], lang: "en" | "zh" = "en") => {
  store.set("moneyswitch_lang", lang);
  return renderToStaticMarkup(h(LangProvider, null, h(StaticRouter, { location: "/wallet" }, el)));
};

const HEALTHY: WalletHealth = {
  protection: "auto",
  unlock_mode: "auto",
  auto_unlock_ok: true,
  unlock_sources: [{ source: "auto", ok: true }],
  secret_file_present: true,
  retired_secrets_open_live_key: [],
  secret_protected: true,
  secret_protection_detail: null,
  orphan_files: { secrets: [], retired: 0, wallet_file_missing: false },
  backup: "confirmed",
  float_limit: "50",
  over_float_limit: { [TESTNET]: false },
};
const NETWORK = { network: TESTNET, label: "Monad Testnet", explorer_base: "https://testnet.monadvision.com", is_mainnet: false, usdc_balance: "0.52", over_float_limit: false as boolean | null };

function wallet(over: Partial<Omit<WalletInfo, "health">> & { health?: Partial<WalletHealth> } = {}): WalletInfo {
  const { health, ...rest } = over;
  return {
    address: ADDRESS,
    unlocked: true,
    has_keystore: true,
    has_recovery_phrase: true,
    backup_confirmed_at: "2026-10-04T12:00:00.000Z",
    network: TESTNET,
    usdc_balance: "0.52",
    networks: [NETWORK],
    retired_wallets: [],
    health: { ...HEALTHY, ...health },
    ...rest,
  };
}

const NO_WALLET = wallet({
  address: null,
  unlocked: false,
  has_keystore: false,
  has_recovery_phrase: false,
  backup_confirmed_at: null,
  usdc_balance: null,
  networks: [{ ...NETWORK, usdc_balance: null, over_float_limit: null }],
  health: { protection: "none", unlock_mode: "none", auto_unlock_ok: null, unlock_sources: [], secret_file_present: null, secret_protected: null, backup: "not_applicable", over_float_limit: {} },
});

const view = (w: WalletInfo, meta: Parameters<typeof WalletPage.WalletView>[0]["meta"] = null, lang: "en" | "zh" = "en") =>
  render(h(WalletPage.WalletView, { wallet: w, meta, onChanged() {} }), lang);

describe("no wallet yet", () => {
  it("offers 'Create wallet' and nothing else: no password field, no import, no replace form", () => {
    const html = view(NO_WALLET);
    assert.ok(html.includes(`>${en.createButton}<`));
    assert.ok(html.includes('data-action-id="wallet.create"'));
    assert.ok(html.includes(esc(en.createExplain)));
    assert.ok(!/<input[^>]*type="password"/.test(html));
    assert.ok(!/import|reveal|download/i.test(html));
    assert.ok(!html.includes('data-testid="replace-wallet"'));
    assert.ok(!html.includes('data-testid="phrase-card"'));
  });

  it("when wallet.json is missing but credential files remain: a warning with the counts, and creating needs an explicit yes", () => {
    const html = view(wallet({ ...NO_WALLET, health: { ...NO_WALLET.health, orphan_files: { secrets: ["0xold"], retired: 2, wallet_file_missing: true } } }));
    assert.ok(html.includes('data-testid="orphan-warning"'));
    assert.ok(html.includes(fill(en.orphanBody, { secrets: 1, retired: 2 })));
    assert.match(html, /<button[^>]*data-action-id="wallet.create"[^>]*disabled=""/);
  });

  it("right after 'Create' the 12 words are on screen (the creation response is the authority) with the 'I wrote it down' step", () => {
    freshPhrase.set(ADDRESS, PHRASE);
    const html = view(NO_WALLET);
    assert.ok(html.includes('data-testid="phrase-card"'));
    assert.ok(!html.includes(`>${en.createButton}<`));
    assert.match(html, /<button[^>]*disabled=""[^>]*>Done<\/button>/, "Done stays disabled until the box is ticked");
  });

  it("is available in Chinese", () => {
    assert.ok(view(NO_WALLET, null, "zh").includes("创建钱包"));
  });
});

describe("the 12 words", () => {
  it("are shown numbered, once, for the wallet they were handed out for, with the warning that they cannot be shown again", () => {
    freshPhrase.set(ADDRESS, PHRASE);
    const html = view(wallet({ health: { backup: "missing" }, backup_confirmed_at: null }));
    assert.ok(html.includes('data-testid="phrase-card"'));
    assert.equal(html.split("wallet-phrase-word").length - 1, 12);
    for (const word of PHRASE.split(" ")) assert.ok(html.includes(`>${word}<`), word);
    assert.equal(html.split(">12<").length - 1 >= 1, true, "numbered up to 12");
    assert.ok(html.includes(esc(en.phraseWarnTitle)));
    assert.ok(html.includes(esc(en.phraseWarnBody)));
    assert.ok(html.includes(esc(en.phraseAck)));
  });

  it("are not shown for another wallet (a phrase that belongs to a replaced wallet must never turn up here)", () => {
    freshPhrase.set(OTHER_ADDRESS, PHRASE);
    const html = view(wallet());
    assert.ok(!html.includes('data-testid="phrase-card"'));
    assert.ok(!html.includes("abandon"));
  });

  it("are gone once acknowledged: the page then only says whether they were confirmed", () => {
    freshPhrase.set(ADDRESS, PHRASE);
    freshPhrase.clear();
    const html = view(wallet());
    assert.ok(!html.includes('data-testid="phrase-card"'));
    assert.ok(html.includes('data-check="backup">Yes<'));
  });

  it("never written down (no acknowledgement and no words on screen): the page says plainly to replace the wallet to get new words", () => {
    const html = view(wallet({ health: { backup: "missing" }, backup_confirmed_at: null }));
    assert.ok(html.includes('data-testid="backup-missing"'));
    assert.ok(html.includes(esc(en.backupMissingTitle)));
    assert.ok(html.includes(esc(en.backupMissingBody)));
    assert.ok(/no loss while|lose nothing while/.test(esc(en.backupMissingBody)), "the reassurance is part of the text");
    assert.ok(html.includes(`data-check="backup">${en.notConfirmed}<`));
  });

  it("a wallet made from a bare private key by an older version has no words to write down: no warning", () => {
    const html = view(wallet({ has_recovery_phrase: false, health: { backup: "not_applicable" } }));
    assert.ok(!html.includes('data-testid="backup-missing"'));
    assert.ok(html.includes(`data-check="backup">${en.notApplicable}<`));
  });
});

describe("a wallet: address and balance on every chain", () => {
  it("shows the address (copyable, with a QR on request), each chain with its balance and an explorer link, the float limit and how to fund a test wallet", () => {
    const meta = { faucet_url: "https://faucet.example/usdc" } as never;
    const html = view(
      wallet({
        networks: [NETWORK, { ...NETWORK, network: BASE_SEPOLIA, label: "Base Sepolia", explorer_base: "https://sepolia.basescan.org", usdc_balance: null, over_float_limit: null }],
      }),
      meta
    );
    assert.ok(html.includes(ADDRESS));
    assert.ok(html.includes("0.52 USDC"));
    assert.ok(html.includes(`data-network="${BASE_SEPOLIA}"`));
    assert.ok(html.includes(`>${en.balanceUnknown}<`), "an unreachable RPC is 'unknown', not zero");
    assert.ok(html.includes(`href="https://testnet.monadvision.com/address/${ADDRESS}"`));
    assert.ok(html.includes(`href="https://sepolia.basescan.org/address/${ADDRESS}"`));
    assert.ok(html.includes(fill(en.floatNote, { limit: "50" })));
    assert.ok(html.includes(esc(en.fundTestnet)));
    assert.ok(html.includes('href="https://faucet.example/usdc"'));
  });

  it("a balance over the limit is flagged on its chain", () => {
    const html = view(wallet({ networks: [{ ...NETWORK, usdc_balance: "60", over_float_limit: true }] }));
    assert.ok(html.includes(fill(en.overLimit, { limit: "50" })));
  });

  it("a mainnet chain says it is real money and offers no faucet", () => {
    const html = view(wallet({ networks: [{ ...NETWORK, network: "eip155:143", label: "Monad Mainnet", is_mainnet: true }] }));
    assert.ok(html.includes(esc(en.fundMainnet)));
    assert.ok(!html.includes(esc(en.fundTestnet)));
  });

  it("has no import, reveal, download or unlock form", () => {
    const html = view(wallet());
    assert.ok(!/import|reveal|download/i.test(html));
    assert.ok(!/<input[^>]*type="password"/.test(html));
    assert.ok(!html.includes('data-action-id="wallet.unlock"'));
  });
});

describe("state and problems", () => {
  it("a healthy wallet: unlocks itself, the folder is protected, the words are confirmed - and no warning at all", () => {
    const html = view(wallet());
    assert.ok(html.includes('data-check="unlock">Yes<'));
    assert.ok(html.includes('data-check="protect">Yes<'));
    assert.ok(html.includes('data-check="backup">Yes<'));
    assert.ok(!html.includes(esc(en.lockedTitle)) && !html.includes(esc(en.secretGoneTitle)) && !html.includes(esc(en.unprotectedTitle)));
  });

  const lockedCases: Array<[string, Partial<WalletHealth>, keyof typeof en]> = [
    ["an auto wallet whose unlock file is missing", { unlock_sources: [{ source: "auto", ok: false, reason: "secret_missing" }], auto_unlock_ok: false }, "locked_secret_missing"],
    ["an auto wallet whose unlock file is empty", { unlock_sources: [{ source: "auto", ok: false, reason: "secret_empty" }], auto_unlock_ok: false }, "locked_secret_empty"],
    ["an auto wallet whose unlock file cannot be read", { unlock_sources: [{ source: "auto", ok: false, reason: "secret_unreadable" }], auto_unlock_ok: false }, "locked_secret_unreadable"],
    ["an auto wallet whose unlock file does not open it", { unlock_sources: [{ source: "auto", ok: false, reason: "secret_wrong" }], auto_unlock_ok: false }, "locked_secret_wrong"],
    ["a password wallet of an older version, nobody gave the server its password", { protection: "password", unlock_mode: "manual", auto_unlock_ok: null, unlock_sources: [] }, "locked_password"],
    [
      "a password wallet whose configured password is wrong",
      { protection: "password", unlock_mode: "env_or_file", auto_unlock_ok: false, unlock_sources: [{ source: "env_or_file", ok: false, reason: "env_wrong" }] },
      "locked_env_wrong",
    ],
  ];
  for (const [label, health, expected] of lockedCases) {
    it(`locked: ${label} - says why and what to do`, () => {
      const w = wallet({ unlocked: false, health });
      assert.equal(WalletPage.lockedReason(w), expected);
      const html = view(w);
      assert.ok(html.includes(esc(en.lockedTitle)));
      assert.ok(html.includes(esc(en[expected])));
      assert.ok(html.includes('data-check="unlock">No<'));
      assert.ok(html.includes('data-testid="replace-wallet"'), "replacing is always one click away");
    });
  }

  it("lockedReason: an unlocked wallet and a missing one are not 'locked'", () => {
    assert.equal(WalletPage.lockedReason(wallet()), null);
    assert.equal(WalletPage.lockedReason(NO_WALLET), null);
  });

  it("the unlock file disappearing while the server runs is flagged before the restart that would fail", () => {
    const html = view(wallet({ health: { secret_file_present: false } }));
    assert.ok(html.includes(esc(en.secretGoneTitle)));
    assert.ok(!html.includes(esc(en.lockedTitle)));
  });

  it("a data folder that could not be locked down is flagged with the reason", () => {
    const html = view(wallet({ health: { secret_protected: false, secret_protection_detail: "icacls: access denied" } }));
    assert.ok(html.includes(esc(en.unprotectedTitle)));
    assert.ok(html.includes("icacls: access denied"));
    assert.ok(html.includes('data-check="protect">Not verified: icacls: access denied<'));
  });

  it("a retired unlock file that still opens a legacy wallet is named", () => {
    const html = view(wallet({ health: { retired_secrets_open_live_key: ["wallet-unlock-old.secret"] } }));
    assert.ok(html.includes(fill(en.retiredOpenerBody, { files: "wallet-unlock-old.secret" })));
  });
});

describe("replaced wallets and the replace form", () => {
  const retired = {
    address: OTHER_ADDRESS,
    retired_at: "2026-10-03T10:00:00.000Z",
    reason: "lost_password",
    keystore_file: "wallet-0x7099-20261003.json",
    has_secret_file: true,
    replaced_by: ADDRESS,
    balances: { [TESTNET]: "1.5" } as Record<string, string | null>,
  };

  it("lists each replaced wallet with its address, date, reason, balance per chain and what is kept, and points at the recovery steps", () => {
    const html = view(wallet({ retired_wallets: [retired, { ...retired, address: ADDRESS, has_secret_file: false, balances: { [TESTNET]: null } }] }));
    assert.ok(html.includes('data-testid="retired-wallets"'));
    assert.ok(html.includes(OTHER_ADDRESS));
    assert.ok(html.includes("2026-10-03"));
    assert.ok(html.includes("lost_password"));
    assert.ok(html.includes("Monad Testnet: 1.5 USDC"));
    assert.ok(html.includes(`Monad Testnet: ${en.balanceUnknown}`));
    assert.ok(html.includes(en.retiredFilesKeystoreAndSecret) && html.includes(en.retiredFilesKeystore));
    assert.ok(html.includes("docs/wallet-setup.md"));
  });

  it("no replaced wallets: no such card", () => {
    assert.ok(!view(wallet()).includes('data-testid="retired-wallets"'));
  });

  it("the replace form asks for the reason and for the current address, and stays disabled until it is typed exactly", () => {
    const html = view(wallet());
    assert.ok(html.includes('data-testid="replace-wallet"'));
    assert.ok(html.includes(esc(en.replaceLead)));
    for (const key of ["reason_replaced", "reason_lost_password", "reason_suspected_leak"] as const) assert.ok(html.includes(esc(en[key])), key);
    assert.ok(html.includes(`placeholder="${ADDRESS}"`));
    assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>Replace wallet<\/button>/);
    assert.ok(html.includes(esc(en.replaceMoveMoney)));
  });
});

describe("what the buttons call (api.ts)", () => {
  const real = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; body?: unknown; auth?: string }> = [];
  beforeEach(() => {
    calls.length = 0;
    store.set("moneyswitch_admin_token", "ms_admin_testtoken");
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), auth: (init?.headers as Record<string, string>)?.Authorization });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });

  it("create, 'I wrote it down' and replace are three authenticated POSTs; create and the acknowledgement carry no body", async () => {
    try {
      await api.createWallet();
      await api.confirmBackup();
      await api.replaceWallet(ADDRESS, "lost_password");
    } finally {
      globalThis.fetch = real;
    }
    assert.deepEqual(calls, [
      { url: "/v1/admin/wallet/create", method: "POST", body: undefined, auth: "Bearer ms_admin_testtoken" },
      { url: "/v1/admin/wallet/backup/confirm", method: "POST", body: undefined, auth: "Bearer ms_admin_testtoken" },
      { url: "/v1/admin/wallet/replace", method: "POST", body: { confirm_address: ADDRESS, reason: "lost_password" }, auth: "Bearer ms_admin_testtoken" },
    ]);
  });

  it("the client has no call for the removed routes (import, password unlock, reveal, backup download, auto-unlock, retired list)", () => {
    globalThis.fetch = real;
    for (const name of ["importWallet", "unlockWallet", "revealWallet", "backupWallet", "setAutoUnlock", "listRetiredWallets"]) {
      assert.equal((api as Record<string, unknown>)[name], undefined, name);
    }
    for (const name of ["getWallet", "createWallet", "confirmBackup", "replaceWallet"]) assert.equal(typeof (api as Record<string, unknown>)[name], "function", name);
  });
});

describe("the words live in memory only", () => {
  it("are kept per wallet address, readable only for that address, and cleared on request", () => {
    assert.equal(freshPhrase.get(), null);
    freshPhrase.set(ADDRESS, PHRASE);
    assert.equal(freshPhrase.getFor(ADDRESS), PHRASE);
    assert.equal(freshPhrase.getFor(ADDRESS.toLowerCase()), PHRASE, "address case does not matter");
    assert.equal(freshPhrase.getFor(OTHER_ADDRESS), null);
    freshPhrase.clear();
    assert.equal(freshPhrase.get(), null);
    assert.equal(store.size, 0, "nothing was written to a storage");
  });
});
