// Render tests (react-dom/server, no DOM) for the wallet lifecycle UI: the set-up step has no password field
// by default, the recovery phrase flow, the health card, the Overview banners, the danger zone and the
// retired wallets list. Interactivity (clicks) is not exercised here; defaults and structure are.
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
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

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OLD_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const PHRASE = "test test test test test test test test test test test junk";
const NETWORK = "eip155:10143";

type Api = typeof import("../src/api.ts");
type Wallet = import("../src/api.ts").WalletInfo;
type Health = import("../src/api.ts").WalletHealth;

let LangProvider: typeof import("../src/i18n/index.tsx").LangProvider;
let AuthProvider: typeof import("../src/auth.tsx").AuthProvider;
let WalletStep: typeof import("../src/pages/SetupPage.tsx").WalletStep;
let WalletView: typeof import("../src/pages/WalletPage.tsx").WalletView;
let WalletSetup: typeof import("../src/components/WalletSetup.tsx").WalletSetup;
let BackupFlow: typeof import("../src/components/WalletSetup.tsx").BackupFlow;
let PhraseView: typeof import("../src/components/WalletSetup.tsx").PhraseView;
let pickPositions: typeof import("../src/components/WalletSetup.tsx").pickPositions;
let WalletHealthCard: typeof import("../src/components/WalletHealth.tsx").WalletHealthCard;
let WalletBanners: typeof import("../src/components/WalletHealth.tsx").WalletBanners;
let walletBannerKinds: typeof import("../src/components/WalletHealth.tsx").walletBannerKinds;
let WalletDangerZone: typeof import("../src/components/WalletDangerZone.tsx").WalletDangerZone;
let ReplaceSection: typeof import("../src/components/WalletDangerZone.tsx").ReplaceSection;
let RetiredWalletsList: typeof import("../src/components/WalletDangerZone.tsx").RetiredWalletsList;
let WalletChip: typeof import("../src/components/WalletChip.tsx").WalletChip;
let WalletAccess: typeof import("../src/components/WalletAccess.tsx").WalletAccess;
let freshPhrase: typeof import("../src/freshPhrase.ts").freshPhrase;
let L: (typeof import("../src/i18n/strings/walletLifecycle.ts"))["walletLifecycle"];

before(async () => {
  LangProvider = (await import("../src/i18n/index.tsx")).LangProvider;
  AuthProvider = (await import("../src/auth.tsx")).AuthProvider;
  WalletStep = (await import("../src/pages/SetupPage.tsx")).WalletStep;
  WalletView = (await import("../src/pages/WalletPage.tsx")).WalletView;
  const setup = await import("../src/components/WalletSetup.tsx");
  ({ WalletSetup, BackupFlow, PhraseView, pickPositions } = setup);
  ({ WalletHealthCard, WalletBanners, walletBannerKinds } = await import("../src/components/WalletHealth.tsx"));
  const danger = await import("../src/components/WalletDangerZone.tsx");
  ({ WalletDangerZone, RetiredWalletsList, ReplaceSection } = danger);
  WalletChip = (await import("../src/components/WalletChip.tsx")).WalletChip;
  WalletAccess = (await import("../src/components/WalletAccess.tsx")).WalletAccess;
  freshPhrase = (await import("../src/freshPhrase.ts")).freshPhrase;
  L = (await import("../src/i18n/strings/walletLifecycle.ts")).walletLifecycle;
});

beforeEach(() => store.clear());
afterEach(() => freshPhrase.clear());

const render = (el: Parameters<typeof renderToStaticMarkup>[0], lang: "en" | "zh" = "en") => {
  store.set("moneyswitch_lang", lang);
  return renderToStaticMarkup(h(LangProvider, null, h(StaticRouter, { location: "/" }, h(AuthProvider, null, el))));
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const fill = (s: string, vars: Record<string, string | number>) => esc(s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k])));
const noop = () => undefined;

function health(over: Partial<Health> = {}): Health {
  return {
    protection: "auto",
    unlock_mode: "auto",
    auto_unlock_ok: true,
    unlock_sources: [{ source: "auto", ok: true }],
    secret_file_present: true,
    secret_protected: true,
    secret_protection_detail: null,
    orphan_files: { secrets: [], retired: 0, wallet_file_missing: false },
    backup: "confirmed",
    float_limit: "50",
    over_float_limit: { [NETWORK]: false },
    retired_wallets: [],
    ...over,
  };
}
function wallet(over: Partial<Wallet> = {}, healthOver: Partial<Health> | null = {}): Wallet {
  return {
    address: ADDRESS,
    unlocked: true,
    has_keystore: true,
    auto_unlock_configured: true,
    usdc_balance: "12.34",
    network: NETWORK,
    has_recovery_phrase: true,
    backup_confirmed_at: "2026-10-03T00:00:00.000Z",
    ...(healthOver === null ? {} : { health: health(healthOver) }),
    ...over,
  };
}
const noWallet = (): Wallet => ({
  address: null,
  unlocked: false,
  has_keystore: false,
  usdc_balance: null,
  network: NETWORK,
  health: health({ protection: "none", unlock_mode: "none", auto_unlock_ok: null, unlock_sources: [], secret_file_present: null, secret_protected: null, backup: "not_applicable", over_float_limit: {} }),
});
const manualHealth: Partial<Health> = { protection: "password", unlock_mode: "manual", auto_unlock_ok: null, unlock_sources: [], secret_file_present: null, secret_protected: null };

