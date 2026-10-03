# Wallet: create, unlock, replace, recover

The product is described in [SPEC.md](../SPEC.md); this page is the detail behind SPEC §1 (the wallet) and §5 (the safety floor).

## The model in one minute

The server wallet is a small **float**: the money your AI can spend right now, not a savings account.

- **The server creates it** (Wallet page, "Create wallet"). There is no password to choose or remember: the server keeps a random 256-bit *unlock secret* next to the wallet file and opens the wallet by itself after every restart.
- **The 12 recovery words are shown once**, when the wallet is created. Write them down and tick "I wrote all 12 words down". Any BIP-39 wallet (MetaMask, OKX Wallet, ...) shows the same address from those words.
- **A lost or unusable wallet is never the end.** *Replace wallet* moves the old files to `retired/` (never deleted) and starts a new wallet; keys, limits, approvals and bills stay. If you did not write the words down, replace the wallet to get new ones: you lose nothing while it is unfunded.
- **There is no import.** Importing a phrase or private key would put the key of your main wallet on this server. SPEC §5.
- **Wallets made by an older version with a password** still work: they are unlocked at startup by `MONEYSWITCH_WALLET_PASSWORD` or `MONEYSWITCH_WALLET_PASSWORD_FILE`. The Dashboard has no password form. If that password is lost, replace the wallet.

### What auto-unlock really means

`wallet.json` is encrypted, but the key that decrypts it is the unlock secret, a file named `wallet-unlock-<address>.secret` in the same data folder. **Whoever can read the data folder can spend the wallet.** That includes a copy of the folder in a backup, a disk snapshot, or an AI agent running as the same operating-system user on the same machine.

