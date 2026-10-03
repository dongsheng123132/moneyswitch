# Wallet setup and recovery

## The model in one minute

The server wallet is a small **float**: the money your agents can spend right now, not a savings account.
Nobody should have to remember a password for it, and nobody should lose it by forgetting one. So:

- **No password to remember (the default).** The server keeps a random 256-bit *unlock secret* next to the wallet file
  and opens the wallet by itself after every restart.
- **The backup is a standard 12-word recovery phrase.** Importing those words into MetaMask, OKX Wallet or any
  BIP-39 wallet shows the same address. The phrase is written down once, on paper, and checked in the Dashboard.
- **A lost password is never the end.** If a wallet cannot be opened, *Replace wallet* retires its files (they are
  moved, never deleted) and starts a new one; keys, budgets, approvals and history stay.

### What auto-unlock really means

`wallet.json` is encrypted, but the key that decrypts it is the unlock secret, a file named
`wallet-unlock-<address>.secret` in the same data folder. **Whoever can read the data folder can spend the wallet.**
That includes a copy of the folder in a backup, a disk snapshot, or an AI agent running as the same operating-system
user on the same machine.

- **The server locks the folder down to its own account, and checks that it worked.**
  - Windows: a *protected* ACL (inheritance removed) with exactly two allow entries, the account the server runs as and
    SYSTEM, set on the data folder and on the secret and read back to verify. (A file mode such as `0600` means nothing
    on Windows: a file just inherits the folder's permissions, which usually let other local accounts read it.)
  - Linux/macOS: the folder `0700` and the secret `0600`, verified.
  - It is re-applied at every start, so a loosened folder is repaired.
  - If it cannot be applied or verified (a network drive, a mounted volume that ignores permissions, no PowerShell) the
    server does **not** refuse to run: the Wallet page shows a red *Unlock secret protection* row,
    `health.secret_protected` is `false` with the reason, and the Overview shows a red banner. Treat that wallet as
    readable by everyone on the machine and keep the float tiny.
  - This protects against *other accounts*. It does nothing against the same account (see above).
- Keep the float small. The Wallet page shows the balance against a **float limit** (`MONEYSWITCH_WALLET_FLOAT_LIMIT`,
  default `50` USDC) and warns when it is exceeded. Move the rest to a wallet you control.
- Run team deployments on a **separate server** and keep agents off it; agents get a MoneyKey and call the API remotely.
- Protect the data folder and its backups like a private key. A backup of `/data` *is* a copy of the key.
- If that is not acceptable for your deployment, choose the password mode (*Advanced: ask for a password on every
  restart* when setting up, or *Turn off auto-unlock* later). Nothing is stored then, but the wallet stays locked after
  every restart until someone enters the password, and a lost password means *Replace wallet*.

An existing wallet keeps whatever mode it has; an upgrade never switches a wallet to auto-unlock by itself.

## Setting up (Dashboard)

The setup guide and the Wallet page offer the same options:

1. **Create wallet (recommended).** One click, no password field. The 12 words are shown with a warning; you type
   two of them (positions chosen at random) to prove you wrote them down. Until that check passes the wallet's address
   is shown **nowhere**: not on the Wallet page, not in the setup guide, not in the chip at the top right (which then
   says *Finish the wallet backup*), and there is no QR code or funding steps. A banner on the Overview reminds you.
   If you reload the page before finishing, *Show my recovery phrase* shows the words again with one click.
2. **Import** an existing wallet instead (only into an empty instance), with this in mind:

   > **Never import a recovery phrase or private key that also controls other funds.** This server keeps the key on its
   > own disk, so the wallet it uses must be a **dedicated small-float wallet** made for AI payments, nothing else.

   - **Recovery phrase**: 12 or 24 English words, account 1 (`m/44'/60'/0'/0/0`). No BIP-39 passphrase ("25th word").
   - **Private key**: a dedicated payment wallet. The server validates and encrypts it; it is never returned or logged.
   - **Encrypted keystore** (Ethereum V3 JSON) with its original password; the address stays the same.

   **Whatever you import, only the private key of that one account is stored.** The server does not keep the phrase (or a
   keystore's seed, or a non-default derivation path) because a phrase can control many accounts and must not live on a
   hot server. So an imported wallet has no phrase to confirm and counts as backed up (you brought the credential);
   *Reveal* shows the key, not words. Keep your own copy of the phrase.

   Optionally fill in **the address you expect**: the import is refused (`EXPECTED_ADDRESS_MISMATCH`, nothing stored)
   unless the key belongs to exactly that address. It catches a mistyped phrase, a wrong account, or a different keystore
   before anything is written.
3. **Advanced: ask for a password on every restart.** Adds a password (8+ characters) to either path above. No secret
   file is written.

If `wallet.json` is missing but credential files of an earlier wallet are still in the data folder (an unlock secret, or
files in `retired/`), the Dashboard says so before offering *Create* or *Import* and asks for an explicit
acknowledgement. The usual cause is a data folder mounted from the wrong place. Creating a wallet then never touches
those files.

Creation and import never overwrite an existing wallet, including concurrent attempts. To switch wallets use
*Replace wallet* (below).

## The recovery phrase

- Standard BIP-39 (English), derivation path `m/44'/60'/0'/0/0`. The tests derive the address from the words with an
  independent BIP-32/BIP-44 implementation and check published vectors, so the address you see in MetaMask or OKX is
  the address MoneySwitch shows.
- **Only a wallet the server generated has a phrase.** It is returned **once**, by the create (or replace) response:
  admin only, `Cache-Control: no-store`. It is stored only inside the encrypted keystore, never in the database, the
  audit log or any log.
- **Check:** `POST /v1/admin/wallet/backup/confirm` with two 1-based positions and the two words; the server compares
  them and records `backup_confirmed_at`.
- **Reveal later:** Wallet page, *Danger zone*, *Reveal recovery phrase*. You must type the current wallet address
  exactly. The response is `no-store`, the audit log records *that* it happened (never what), and the Dashboard hides
  the words again after a minute. For a wallet you imported, *Reveal* returns the private key.
- The Dashboard keeps a just-created phrase in memory only, together with the address it belongs to, and shows it only
  for that wallet.
- Wallets created by an earlier release with a password also carry the phrase inside their keystore: unlock the
  wallet with its password once, then reveal and confirm it.

## What happens at startup

1. `MONEYSWITCH_WALLET_PASSWORD`, or the contents of `MONEYSWITCH_WALLET_PASSWORD_FILE`, if that is **non-empty**. An empty
   variable, an empty or blank file, and an unreadable file all count as "not configured" (a warning is logged). The
   placeholder file that older Docker deployments mount is therefore harmless.
2. Otherwise the wallet's own unlock secret.
3. Otherwise the wallet stays locked until an administrator unlocks it in the Dashboard.

Which mode a wallet is in is **recorded in `wallet.json`** (a small non-secret `x-moneyswitch` field, ignored by every
other wallet app), not guessed from which files happen to be lying around. A keystore without the field is a password
keystore.

Every source that was tried is reported **with its own reason**, in the log (never with the credential), on the Wallet
page, and in `health.unlock_sources`: `env_wrong`, `secret_missing`, `secret_empty`, `secret_unreadable`,
`secret_wrong`. A failing source does not stop the next one, so a stale password in the environment cannot lock out a
wallet whose secret works, and a wrong secret is never blamed on the environment variable (or the other way round).
Before the server serves a request it also tidies up after a crash: stale temporary files are removed, and unlock secrets
that belong to no live wallet are moved to `retired/`.

A locked **auto-unlock** wallet has no password to type: the Dashboard shows the reason and the way out (restore the
secret file from a backup of the data folder, or *Replace wallet*) instead of a password form.

## Turn auto-unlock on or off

*Wallet → Danger zone → Auto-unlock.*

- **On** needs the wallet unlocked (open it with its password first). The wallet is re-encrypted with a fresh random
  secret and the secret file is written.
- **Off** needs a new password (8+ characters). The wallet is re-encrypted with it and the secret file is removed.
- If the unlock secret is gone or no longer matches the wallet file while the wallet is open, use *Repair* (this is "on"
  again). The Wallet page warns about a missing secret file *before* the restart that would lock the wallet.
- Turning it on while `MONEYSWITCH_WALLET_PASSWORD` is still configured is allowed; the stale variable is logged on every
  start and ignored. Remove it when convenient.

Both directions are crash-safe, and **no copy of the previous keystore stays on disk**: the new keystore is built and
test-decrypted in memory, written to a temporary file next to `wallet.json`, then renamed over it (the old file is never
deleted first); the secret is installed before the swap or removed after it; a failure part-way puts the previous files
back by renaming them over again. Operations on one data folder never overlap. At no point is there a keystore that
nothing can open, and afterwards, when auto-unlock is turned off, **nothing on the server opens the key without the new
password**.

## Replace wallet

Use it when the password is lost, when auto-unlock is broken beyond repair, or when you suspect the key leaked.

`POST /v1/admin/wallet/replace` with `confirm_address` (the current address, exactly) plus the body of *create* or
*import* (with the same optional `expected_address`):

- Refused with **409 `WALLET_BUSY`** while any request holds the wallet's signer, i.e. while a `/v1/fetch` or chat
  payment is in flight (a few seconds to a few minutes). This is an in-process counter, not a database query: a request
  takes a lease just before it can sign and gives it back when it finishes, however it ends. Locking the wallet is
  refused the same way. As a second line of defence a signer checks, when it is asked to sign, that the wallet it came
  from is still the live one; if the wallet was replaced after the request started, **nothing is signed**, the
  reservation is released and the caller gets `WALLET_LOCKED` with `charged: "no"`.
- The old `wallet.json` (and its secret, if there is one) are first **copied** into `<data folder>/retired/`, under names
  containing the old address and a timestamp, and compared; only then are the new files renamed *over* the live names, so
  `wallet.json` is never absent, not even for an instant. Nothing is ever deleted. The retirement (address, time, reason,
  file names) is recorded in the database and an audit row is written; if recording it fails, the swap is undone.
- The new wallet is created or imported with auto-unlock by default; the phrase of a new wallet is returned once.
- MoneyKeys, budgets, approvals, payment history and notification settings are untouched. On-chain reconciliation of
  older unknown payments keeps working: it uses the sender address stored on each payment, not the current wallet.
- Funds in the old wallet stay at the old address. The Wallet page lists every retired wallet with its **live USDC
  balance**. To recover them, import the old recovery phrase into MetaMask/OKX, or import the file from `retired/` with
  its original password.

## Payments interrupted by a restart

A payment is *reserved* in the database before it is signed. If the process dies in the middle, nothing would ever
settle or release that reservation, and it would count against the key's budget forever. So **before the server accepts
requests**, every payment still `reserved` from an earlier run is resolved:

- a signed authorization had been recorded (`auth_*`): the money may have moved, so it becomes `unknown` and stays counted
  until the on-chain reconcile has checked it;
- nothing had been signed: it becomes `failed` (`RESTARTED_BEFORE_SIGNING`) and the budget is released.

Both are written to the audit log (`payment.startup_sweep.*`).

## Health

`GET /v1/admin/wallet` keeps its earlier fields and adds `health`:

| Field | Meaning |
| --- | --- |
| `protection` | how `wallet.json` is protected, as recorded in it: `auto`, `password`, or `none` (no wallet) |
| `unlock_mode` | `auto` (secret file), `env_or_file` (startup password), `manual`, or `none` (no wallet) |
| `auto_unlock_ok` | result of the last real decrypt attempt: `true`, `false`, or `null` (manual / none / not tried) |
| `unlock_sources` | each source tried at startup: `{ source: "env_or_file" \| "auto", ok, reason? }`, `reason` as listed above |
| `secret_file_present` | auto wallets: does the secret file exist *now* (`false` = the next restart leaves the wallet locked) |
| `secret_protected` | `true` / `false` (red warning) / `null` (no secret on disk to protect); `secret_protection_detail` says why not |
| `orphan_files` | `{ secrets, retired, wallet_file_missing }`: credential files that belong to no live wallet |
| `backup` | `confirmed`, `missing`, or `not_applicable` (no phrase to confirm, or the offline demo) |
| `float_limit` | `MONEYSWITCH_WALLET_FLOAT_LIMIT` in USDC (default `50`) |
| `over_float_limit` | per enabled chain where the balance is known: is it above the limit |
| `retired_wallets` | `{ address, retired_at, reason }` for every replaced wallet |

`has_recovery_phrase` and `backup_confirmed_at` are returned next to `health`.

## Administrator API

All routes are administrator-only; employee MoneyKeys get 403. Send secrets in the JSON body over HTTPS (or loopback),
never in URLs. Responses that carry a secret are `Cache-Control: no-store`.

| Action | Route | JSON body |
| --- | --- | --- |
| Create | `POST /v1/admin/wallet/create` | none = auto-unlock; `password` = password mode. Returns `recovery_phrase` once |
| Import | `POST /v1/admin/wallet/import` | `kind`: `mnemonic` (`mnemonic`), `private_key` (`private_key`) or `keystore` (`keystore`, `source_password`); optional `password`; optional `expected_address` |
| Unlock | `POST /v1/admin/wallet/unlock` | `password` |
| Confirm backup | `POST /v1/admin/wallet/backup/confirm` | `positions: [i, j]`, `words: [w1, w2]` |
| Reveal | `POST /v1/admin/wallet/reveal` | `confirm_address`. Returns the phrase of a generated wallet, or the private key of an imported one |
| Auto-unlock | `POST /v1/admin/wallet/auto-unlock` | `enabled: true`, or `enabled: false` with `password` |
| Download backup | `POST /v1/admin/wallet/backup` | none: a password wallet's own file. With `password`: a portable keystore protected by it (an auto-unlock wallet's own file is never offered: its secret is never exported; `409 BACKUP_NEEDS_PASSWORD`) |
| Replace | `POST /v1/admin/wallet/replace` | `confirm_address`, optional `reason` (`lost_password`, `suspected_leak`, `other`), then the body of create or import |
| Retired wallets | `GET /v1/admin/wallet/retired` | none; each with `usdc_balance` on the selected network |
| Status and health | `GET /v1/admin/wallet` | none |

New passwords need at least eight characters. Import supports bounded-size V3 AES-128-CTR keystores with scrypt or
PBKDF2; malformed input and excessive KDF work are rejected. Errors never echo what you sent.

## Files in the data folder

| File | What it is |
| --- | --- |
| `wallet.json` | the encrypted keystore (a generated wallet also carries its encrypted recovery phrase; an imported one never does) |
| `wallet-unlock-<address>.secret` | the auto-unlock secret **of that wallet** (the name carries the address, so it can never be mistaken for, or overwrite, the credential of another key); absent in password mode |
| `retired/` | everything that was replaced or left over, never deleted: `wallet-<address>-<timestamp>.json`, `wallet-unlock-<address>-<timestamp>.secret`, and `orphan-wallet-unlock-<address>-<timestamp>.secret` for a secret that belonged to no live wallet |

There is no `wallet.json.bak-*`: turning auto-unlock on or off leaves no copy of the previous keystore, because a retired
credential must not keep opening the key. Treat every file here as a private key; the `retired/` folder holds the
credentials of the old wallets and is as sensitive as the live ones.

## If something goes wrong

| Situation | What to do |
| --- | --- |
| Lost the password of a password-mode wallet | You cannot open it. *Replace wallet*. Recover the old funds with the recovery phrase if you wrote it down, or with the file in `retired/` and the password if it turns up |
| The Overview says auto-unlock is broken (`secret_missing`, `secret_wrong`, ...) | The Wallet page names the reason. Restore the secret file from a backup of the data folder, or if the wallet is open use *Repair*; otherwise *Replace wallet* |
| `wallet.json` is missing but the Dashboard shows credential files | The data folder is probably mounted from the wrong place. Fix that first; do not create a new wallet over it unless you mean to |
| The Overview says the unlock secret is not protected | Fix the folder permissions (or move the data folder to a local disk the server's account owns), restart, and check that the warning is gone. Meanwhile keep only a tiny float |
| `409 WALLET_BUSY` on replace | A payment is in flight. Wait a few seconds to a few minutes and try again |
| The server (or its disk) is gone | Create a new instance, import the **recovery phrase** (or private key). The address and funds come back |
| You think the key leaked | Move the funds out with a wallet app using the phrase, then *Replace wallet* with reason *Suspected leak* |
| You never confirmed the backup | Wallet page → *Finish the backup first* → *Show my recovery phrase*, write the words down, answer two |