describe("set-up step: no password by default", () => {
  it("the wizard's wallet step offers 'Create wallet (recommended)' and has NO password field", () => {
    const html = render(h(WalletStep, { wallet: noWallet(), refresh: noop }));
    assert.ok(html.includes(esc(L.en.createRecommended)), "recommended path is the headline");
    assert.ok(html.includes('data-action-id="wallet.create"'));
    assert.ok(html.includes(esc(L.en.createExplain)));
    assert.ok(!html.includes('type="password"'), "no password input anywhere in the default view");
    assert.ok(!html.includes("wallet-password"), "and no password field id");
    assert.ok(!html.includes('type="checkbox" checked'), "the advanced option starts off");
  });

  it("the other ways are secondary: import a recovery phrase, a private key or an encrypted keystore; the 'ask for a password' toggle is advanced", () => {
    const html = render(h(WalletStep, { wallet: noWallet(), refresh: noop }));
    const primary = html.indexOf(esc(L.en.createRecommended));
    const other = html.indexOf(esc(L.en.otherWays));
    const advanced = html.indexOf(esc(L.en.advancedToggle));
    assert.ok(primary >= 0 && advanced > primary && other > advanced, "order: create, advanced toggle, other ways");
    assert.match(html, /<details class="advanced-details wallet-setup-other"><summary>/);
    for (const label of [L.en.methodPhrase, L.en.methodKey, L.en.methodKeystore]) assert.ok(html.includes(esc(label)), label);
    assert.ok(html.includes('id="wallet-import-phrase"'), "the recovery phrase is the default import");
    assert.ok(!html.includes('id="wallet-import-key"') && !html.includes('id="wallet-import-file"'), "key / file inputs only appear when chosen");
    assert.ok(html.includes(esc(L.en.advancedHint)), "the trade-off is stated next to the toggle");
  });

  it("turning the advanced option on adds the password and confirmation fields (and only then)", () => {
    const html = render(h(WalletSetup, { onDone: noop, initialAdvanced: true }));
    assert.ok(html.includes('id="wallet-password"'));
    assert.ok(html.includes('id="wallet-confirm-password"'));
    assert.equal(html.split('type="password"').length - 1, 2);
    assert.ok(html.includes(esc(L.en.newPassword)));
  });

  it("renders in Chinese", () => {
    const html = render(h(WalletStep, { wallet: noWallet(), refresh: noop }), "zh");
    assert.ok(html.includes(L.zh.createRecommended));
    assert.ok(html.includes(L.zh.advancedToggle));
    assert.ok(!html.includes('type="password"'));
  });

  it("a locked wallet gets the unlock form (the one place a password is asked), and says what to do if it is lost", () => {
    const html = render(h(WalletStep, { wallet: wallet({ unlocked: false }, manualHealth), refresh: noop }));
    assert.ok(html.includes('data-action-id="wallet.unlock"'));
    assert.ok(html.includes('type="password"'));
    assert.ok(html.includes(esc(L.en.lockedRecovery)));
    assert.ok(!html.includes(esc(L.en.hAutoBroken)));
  });

  it("a wallet whose unlock secret is broken says so on the unlock form", () => {
    const html = render(h(WalletStep, { wallet: wallet({ unlocked: false }, { unlock_mode: "auto", auto_unlock_ok: false }), refresh: noop }));
    assert.ok(html.includes(esc(L.en.hAutoBroken)));
  });

  it("an open wallet with an unconfirmed backup shows the backup prompt, not the address", () => {
    const html = render(h(WalletStep, { wallet: wallet({}, { backup: "missing" }), refresh: noop }));
    assert.ok(html.includes('data-testid="backup-required"'));
    assert.ok(html.includes(esc(L.en.finishBackupTitle)));
    assert.ok(!html.includes(ADDRESS), "the deposit address is not on the page");
    assert.ok(!html.includes("qr-wrap"), "nor its QR code");
  });

  it("once the backup is confirmed the address, QR and funding steps are shown", () => {
    const html = render(h(WalletStep, { wallet: wallet(), refresh: noop }));
    assert.ok(html.includes(ADDRESS));
    assert.ok(html.includes("qr-wrap"));
    assert.ok(!html.includes('data-testid="backup-required"'));
  });
});

describe("recovery phrase flow", () => {
  it("right after creation the 12 numbered words and the warning are shown", () => {
    freshPhrase.set(ADDRESS, PHRASE);
    const html = render(h(WalletSetup, { onDone: noop }));
    assert.ok(html.includes('data-testid="backup-required"'));
    assert.equal((html.match(/class="wallet-phrase-index"/g) ?? []).length, 12);
    for (const [i, word] of PHRASE.split(" ").entries()) assert.ok(html.includes(`<span class="wallet-phrase-index">${i + 1}</span><span class="wallet-phrase-word mono">${word}</span>`), word);
    assert.ok(html.includes(esc(L.en.phraseWarnTitle)));
    assert.ok(html.includes(esc(L.en.phraseWarnBody)));
    assert.ok(html.includes(esc(L.en.phraseCompat)));
    assert.ok(html.includes(esc(L.en.phraseWritten)));
    assert.ok(!html.includes('type="password"'), "still no password anywhere");
  });

  it("without a fresh phrase (page reloaded) it asks for the wallet address before showing anything", () => {
    const html = render(h(BackupFlow, { onConfirmed: noop }));
    assert.ok(html.includes('id="wallet-reveal-address"'));
    assert.ok(html.includes(esc(L.en.typeAddress)));
    assert.ok(html.includes(esc(L.en.showPhraseButton)));
    assert.ok(!html.includes("wallet-phrase-grid"));
    assert.ok(!html.includes(PHRASE.split(" ")[0] + "</span>"));
  });

  it("the phrase view warns in Chinese too", () => {
    const html = render(h(PhraseView, { phrase: PHRASE, onWritten: noop }), "zh");
    assert.ok(html.includes(L.zh.phraseWarnTitle));
    assert.ok(html.includes(L.zh.phraseWritten));
  });

  it("two random, different, ascending positions out of 12 (every position gets picked)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 600; i++) {
      const [a, b] = pickPositions(12);
      assert.ok(Number.isInteger(a) && Number.isInteger(b));
      assert.ok(a >= 1 && b <= 12 && a < b, `${a},${b}`);
      seen.add(a);
      seen.add(b);
    }
    assert.equal(seen.size, 12);
  });

  it("the fresh phrase lives in memory only", () => {
    freshPhrase.set(ADDRESS, PHRASE);
    render(h(WalletSetup, { onDone: noop }));
    assert.equal(store.size, 1, "only the language preference was written to storage (the render helper sets it)");
    assert.ok(![...store.values()].some((v) => v.includes("junk")));
    freshPhrase.clear();
    assert.equal(freshPhrase.get(), null);
  });
});