- **The server locks the folder down to its own account and checks that it worked.**
  - Windows: a *protected* ACL (inheritance removed) with exactly two allow entries, the account the server runs as and SYSTEM, set on the data folder and on the secret and read back to verify. (A mode such as `0600` means nothing on Windows: a file inherits the folder's permissions, which usually let other local accounts read it.)
  - Linux: the folder `0700` and the secret `0600`, verified.
  - It is re-applied at every start, so a loosened folder is repaired.
  - If it cannot be applied or verified (a network drive, a mount that ignores permissions, no PowerShell) the server still runs, but the Wallet page shows a red row, `health.secret_protected` is `false` with the reason, and a warning is logged. Treat such a wallet as readable by everyone on the machine and keep the float tiny.
  - This protects against *other accounts*. It does nothing against the same account.
- Keep the float small. The Wallet page shows each chain's balance against a **float limit** (`MONEYSWITCH_WALLET_FLOAT_LIMIT`, default `50` USDC) and warns above it. Move the rest to a wallet you control.
- Do not run the AI on the server, or as the same system user. The AI gets a MoneyKey and calls the API remotely.
- Protect the data folder and its backups like a private key. A backup of `/data` *is* a copy of the key.

## Create

Dashboard, Wallet page:

1. **Create wallet.** One click. The 12 words appear with a warning; the address is not shown yet. Tick "I wrote all 12 words down" and the page shows the address and the balance on every enabled chain. If you reload before ticking, the words cannot be shown again: replace the wallet.
2. Fund the address. On a testnet the page links to the USDC faucet. No gas token is needed on Monad (the facilitator pays the gas).

If `wallet.json` is missing but credential files of an earlier wallet are still in the data folder (an unlock secret, or files in `retired/`), the page says so and asks for an explicit acknowledgement before creating a new wallet. The usual cause is a data folder mounted from the wrong place. Creating a wallet never touches those files and never overwrites an existing wallet, including concurrent attempts.

## The recovery phrase

- Standard BIP-39 (English), derivation path `m/44'/60'/0'/0/0`. The tests derive the address from the words with an independent BIP-32/BIP-44 implementation, so the address in MetaMask or OKX is the address MoneySwitch shows.
- It is returned **once**, by `POST /v1/admin/wallet/create` (and by `replace`): administrator only, `Cache-Control: no-store`. It is stored only inside the encrypted keystore, never in the database, the audit log or any log, and **no route shows it again**. The Dashboard keeps a just-created phrase in memory only, with the address it belongs to.
- "I wrote them down" is `POST /v1/admin/wallet/backup/confirm` (no body); it records `backup_confirmed_at`.

## What happens at startup

1. `MONEYSWITCH_WALLET_PASSWORD`, or the contents of `MONEYSWITCH_WALLET_PASSWORD_FILE`, if **non-empty**. An empty variable, an empty or blank file and an unreadable file all count as "not configured" (a warning is logged), so the empty placeholder file the Docker deployment mounts is harmless. This only matters for wallets made by an older version with a password.
2. Otherwise the wallet's own unlock secret.
3. Otherwise the wallet stays locked, every payment fails with `WALLET_LOCKED` (`charged: no`), and the Wallet page says why.

Which mode a wallet is in is **recorded in `wallet.json`** (a small non-secret `x-moneyswitch` field, ignored by every other wallet app), not guessed from which files are lying around. A keystore without the field is a password keystore.

Every source that was tried is reported **with its own reason**, in the log (never with the credential), on the Wallet page and in `health.unlock_sources`: `env_wrong`, `secret_missing`, `secret_empty`, `secret_unreadable`, `secret_wrong`. A failing source does not stop the next one. Before the server serves a request it also tidies up after a crash: stale temporary files are removed, and unlock secrets that belong to no live wallet are moved to `retired/` (never deleted).

That tidying can be wrong for a while: if `wallet.json` temporarily belongs to another key (a wrong mount, a restore of the wrong file), the right wallet's secret is "an orphan" and is moved to `retired/orphan-wallet-unlock-<address>-<timestamp>.secret`. When the right `wallet.json` is back, the startup tries the orphans **of its own address** (newest first) and moves back the first one that really opens it. If nothing fits, the log names the exact `retired/` files that were put aside.

For a wallet made by an older version with a password, the startup does one more thing once the password has opened it: every `.secret` in `retired/` that still opens a retired copy of the *same* key (the key was replaced out and back in) is removed, so that nothing on disk opens the key without the password. This is the only place MoneySwitch deletes a credential: only inside `retired/`, only after the password proved the live wallet reachable, written to the audit log as `wallet.retired_secrets_removed` with the trigger `startup_password`. Whatever could not be removed is listed in `health.retired_secrets_open_live_key` and shown on the Wallet page.

## Replace wallet

Use it when the wallet will not unlock (a lost password or unlock file), when you suspect the key leaked, or when you never wrote the words down. It works on a locked wallet and never needs a password: it only moves files.

Wallet page, danger zone: type the **current address** exactly, pick a reason, confirm. Move any money you want to keep out of the old wallet first: after the swap this server no longer signs for it.

`POST /v1/admin/wallet/replace` with `confirm_address` (the current address) and an optional `reason` (a short token such as `lost_password` or `suspected_leak`; default `replaced`). The answer carries the new address and its 12 words, once.

- **It waits for payments in flight, refuses new ones meanwhile, and gives up after 60 s with `409 WALLET_BUSY`.** A request takes a lease on the signer only when a payment is about to be created and gives it back when the call ends, however it ends; a free resource, or a 402 that is never paid, holds nothing. While a replace is waiting, no new lease is handed out: a request that reaches the point of paying meanwhile is answered `WALLET_BUSY` with `charged: "no"`, with nothing reserved or signed, and can simply be retried. So steady traffic cannot starve a replace. If payments are still in flight after 60 s, the answer is `409 WALLET_BUSY` and nothing is changed. The count is in-process, not a database query. As a second line of defence a signer checks, when it is asked to sign, that its wallet is still the live one; if the wallet was replaced after the request started, **nothing is signed**, the reservation is released and the caller gets `WALLET_LOCKED` with `charged: "no"`.
- The old `wallet.json` (and its unlock secret) are first **copied** into `<data folder>/retired/` under names containing the old address and a timestamp, and compared; only then are the new files renamed *over* the live names, so `wallet.json` is never absent, not even for an instant, and a crash at any step leaves a pair that opens. Nothing is deleted. The retirement (address, time, reason, file names) is recorded in the database and in the audit log; if recording fails, the swap is undone.
- MoneyKeys, limits, approvals and bills are untouched. Reconciliation of older unknown payments keeps working: it uses the sender address stored on each payment, not the current wallet.
- Funds in the old wallet stay at the old address. The Wallet page lists every replaced wallet with its **live USDC balance** on each enabled chain.

### Getting money out of a replaced wallet

1. **You kept its 12 words** (the ones shown at creation): import them into any BIP-39 wallet, such as MetaMask. The address is the old one.
2. **You did not.** An auto-unlock wallet's `retired/` copy is a standard Ethereum "Web3 Secret Storage v3" file, and its password is the text inside the matching unlock-secret file. In `<data folder>/retired/` find the pair for the old address:
   - `wallet-<address>-<timestamp>.json` (the keystore)
   - `wallet-unlock-<address>-<timestamp>.secret` (64 hexadecimal characters, no newline)

   In MetaMask: account menu, *Import account*, type *JSON File*, choose the keystore file, and paste the **exact text of the `.secret` file** as the password. Then move the funds to an address you control and delete your copies of both files (they are a private key).

   *How well this is verified:* `packages/wallet/test/v3-compat.test.ts` opens exactly such a retired pair with an independent reader written from the V3 specification (scrypt, aes-128-ctr, keccak MAC), including the lower-casing of the whole file that MetaMask's reader does, and recovers the old private key; it also checks that the new wallet's secret does not open the old file. **MetaMask itself was not run**, and its menus change between versions: if the import is refused, any tool that reads V3 keystores (for example ethers `Wallet.fromEncryptedJson`) does the same job.
3. **A password wallet from an older version:** the same file, with its password. If the password is also lost, nothing can open it: that is why the words matter.

## Payments interrupted by a restart

A payment is *reserved* in the database before it is signed. If the process dies in the middle, nothing would ever settle or release that reservation. So **before the server accepts requests**, every payment still `reserved` from an earlier run is resolved:

- a signed authorization had been recorded: the money may have moved, so it becomes `unknown` and stays counted until the on-chain reconcile has checked it;
- nothing had been signed: it becomes `failed` (`RESTARTED_BEFORE_SIGNING`) and the budget is released.

Both are written to the audit log (`payment.startup_sweep.*`). This reads "no authorization recorded" as "nothing was signed", which is only true because MoneySwitch pays **with EIP-3009 only** (`transferWithAuthorization`). A seller whose requirement says `extra.assetTransferMethod: "permit2"` (anything but absent or `"eip3009"`) is refused before anything is reserved or signed: `status: "denied"`, `code: "UNSUPPORTED_PAYMENT"`, `charged: "no"`. A seller that offers both is paid with its EIP-3009 option.

## Health

`GET /v1/admin/wallet` returns the address, `unlocked`, `has_keystore`, `has_recovery_phrase`, `backup_confirmed_at`, the balance on every enabled chain (`networks`), the replaced wallets (`retired_wallets`) and `health`:

| Field | Meaning |
| --- | --- |
| `protection` | how `wallet.json` is protected, as recorded in it: `auto`, `password` (an older wallet) or `none` (no wallet) |
| `unlock_mode` | `auto` (secret file), `env_or_file` (startup password), `manual` (locked password wallet) or `none` |
| `auto_unlock_ok` | result of the last real decrypt attempt: `true`, `false` or `null` |
| `unlock_sources` | each source tried at startup: `{ source: "env_or_file" \| "auto", ok, reason? }` |
| `secret_file_present` | auto wallets: does the secret file exist *now* (`false` = the next restart leaves the wallet locked) |
| `secret_protected` | `true` / `false` (red warning) / `null` (nothing to protect); `secret_protection_detail` says why not |
| `orphan_files` | `{ secrets, retired, wallet_file_missing }`: credential files that belong to no live wallet |
| `retired_secrets_open_live_key` | password wallets: files in `retired/` whose unlock secret still opens the live key |
| `backup` | `confirmed`, `missing` or `not_applicable` |
| `float_limit` / `over_float_limit` | `MONEYSWITCH_WALLET_FLOAT_LIMIT` in USDC, and per chain whether the balance is above it |

## Administrator API

Four routes, administrator only (a MoneyKey gets 403). Responses that carry a secret are `Cache-Control: no-store`.

| Action | Route | JSON body |
| --- | --- | --- |
| Status and health | `GET /v1/admin/wallet` | none |
| Create | `POST /v1/admin/wallet/create` | none. Returns `recovery_phrase` once. Asking for a password or an import is refused (`400 UNSUPPORTED`) |
| "I wrote the words down" | `POST /v1/admin/wallet/backup/confirm` | none |
| Replace | `POST /v1/admin/wallet/replace` | `confirm_address`, optional `reason`. Returns the new `recovery_phrase` once |

## Files in the data folder

| File | What it is |
| --- | --- |
| `wallet.json` | the encrypted keystore (a generated wallet also carries its encrypted recovery phrase) |
| `wallet-unlock-<address>.secret` | the unlock secret **of that wallet** (the name carries the address, so it can never be mistaken for, or overwrite, another key's); absent for an older password wallet |
| `retired/` | everything that was replaced or left over, never deleted: `wallet-<address>-<timestamp>.json`, `wallet-unlock-<address>-<timestamp>.secret`, `orphan-wallet-unlock-<address>-<timestamp>.secret` |

Treat every file here as a private key; `retired/` holds the credentials of the old wallets and is as sensitive as the live ones.

**Back this folder up as the account that owns it, and check the archive.** The folder is `0700` and its files `0600`, owned by the server's `node` account; the container runs with `cap_drop: ALL`, so **root there cannot read it**: a `tar` run with `--user root` prints "Permission denied" and still writes an archive that lacks `wallet.json` and the unlock secret. Use the command in `deploy/README.zh-CN.md` and then `sh deploy/check-backup.sh <archive.tgz>`, which only lists the archive and exits 1 unless `wallet.json` is inside and, for an auto-unlock wallet, the `wallet-unlock-<address>.secret` of **that** address.

## If something goes wrong

| Situation | What to do |
| --- | --- |
| The Wallet page says the wallet is locked (`secret_missing`, `secret_wrong`, ...) | It names the reason. Restore the unlock file from a backup of the data folder and restart; otherwise *Replace wallet* |
| Locked, and the wallet was made by an older version with a password | Set `MONEYSWITCH_WALLET_PASSWORD` (or `_FILE`) on the server and restart. If the password is lost: *Replace wallet*, then recover the old funds as described above |
| `wallet.json` is missing but the page shows credential files | The data folder is probably mounted from the wrong place. Fix that first; do not create a new wallet over it unless you mean to |
| The page says the unlock file is not protected | Fix the folder permissions (or move the data folder to a local disk the server's account owns), restart, and check that the warning is gone. Meanwhile keep only a tiny float |
| `409 WALLET_BUSY` on replace | Payments were still in flight after 60 s. Nothing was changed; try again |
| `WALLET_BUSY` on a payment (`charged: "no"`) | A replacement is waiting for the payments in flight; nothing was signed or charged. Retry in a moment |
| The server (or its disk) is gone | Create a new instance and create a wallet; if you kept the 12 words, move the old funds with them in a wallet app |
| You think the key leaked | Move the funds out with a wallet app using the words (or the retired file, above), then *Replace wallet* with the reason "exposed" |
| You never wrote the words down | *Replace wallet* gives you a new set. No loss while the old wallet is unfunded; otherwise use the retired file, above |
