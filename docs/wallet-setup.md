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
   is shown **in no deposit or copy place**: not on the Wallet page's receive card, not in the setup guide, not in the chip
   at the top right (which then says *Finish the wallet backup*), and there is no QR code or funding steps. A banner on
   the Overview reminds you. (The one exception is the *Replace wallet* dialog, which names the current wallet read-only,
   labelled "this wallet will be retired: do not send money to it", because that address must be typed to confirm a
   replacement. See *Replace wallet* below.)
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

That tidying can be wrong for a while: if `wallet.json` temporarily belongs to another key (a wrong mount, a restore of
the wrong file), the secret of the right wallet is "an orphan" and is moved to
`retired/orphan-wallet-unlock-<address>-<timestamp>.secret`. When the right `wallet.json` is back, the wallet would
otherwise stay locked (`secret_missing`). So at startup, for an auto-unlock wallet whose secret file is missing, the
orphans of **its own address** in `retired/` are tried (newest first) and the first one that really opens the live
keystore is **moved back**; the log says so. One that does not open it is left alone. If nothing fits, the log of the
still-locked wallet names the exact `retired/` files that were put aside, instead of only saying "restore from a backup".

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

That last sentence needs one more rule, because `retired/` can hold an older copy of the *same* key. Replace a wallet by
another and then replace it back (A to B to A) and `retired/` contains a copy of A together with A's old unlock secret:
turn auto-unlock off with a password and that secret would still open the copy, i.e. open A without the password. So when
the live key is in **password mode** and the password has just proved the live keystore reachable (auto-unlock turned
off, a manual import or replace, the password entered at *Unlock*, or the startup password), every `.secret` in
`retired/` that opens a retired copy of the live key is **removed**. This is the one place MoneySwitch deletes a
credential: only inside `retired/`, only a secret that opens a copy of the key that is live right now, only after the
password has proved it reachable (a *locked* password wallet is never cleaned up, because a retired pair may be the only
way in), at most 100 decrypt attempts per look. Each removal is written to the audit log
(`wallet.retired_secrets_removed`: the file names and what triggered it: `auto_unlock_off`, `import`, `replace`,
`unlock` or `startup_password`) and returned in the response (`retired_secrets_removed`). A file that could not be removed,
or one found while the wallet is still locked, is returned as `retired_secrets_still_open`, listed in
`health.retired_secrets_open_live_key`, logged as a warning at startup and shown as a red row on the Wallet page until it
is gone. For an auto-unlock wallet nothing is removed: its own secret opens it anyway.

## Replace wallet

Use it when the password is lost, when auto-unlock is broken beyond repair, or when you suspect the key leaked.

**It works on a locked wallet and never needs a password**: it only moves files, it does not decrypt anything. That matters
for the case it exists for. A wallet made by the previous release with a password is locked after a restart; if the password
is gone, its recovery phrase cannot be shown (it is inside the encrypted file), so its backup can never be confirmed, so the
Dashboard hides its address (nobody should fund an unbacked wallet), and replacing it asks for that address. The way out is
built in:

- The **Replace dialog always shows the current address**, read-only, labelled as the wallet that will be retired ("do not send
  money to it"), whatever the wallet's backup or lock state. Type it to confirm. It has no copy button, no QR code and no
  funding steps; the receive card and the header chip still hide the address while the backup is missing.
- It is reachable from the **Wallet page** (the Danger zone opens by itself for a locked wallet) and from the **setup guide**
  (under the unlock form: *Lost the password? Replace this wallet*).
- The **backup screen of a locked wallet** does not offer *Show my recovery phrase* (impossible while locked). It offers the
  two honest choices: unlock with the password (a link to the unlock form), or replace the wallet. For an auto-unlock wallet,
  which has no password, the first choice is restoring its unlock secret file.

`POST /v1/admin/wallet/replace` with `confirm_address` (the current address, exactly) plus the body of *create* or
*import* (with the same optional `expected_address`):

- **It waits for the payments in flight, refuses new ones meanwhile, and gives up after 60 s with 409 `WALLET_BUSY`.**
  A request takes a lease on the signer only when a payment is about to be created (after the unpaid probe, after the
  seller asked for money) and gives it back when the call ends, however it ends; a free resource, or a 402 that is never
  paid, holds nothing. While a replace is waiting, **no new lease is handed out**: a request that reaches the point of
  paying meanwhile is answered `WALLET_BUSY` with `charged: "no"` (`/v1/fetch`: `status: "error"`; the OpenAI-compatible
  gateway: HTTP 503), with nothing reserved or signed, and can simply be retried a moment later. So steady traffic cannot
  starve a replace. It waits up to 60 s for the leases that are already open; if payments are still in flight after
  that, it answers **409 `WALLET_BUSY`** and changes nothing. The count is in-process, not a database query. Locking
  the wallet is still refused at once, without waiting. As a second line of defence a signer checks, when it is asked to
  sign, that the wallet it came from is still the live one; if the wallet was replaced after the request started,
  **nothing is signed**, the reservation is released and the caller gets `WALLET_LOCKED` with `charged: "no"`.
- The old `wallet.json` (and its secret, if there is one) are first **copied** into `<data folder>/retired/`, under names
  containing the old address and a timestamp, and compared; only then are the new files renamed *over* the live names, so
  `wallet.json` is never absent, not even for an instant. Nothing is ever deleted. The retirement (address, time, reason,
  file names) is recorded in the database and an audit row is written; if recording it fails, the swap is undone.
- The new wallet is created or imported with auto-unlock by default; the phrase of a new wallet is returned once.
- MoneyKeys, budgets, approvals, payment history and notification settings are untouched. On-chain reconciliation of
  older unknown payments keeps working: it uses the sender address stored on each payment, not the current wallet.
- Funds in the old wallet stay at the old address. The Wallet page lists every retired wallet with its **live USDC
  balance**. They can be recovered **only if** you separately kept the old wallet's recovery phrase or private key (import
  it into MetaMask/OKX), or you remember its password (import the file from `retired/` with it). A wallet made by an
  older release never showed a recovery phrase, so it has none to fall back on; an auto-unlock wallet has no password,
  but its `retired/` copy is kept together with its unlock secret file.