describe("wallet health card", () => {
  it("healthy auto-unlock wallet: four green rows (unlock, secret protection, backup, balance) and the balance against the float limit", () => {
    const html = render(h(WalletHealthCard, { wallet: wallet() }));
    assert.ok(html.includes('data-testid="wallet-health"'));
    assert.ok(html.includes(esc(L.en.healthTitle)));
    assert.ok(html.includes(esc(L.en.hAutoOk)));
    assert.ok(html.includes(esc(L.en.hBackupConfirmed)));
    assert.ok(html.includes(fill(L.en.hFloatLine, { balance: "12.34", limit: "50" })));
    assert.ok(html.includes(esc(L.en.hProtectOk)));
    assert.equal((html.match(/pill pill-green/g) ?? []).length, 4);
    assert.ok(!html.includes("pill-red") && !html.includes("pill-yellow"));
    assert.ok(!html.includes(esc(L.en.hFloatOver)));
  });

  it("broken auto-unlock is red and says the wallet will stay locked after a restart", () => {
    const html = render(h(WalletHealthCard, { wallet: wallet({}, { auto_unlock_ok: false }) }));
    assert.ok(html.includes(esc(L.en.hAutoBroken)));
    assert.match(html, /data-health="unlock"><div class="wallet-health-head"><span class="wallet-health-label">[^<]*<\/span><span class="pill pill-red">/);
  });

  it("missing backup is an action item", () => {
    const html = render(h(WalletHealthCard, { wallet: wallet({}, { backup: "missing" }) }));
    assert.ok(html.includes(esc(L.en.hBackupMissing)));
    assert.match(html, /data-health="backup"><div class="wallet-health-head"><span class="wallet-health-label">[^<]*<\/span><span class="pill pill-yellow">/);
  });

  it("a wallet imported from a key has nothing to back up", () => {
    const html = render(h(WalletHealthCard, { wallet: wallet({}, { backup: "not_applicable" }) }));
    assert.ok(html.includes(esc(L.en.hBackupNA)));
  });

  it("over the float limit: red pill and the hot-wallet warning", () => {
    const html = render(h(WalletHealthCard, { wallet: wallet({ usdc_balance: "120.5" }, { over_float_limit: { [NETWORK]: true } }) }));
    assert.ok(html.includes(esc(L.en.hFloatOver)));
    assert.ok(html.includes(esc(L.en.pillOver)));
    assert.ok(html.includes(fill(L.en.hFloatLine, { balance: "120.5", limit: "50" })));
    assert.ok(html.includes("progress-fill danger"), "the bar is full");
  });

  it("an unreadable balance is 'unknown', never zero", () => {
    const html = render(h(WalletHealthCard, { wallet: wallet({ usdc_balance: null }, { over_float_limit: {} }) }));
    assert.ok(html.includes(esc(L.en.hFloatUnknown)));
    assert.ok(!html.includes("progress-track"));
  });

  it("manual mode and the legacy password are described as such", () => {
    assert.ok(render(h(WalletHealthCard, { wallet: wallet({}, manualHealth) })).includes(esc(L.en.hManual)));
    assert.ok(render(h(WalletHealthCard, { wallet: wallet({}, { ...manualHealth, unlock_mode: "env_or_file", auto_unlock_ok: true }) })).includes(esc(L.en.hEnvOk)));
    assert.ok(render(h(WalletHealthCard, { wallet: wallet({}, { ...manualHealth, unlock_mode: "env_or_file", auto_unlock_ok: false }) })).includes(esc(L.en.hEnvBroken)));
  });

  it("renders nothing for an older server (no health) or before a wallet exists", () => {
    assert.equal(render(h(WalletHealthCard, { wallet: wallet({}, null) })), "");
    assert.equal(render(h(WalletHealthCard, { wallet: noWallet() })), "");
  });

  it("Chinese", () => {
    const html = render(h(WalletHealthCard, { wallet: wallet({}, { backup: "missing", auto_unlock_ok: false }) }), "zh");
    assert.ok(html.includes(L.zh.healthTitle));
    assert.ok(html.includes(L.zh.hAutoBroken));
    assert.ok(html.includes(L.zh.hBackupMissing));
  });
});

describe("Overview banners", () => {
  it("backup missing -> banner with a link to the Wallet page", () => {
    const html = render(h(WalletBanners, { wallet: wallet({}, { backup: "missing" }) }));
    assert.ok(html.includes(esc(L.en.bannerBackupMissing)));
    assert.ok(html.includes('href="/wallet"'));
    assert.ok(html.includes(esc(L.en.bannerBackupAction)));
    assert.ok(!html.includes(esc(L.en.bannerAutoBroken)));
  });

  it("auto-unlock broken -> error banner, listed first", () => {
    const html = render(h(WalletBanners, { wallet: wallet({}, { auto_unlock_ok: false, backup: "missing" }) }));
    assert.ok(html.indexOf(esc(L.en.bannerAutoBroken)) >= 0 && html.indexOf(esc(L.en.bannerAutoBroken)) < html.indexOf(esc(L.en.bannerBackupMissing)));
    assert.ok(html.includes("callout-error"));
  });

  it("nothing when all is well, with an older server, without a wallet, or in the offline demo", () => {
    assert.equal(render(h(WalletBanners, { wallet: wallet() })), "");
    assert.equal(render(h(WalletBanners, { wallet: wallet({}, null) })), "");
    assert.equal(render(h(WalletBanners, { wallet: null })), "");
    assert.deepEqual(walletBannerKinds(wallet({}, { backup: "missing", auto_unlock_ok: false }), true), []);
    assert.deepEqual(walletBannerKinds(wallet({ simulated: true }, { backup: "missing" })), []);
    assert.deepEqual(walletBannerKinds(wallet({}, { backup: "missing", auto_unlock_ok: false })), ["autoBroken", "backupMissing"]);
    assert.deepEqual(walletBannerKinds(wallet({}, { auto_unlock_ok: null })), []);
  });

  it("Chinese", () => {
    assert.ok(render(h(WalletBanners, { wallet: wallet({}, { backup: "missing" }) }), "zh").includes(L.zh.bannerBackupMissing));
  });
});

describe("Wallet page", () => {
  const view = (w: Wallet, lang: "en" | "zh" = "en") => render(h(WalletView, { wallet: w, meta: null, onChanged: noop }), lang);

  it("until the backup is confirmed the deposit address is replaced by 'Finish the backup first'", () => {
    const html = view(wallet({}, { backup: "missing" }));
    assert.ok(html.includes(esc(L.en.finishBackupTitle)));
    assert.ok(html.includes('data-testid="backup-required"'));
    assert.ok(!html.includes(ADDRESS), "the address appears nowhere on the page");
    assert.ok(!html.includes("public-address-value"));
    assert.ok(!html.includes("wallet-funding-steps"), "no 'how to fund' steps either");
    assert.ok(html.includes('data-testid="wallet-health"'), "the health card says why");
  });

  it("after the backup is confirmed the address, QR and funding steps are back", () => {
    const html = view(wallet());
    assert.ok(html.includes("public-address-value"));
    assert.ok(html.includes(ADDRESS));
    assert.ok(html.includes("wallet-funding-steps"));
    assert.ok(!html.includes('data-testid="backup-required"'));
  });

  it("has the health card, the danger zone and no password field while the wallet is open", () => {
    const html = view(wallet());
    assert.ok(html.includes('data-testid="wallet-health"'));
    assert.ok(html.includes('data-testid="wallet-danger-zone"'));
    assert.ok(!html.includes('id="wallet-password"'), "no unlock form for an open wallet");
  });

  it("a locked wallet shows the unlock form and keeps the danger zone open (a lost password is exactly when it is needed)", () => {
    const html = view(wallet({ unlocked: false }, manualHealth));
    assert.ok(html.includes('data-action-id="wallet.unlock"'));
    assert.match(html, /<details open=""><summary id="wallet-danger-title">/);
  });

  it("no wallet yet -> the set-up step, without a password field", () => {
    const html = view(noWallet());
    assert.ok(html.includes(esc(L.en.createRecommended)));
    assert.ok(!html.includes('type="password"'));
  });

  it("an older server without health still renders the page", () => {
    const html = view(wallet({}, null));
    assert.ok(html.includes("public-address-value"));
    assert.ok(!html.includes('data-testid="wallet-health"'));
  });

  it("Chinese", () => {
    assert.ok(view(wallet({}, { backup: "missing" }), "zh").includes(L.zh.finishBackupTitle));
  });
});