## Payments interrupted by a restart

A payment is *reserved* in the database before it is signed. If the process dies in the middle, nothing would ever
settle or release that reservation, and it would count against the key's budget forever. So **before the server accepts
requests**, every payment still `reserved` from an earlier run is resolved:

- a signed authorization had been recorded (`auth_*`): the money may have moved, so it becomes `unknown` and stays counted
  until the on-chain reconcile has checked it;
- nothing had been signed: it becomes `failed` (`RESTARTED_BEFORE_SIGNING`) and the budget is released.

Both are written to the audit log (`payment.startup_sweep.*`).

The sweep reads "no `auth_*`" as "nothing was signed", which is only true because MoneySwitch pays **with EIP-3009
only** (`transferWithAuthorization`), the payload that carries the authorization's `from`, `nonce` and `validBefore`. A
seller whose requirement says `extra.assetTransferMethod: "permit2"` would be signed by `@x402/evm` as a Permit2
authorization, which has none of those, so a requirement is accepted only when `assetTransferMethod` is absent or exactly
`"eip3009"`. Anything else is refused before anything is reserved or signed: `status: "denied"`, `code:
"UNSUPPORTED_PAYMENT"`, `charged: "no"`. A seller that offers both is paid with its EIP-3009 option.

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
| `retired_secrets_open_live_key` | password wallets: names of files in `retired/` whose unlock secret still opens the live wallet without its password (empty = none; they are removed when the password is entered) |
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
credential must not keep opening the key (and a secret in `retired/` that still opens the live key is removed, see above).
Treat every file here as a private key; the `retired/` folder holds the credentials of the old wallets and is as sensitive
as the live ones.

**Back this folder up as the account that owns it, and check the archive.** The folder is `0700` and its files `0600`,
owned by the server's `node` account; the container runs with `cap_drop: ALL`, so **root there cannot read it**: a `tar`
run with `--user root` prints "Permission denied" and still writes an archive, one that lacks `wallet.json` and the unlock
secret. Use the command in `deploy/README.zh-CN.md` (`--user node`, or tar the volume from the host as root like
`deploy/upgrade-us.sh`) and then run `sh deploy/check-backup.sh <archive.tgz>`. It only lists the archive (nothing is
extracted, no secret is printed) and exits 1 unless `wallet.json` is inside and, for an auto-unlock wallet, the
`wallet-unlock-<address>.secret` of **that** address (a password wallet has none; its password is what you must keep).

## If something goes wrong

| Situation | What to do |
| --- | --- |
| Lost the password of a password-mode wallet (locked, perhaps never backed up) | You cannot open it, and you do not need to: *Replace wallet* works on a locked wallet and shows you the address to type (Wallet page → Danger zone, or the setup guide). Recover the old funds with the recovery phrase or private key if you separately kept one, or with the file in `retired/` and the password if it turns up |
| The Overview says auto-unlock is broken (`secret_missing`, `secret_wrong`, ...) | The Wallet page names the reason. Restore the secret file from a backup of the data folder, or if the wallet is open use *Repair*; otherwise *Replace wallet* |
| `wallet.json` is missing but the Dashboard shows credential files | The data folder is probably mounted from the wrong place. Fix that first; do not create a new wallet over it unless you mean to |
| The Overview says the unlock secret is not protected | Fix the folder permissions (or move the data folder to a local disk the server's account owns), restart, and check that the warning is gone. Meanwhile keep only a tiny float |
| `409 WALLET_BUSY` on replace | Payments were still in flight after the replace had waited 60 s (and it refused new ones meanwhile). Nothing was changed; try again |
| `WALLET_BUSY` on a payment (`/v1/fetch`: `status: "error"`, `charged: "no"`; gateway: HTTP 503) | A wallet replacement is waiting for the payments in flight; nothing was signed or charged. Retry once after a moment |
| The server (or its disk) is gone | Create a new instance, import the **recovery phrase** (or private key). The address and funds come back |
| You think the key leaked | Move the funds out with a wallet app using the phrase, then *Replace wallet* with reason *Suspected leak* |
| You never confirmed the backup | Wallet page → *Finish the backup first* → *Show my recovery phrase*, write the words down, answer two |