describe("danger zone", () => {
  const zone = (w: Wallet, lang: "en" | "zh" = "en") => render(h(WalletDangerZone, { wallet: w, onChanged: noop }), lang);

  it("has reveal, auto-unlock, download backup, replace and the retired list; it is closed while all is well", () => {
    const html = zone(wallet());
    for (const section of ["reveal", "auto-unlock", "backup", "replace", "retired"]) assert.ok(html.includes(`data-section="${section}"`), section);
    assert.match(html, /<details><summary id="wallet-danger-title">/);
    assert.ok(html.includes(esc(L.en.revealTitle)));
    assert.ok(html.includes(esc(L.en.replaceTitle)));
    assert.ok(html.includes(esc(L.en.backupDlTitle)));
  });

  it("while the backup is unfinished the address is shown nowhere, so reveal points at the guided backup instead of asking for it to be typed", () => {
    const html = zone(wallet({}, { backup: "missing" }));
    assert.ok(html.includes('data-section="reveal"'));
    assert.ok(html.includes(esc(L.en.revealUseBackupFlow)));
    assert.ok(!html.includes('id="wallet-reveal-address"'));
    assert.ok(html.includes('id="replace-address"'));
  });

  it("reveal and replace both make the operator type the wallet address", () => {
    const html = zone(wallet());
    assert.ok(html.includes('id="wallet-reveal-address"'));
    assert.ok(html.includes('id="replace-address"'));
    assert.ok(html.includes(esc(L.en.replaceTypeAddress)));
    assert.ok(html.includes(esc(L.en.reasonLost)) && html.includes(esc(L.en.reasonLeak)));
  });

  it("an auto-unlock wallet explains the trade-off honestly and offers to turn it OFF with a new password; the backup download asks for a file password", () => {
    const html = zone(wallet());
    assert.ok(html.includes(esc(L.en.autoOnBody)));
    assert.ok(html.includes(esc(L.en.autoOffButton)));
    assert.ok(html.includes('id="auto-off-password"'));
    assert.ok(!html.includes(esc(L.en.autoOnButton)));
    assert.ok(html.includes(esc(L.en.backupDlBodyAuto)));
    assert.ok(html.includes('id="backup-password"'));
  });

  it("a manual wallet offers to turn auto-unlock ON, and downloads its own file without asking for a password", () => {
    const html = zone(wallet({}, manualHealth));
    assert.ok(html.includes(esc(L.en.autoManualBody)));
    assert.ok(html.includes(esc(L.en.autoOnButton)));
    assert.ok(!html.includes('id="auto-off-password"'));
    assert.ok(html.includes(esc(L.en.backupDlBodyManual)));
    assert.ok(!html.includes('id="backup-password"'));
  });

  it("a broken auto-unlock opens the section and offers the repair", () => {
    const html = zone(wallet({}, { auto_unlock_ok: false }));
    assert.match(html, /<details open="">/);
    assert.ok(html.includes(esc(L.en.autoRepairButton)));
  });

  it("a locked wallet cannot be re-encrypted: the toggle says to unlock first", () => {
    const html = zone(wallet({ unlocked: false }, manualHealth));
    assert.ok(html.includes(esc(L.en.autoNeedUnlock)));
    assert.match(html, /<button type="button" class="btn secondary" disabled="">[^<]*Turn on auto-unlock/);
  });

  it("Chinese", () => {
    const html = zone(wallet(), "zh");
    assert.ok(html.includes(L.zh.dangerTitle));
    assert.ok(html.includes(L.zh.replaceTitle));
  });
});

describe("retired wallets list", () => {
  const rows = [
    { address: OLD_ADDRESS, retired_at: "2026-10-03T01:02:03.000Z", reason: "lost_password", keystore_file: `wallet-${OLD_ADDRESS.toLowerCase()}-20261003T010203000Z.json`, has_secret_file: true, replaced_by: ADDRESS, usdc_balance: "0.52" },
    { address: ADDRESS, retired_at: "2026-10-02T01:02:03.000Z", reason: "suspected_leak", keystore_file: "wallet-b.json", has_secret_file: false, replaced_by: OLD_ADDRESS, usdc_balance: null },
  ];

  it("shows each old address with its live balance, the file and how to recover the funds", () => {
    const html = render(h(RetiredWalletsList, { rows }));
    assert.ok(html.includes(OLD_ADDRESS) && html.includes(ADDRESS));
    assert.ok(html.includes("0.52 USDC"));
    assert.ok(html.includes(esc(L.en.retiredUnknown)), "an unreadable balance is 'unknown'");
    assert.ok(html.includes(esc(L.en.reason_lost_password)) && html.includes(esc(L.en.reason_suspected_leak)));
    assert.ok(html.includes(`retired/wallet-${OLD_ADDRESS.toLowerCase()}-20261003T010203000Z.json`));
    assert.ok(html.includes(esc(L.en.retiredHint)));
    assert.ok(html.includes("MetaMask"));
  });

  it("empty, loading and failed states", () => {
    assert.ok(render(h(RetiredWalletsList, { rows: [] })).includes(esc(L.en.retiredEmpty)));
    assert.ok(render(h(RetiredWalletsList, { rows: null })).includes(esc(L.en.working)));
    assert.ok(render(h(RetiredWalletsList, { rows: null, error: true })).includes(esc(L.en.retiredLoadFailed)));
  });

  it("Chinese", () => {
    assert.ok(render(h(RetiredWalletsList, { rows }), "zh").includes(L.zh.retiredHint));
  });
});

describe("m6: the health card names the reason each unlock source failed", () => {
  const SECRET_REASONS = [
    ["secret_missing", "hSecretMissing"],
    ["secret_empty", "hSecretEmpty"],
    ["secret_unreadable", "hSecretUnreadable"],
    ["secret_wrong", "hSecretWrong"],
  ] as const;

  for (const [reason, key] of SECRET_REASONS) {
    it(`auto wallet, ${reason}: red, in its own words and in nobody else's`, () => {
      const html = render(h(WalletHealthCard, { wallet: wallet({}, { auto_unlock_ok: false, unlock_sources: [{ source: "auto", ok: false, reason }] }) }));
      assert.ok(html.includes(esc(L.en[key])));
      for (const [, other] of SECRET_REASONS) if (other !== key) assert.ok(!html.includes(esc(L.en[other])), other);
      assert.ok(!html.includes(esc(L.en.hEnvStale)) && !html.includes(esc(L.en.hEnvBroken)), "an env password is not blamed");
      assert.match(html, /data-health="unlock"><div class="wallet-health-head"><span class="wallet-health-label">[^<]*<\/span><span class="pill pill-red">/);
    });
  }

  it("a stale env password and a wrong secret are two findings: the secret's reason plus a separate note about the password", () => {
    const sources = [
      { source: "env_or_file", ok: false, reason: "env_wrong" },
      { source: "auto", ok: false, reason: "secret_wrong" },
    ] as Health["unlock_sources"];
    const html = render(h(WalletHealthCard, { wallet: wallet({}, { auto_unlock_ok: false, unlock_sources: sources }) }));
    assert.ok(html.includes(esc(L.en.hSecretWrong)));
    assert.ok(html.includes(esc(L.en.hEnvStale)));
    assert.ok(!html.includes(esc(L.en.hEnvBroken)), "the env password is not the headline");
  });

  it("a stale env password next to a secret that works: still green, with the note", () => {
    const sources = [
      { source: "env_or_file", ok: false, reason: "env_wrong" },
      { source: "auto", ok: true },
    ] as Health["unlock_sources"];
    const html = render(h(WalletHealthCard, { wallet: wallet({}, { auto_unlock_ok: true, unlock_sources: sources }) }));
    assert.ok(html.includes(esc(L.en.hAutoOk)));
    assert.ok(html.includes(esc(L.en.hEnvStale)));
    assert.match(html, /data-health="unlock"><div class="wallet-health-head"><span class="wallet-health-label">[^<]*<\/span><span class="pill pill-green">/);
  });

  it("the secret file gone while the wallet is open: red 'broken soon', before the restart that would lock it", () => {
    const html = render(h(WalletHealthCard, { wallet: wallet({}, { auto_unlock_ok: true, secret_file_present: false }) }));
    assert.ok(html.includes(esc(L.en.hSecretGone)));
    assert.match(html, /data-health="unlock"><div class="wallet-health-head"><span class="wallet-health-label">[^<]*<\/span><span class="pill pill-red">/);
    assert.deepEqual(walletBannerKinds(wallet({}, { auto_unlock_ok: true, secret_file_present: false })), ["autoBroken"]);
  });

  it("a legacy password that fails is still described as the env password", () => {
    const html = render(h(WalletHealthCard, { wallet: wallet({}, { ...manualHealth, unlock_mode: "env_or_file", auto_unlock_ok: false, unlock_sources: [{ source: "env_or_file", ok: false, reason: "env_wrong" }] }) }));
    assert.ok(html.includes(esc(L.en.hEnvBroken)));
  });

  it("a LOCKED auto wallet has no password to ask for: no unlock form, the reason and the way out instead", () => {
    const w = wallet({ unlocked: false }, { auto_unlock_ok: false, unlock_sources: [{ source: "auto", ok: false, reason: "secret_missing" }] });
    const html = render(h(WalletAccess, { wallet: w, onChanged: noop }));
    assert.ok(html.includes('data-testid="auto-locked"'));
    assert.ok(html.includes(esc(L.en.hSecretMissing)));
    assert.ok(html.includes(esc(L.en.autoLockedBody)));
    assert.ok(!html.includes('type="password"') && !html.includes("wallet.unlock"), "asking for a password that does not exist is a dead end");
    assert.ok(!html.includes(esc(L.en.lockedRecovery)));
    // through the wizard step and the Wallet page as well
    assert.ok(render(h(WalletStep, { wallet: w, refresh: noop })).includes('data-testid="auto-locked"'));
    assert.ok(render(h(WalletView, { wallet: w, meta: null, onChanged: noop })).includes('data-testid="auto-locked"'));
  });

  it("an older server (no recorded protection) that calls it auto is treated the same way", () => {
    const w = wallet({ unlocked: false }, { protection: undefined, auto_unlock_ok: false, unlock_sources: undefined });
    assert.ok(render(h(WalletAccess, { wallet: w, onChanged: noop })).includes('data-testid="auto-locked"'));
  });

  it("the recorded mode decides: a manual wallet whose env password failed still gets the unlock form", () => {
    const html = render(h(WalletAccess, { wallet: wallet({ unlocked: false }, { ...manualHealth, unlock_mode: "env_or_file", auto_unlock_ok: false }), onChanged: noop }));
    assert.ok(html.includes('data-action-id="wallet.unlock"'));
    assert.ok(html.includes(esc(L.en.hEnvBroken)));
  });

  it("Chinese", () => {
    const html = render(h(WalletHealthCard, { wallet: wallet({}, { auto_unlock_ok: false, unlock_sources: [{ source: "auto", ok: false, reason: "secret_missing" }] }) }), "zh");
    assert.ok(html.includes(L.zh.hSecretMissing));
  });
});

describe("M3: the protection of the unlock secret is shown, and a failure is a red warning", () => {
  const exposed: Partial<Health> = { secret_protected: false, secret_protection_detail: "could not set the ACL (access denied)" };

  it("not protected: red pill, the reason, and the hot-wallet advice (the wallet still works)", () => {
    const html = render(h(WalletHealthCard, { wallet: wallet({}, exposed) }));
    assert.match(html, /data-health="protect"><div class="wallet-health-head"><span class="wallet-health-label">[^<]*<\/span><span class="pill pill-red">/);
    assert.ok(html.includes(esc(L.en.hProtectBadTitle)));
    assert.ok(html.includes(fill(L.en.hProtectBad, { detail: "could not set the ACL (access denied)" })));
    assert.ok(html.includes("callout-error"));
    assert.ok(html.includes(esc(L.en.hAutoOk)), "auto-unlock itself is not refused");
  });

  it("protected: a green row", () => {
    const html = render(h(WalletHealthCard, { wallet: wallet() }));
    assert.match(html, /data-health="protect"><div class="wallet-health-head"><span class="wallet-health-label">[^<]*<\/span><span class="pill pill-green">/);
    assert.ok(!html.includes(esc(L.en.hProtectBadTitle)));
  });

  it("a password wallet has no secret on disk: no protection row at all", () => {
    const html = render(h(WalletHealthCard, { wallet: wallet({}, manualHealth) }));
    assert.ok(!html.includes('data-health="protect"'));
  });

  it("an older server that does not report it: no row, no claim", () => {
    const html = render(h(WalletHealthCard, { wallet: wallet({}, { secret_protected: undefined }) }));
    assert.ok(!html.includes('data-health="protect"'));
  });

  it("Overview banner: red, with a link to the Wallet page, listed after 'auto-unlock broken' and before 'backup'", () => {
    const html = render(h(WalletBanners, { wallet: wallet({}, { ...exposed, backup: "missing" }) }));
    assert.ok(html.includes(esc(L.en.bannerSecretUnprotected)));
    assert.ok(html.includes(esc(L.en.bannerProtectAction)));
    assert.ok(html.indexOf(esc(L.en.bannerSecretUnprotected)) < html.indexOf(esc(L.en.bannerBackupMissing)));
    assert.deepEqual(walletBannerKinds(wallet({}, { ...exposed, backup: "missing", auto_unlock_ok: false })), ["autoBroken", "secretUnprotected", "backupMissing"]);
    assert.deepEqual(walletBannerKinds(wallet({}, exposed), true), [], "none in the offline demo");
    assert.deepEqual(walletBannerKinds(wallet({}, { secret_protected: true })), []);
    assert.deepEqual(walletBannerKinds(wallet({}, { secret_protected: null })), []);
  });

  it("the danger zone opens by itself when the secret is exposed", () => {
    assert.match(render(h(WalletDangerZone, { wallet: wallet({}, exposed), onChanged: noop })), /<details open="">/);
  });

  it("Chinese", () => {
    assert.ok(render(h(WalletBanners, { wallet: wallet({}, exposed) }), "zh").includes(L.zh.bannerSecretUnprotected));
    assert.ok(render(h(WalletHealthCard, { wallet: wallet({}, exposed) }), "zh").includes(L.zh.hProtectBadTitle));
  });
});

describe("M1: wallet.json is missing but credentials of an earlier wallet remain", () => {
  const orphans = { secrets: [OLD_ADDRESS], retired: 2, wallet_file_missing: true };

  it("the set-up screen says so before offering anything, and Create / Import wait for an explicit yes", () => {
    const html = render(h(WalletSetup, { onDone: noop, orphans }));
    assert.ok(html.includes('data-testid="orphan-warning"'));
    assert.ok(html.includes(esc(L.en.orphanTitle)));
    assert.ok(html.includes(fill(L.en.orphanBody, { secrets: 1, retired: 2 })));
    assert.ok(html.includes(esc(L.en.orphanAck)));
    assert.match(html, /<button type="button" class="btn" data-action-id="wallet\.create" disabled="">/);
    assert.match(html, /<button class="btn secondary" type="submit" disabled="">/);
  });

  it("a clean data folder gets no warning and an enabled Create button", () => {
    for (const o of [undefined, { secrets: [], retired: 0, wallet_file_missing: false }, { secrets: [OLD_ADDRESS], retired: 0, wallet_file_missing: false }]) {
      const html = render(h(WalletSetup, { onDone: noop, orphans: o }));
      assert.ok(!html.includes('data-testid="orphan-warning"'));
      assert.match(html, /<button type="button" class="btn" data-action-id="wallet\.create">/);
    }
  });

  it("the Wallet page and the wizard step pass the server's finding on", () => {
    const w: Wallet = { ...noWallet(), health: health({ ...noWallet().health, orphan_files: orphans }) };
    assert.ok(render(h(WalletView, { wallet: w, meta: null, onChanged: noop })).includes('data-testid="orphan-warning"'));
    assert.ok(render(h(WalletStep, { wallet: w, refresh: noop })).includes('data-testid="orphan-warning"'));
  });

  it("Chinese", () => {
    assert.ok(render(h(WalletSetup, { onDone: noop, orphans }), "zh").includes(L.zh.orphanTitle));
  });
});

describe("M2: the import screens say what may be imported and what is kept", () => {
  it("set-up: the warning stands above the import fields, with the optional expected address", () => {
    const html = render(h(WalletSetup, { onDone: noop }));
    assert.ok(html.includes('data-testid="import-warning"'));
    assert.ok(html.includes(esc(L.en.importWarnTitle)));
    assert.ok(html.includes(esc(L.en.importWarnBody)));
    assert.ok(html.indexOf(esc(L.en.importWarnBody)) < html.indexOf('id="wallet-import-phrase"'), "before the fields, not after");
    assert.ok(html.includes('id="wallet-import-expected"'));
    assert.ok(html.includes(esc(L.en.expectedAddressHint)));
    assert.ok(html.includes(esc(L.en.phraseInputHint)));
  });

  it("the warning says the two things that matter: nothing else may share the funds, and only the key is kept", () => {
    assert.match(L.en.importWarnBody, /Never import/);
    assert.match(L.en.importWarnBody, /other funds/);
    assert.match(L.en.importWarnBody, /dedicated small-float wallet/);
    assert.match(L.en.importWarnBody, /phrase is not/);
    assert.match(L.zh.importWarnBody, /绝不要导入/);
  });

  it("replace with a recovery phrase or a private key: the same warning and field; replace with a new wallet: neither", () => {
    for (const initialWith of ["mnemonic", "private_key"] as const) {
      const html = render(h(ReplaceSection, { wallet: wallet(), onChanged: noop, initialWith }));
      assert.ok(html.includes('data-testid="import-warning"'), initialWith);
      assert.ok(html.includes('id="replace-expected"'), initialWith);
    }
    const create = render(h(ReplaceSection, { wallet: wallet(), onChanged: noop }));
    assert.ok(!create.includes('data-testid="import-warning"') && !create.includes('id="replace-expected"'));
  });

  it("Chinese", () => {
    assert.ok(render(h(WalletSetup, { onDone: noop }), "zh").includes(L.zh.importWarnTitle));
  });
});

describe("m8: the top-bar wallet chip shows no address until the backup is confirmed", () => {
  const chip = (w: Wallet | null, lang: "en" | "zh" = "en", loading = false) => render(h(WalletChip, { wallet: w, loading }), lang);

  it("confirmed backup: the short address and a Copy button", () => {
    const html = chip(wallet());
    assert.ok(html.includes("0xf39F...2266"));
    assert.ok(html.includes("chip-copy"));
  });

  it("backup missing: no address (short or full), no Copy button, a link to the backup instead", () => {
    const html = chip(wallet({}, { backup: "missing" }));
    assert.ok(!html.includes("0xf39F") && !html.includes(ADDRESS) && !html.includes("2266"), "no part of the address");
    assert.ok(!html.includes("chip-copy"), "no Copy button");
    assert.ok(html.includes('data-testid="wallet-chip-backup"') && html.includes('href="/wallet"'));
    assert.ok(html.includes(esc(L.en.chipBackupFirst)));
  });

  it("a wallet with nothing to back up (imported) still shows its address", () => {
    assert.ok(chip(wallet({}, { backup: "not_applicable" })).includes("0xf39F...2266"));
  });

  it("an older server (no health) behaves as before", () => {
    assert.ok(chip(wallet({}, null)).includes("0xf39F...2266"));
  });

  it("locked, no wallet and loading are unchanged and show no address", () => {
    assert.ok(!chip(wallet({ unlocked: false })).includes("0xf39F"));
    assert.ok(chip(noWallet()).includes('href="/wallet"'));
    assert.ok(chip(null, "en", true).includes("wallet-chip dim"));
  });

  it("Chinese", () => {
    assert.ok(chip(wallet({}, { backup: "missing" }), "zh").includes(L.zh.chipBackupFirst));
  });
});

describe("m9: a fresh recovery phrase belongs to one wallet and is shown only for it", () => {
  it("it is remembered together with the address, and only handed out for that address (any letter case)", () => {
    freshPhrase.set(ADDRESS, PHRASE);
    assert.deepEqual(freshPhrase.get(), { address: ADDRESS, phrase: PHRASE });
    assert.equal(freshPhrase.getFor(ADDRESS), PHRASE);
    assert.equal(freshPhrase.getFor(ADDRESS.toLowerCase()), PHRASE);
    assert.equal(freshPhrase.getFor(OLD_ADDRESS), null);
  });

  it("the backup flow of the wallet it was made for shows the words", () => {
    freshPhrase.set(ADDRESS, PHRASE);
    const html = render(h(BackupFlow, { onConfirmed: noop, address: ADDRESS }));
    assert.equal((html.match(/class="wallet-phrase-index"/g) ?? []).length, 12);
  });

  it("the backup flow of ANOTHER wallet never shows it", () => {
    freshPhrase.set(OLD_ADDRESS, PHRASE);
    const html = render(h(BackupFlow, { onConfirmed: noop, address: ADDRESS }));
    assert.ok(!html.includes("wallet-phrase-index"), "no words");
    assert.ok(!html.includes(">junk<"));
    assert.ok(html.includes('data-action-id="wallet.reveal"'), "it offers to reveal this wallet's own phrase instead");
  });

  it("the set-up screen right after 'Create' (no wallet known yet) shows the phrase the server just returned", () => {
    freshPhrase.set(ADDRESS, PHRASE);
    const html = render(h(WalletSetup, { onDone: noop }));
    assert.equal((html.match(/class="wallet-phrase-index"/g) ?? []).length, 12);
  });

  it("without a fresh phrase the page asks for one click, never for the address it must not display", () => {
    const html = render(h(BackupFlow, { onConfirmed: noop, address: ADDRESS }));
    assert.ok(html.includes(esc(L.en.revealNowBody)));
    assert.ok(html.includes(esc(L.en.showPhraseButton)));
    assert.ok(!html.includes('id="wallet-reveal-address"'), "no typed-address field");
    assert.ok(!html.includes(ADDRESS), "and the address is nowhere on the page");
  });

  it("the Wallet page with an unfinished backup shows the address nowhere, yet can still reveal the phrase", () => {
    const html = render(h(WalletView, { wallet: wallet({}, { backup: "missing" }), meta: null, onChanged: noop }));
    assert.ok(!html.includes(ADDRESS) && !html.includes("0xf39F"));
    assert.ok(html.includes('data-action-id="wallet.reveal"'));
  });
});

describe("wording: nothing promises what the server no longer does", () => {
  it("no string mentions a wallet.json.bak copy, the single-name secret file or the 0600 mode", () => {
    for (const lang of ["en", "zh"] as const) {
      for (const [key, value] of Object.entries(L[lang])) {
        assert.ok(!/\.bak/.test(value), `${lang}.${key} mentions a .bak copy`);
        assert.ok(!/wallet-unlock\.secret/.test(value), `${lang}.${key} names the old single secret file`);
        assert.ok(!/0600/.test(value), `${lang}.${key} claims a file mode`);
      }
    }
  });
});

describe("strings", () => {
  it("every English wallet-lifecycle string has a Chinese one, and the other way round", () => {
    assert.deepEqual(Object.keys(L.en).sort(), Object.keys(L.zh).sort());
    for (const [key, value] of Object.entries(L.zh)) assert.ok(value.trim().length > 0, key);
  });

  it("the API client keeps the typed surface the pages use", async () => {
    const api: Api = await import("../src/api.ts");
    for (const name of ["createWallet", "importWallet", "backupWallet", "confirmBackup", "revealWallet", "setAutoUnlock", "replaceWallet", "listRetiredWallets", "unlockWallet", "getWallet"] as const) {
      assert.equal(typeof api[name], "function", name);
    }
  });
});
