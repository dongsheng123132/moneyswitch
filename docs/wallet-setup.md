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

`wallet.json` is encrypted, but the key that decrypts it is `wallet-unlock.secret`, in the same data folder.
**Whoever can read the data folder can spend the wallet.** That includes a copy of the folder in a backup, a disk
snapshot, or an AI agent running as the same operating-system user on the same machine.

- Keep the float small. The Wallet page shows the balance against a **float limit** (`MONEYSWITCH_WALLET_FLOAT_LIMIT`,
  default `50` USDC) and warns when it is exceeded. Move the rest to a wallet you control.
- Run team deployments on a **separate server** and keep agents off it; agents get a MoneyKey and call the API remotely.
- Protect the data folder and its backups like a private key. A backup of `/data` *is* a copy of the key.
- If that is not acceptable for your deployment, choose the password mode (*Advanced: ask for a password on every
  restart* when setting up, or *Turn off auto-unlock* later). Nothing is stored then, but the wallet stays locked after
  every restart until someone enters the password, and a lost password means *Replace wallet*.

## Setting up (Dashboard)

The setup guide and the Wallet page offer the same options:

1. **Create wallet (recommended).** One click, no password field. The 12 words are shown with a warning; you type
   two of them (positions chosen at random) to prove you wrote them down. The deposit address, its QR code and the
   funding steps stay hidden until that check passes. A banner on the Overview reminds you while it is missing.
2. **Import** an existing wallet instead (only into an empty instance):
   - **Recovery phrase**: 12 or 24 English words, account 1 (`m/44'/60'/0'/0/0`). No BIP-39 passphrase ("25th word").
   - **Private key**: a dedicated payment wallet. The server validates and encrypts it; it is never returned or logged.
   - **Encrypted keystore** (Ethereum V3 JSON) with its original password; the address stays the same.
   Imported wallets count as backed up: you brought the credential. A wallet imported from a bare private key has no
   phrase; *Reveal* shows the key instead.
3. **Advanced: ask for a password on every restart.** Adds a password (8+ characters) to either path above. No secret
   file is written.

Creation and import never overwrite an existing wallet, including concurrent attempts. To switch wallets use
*Replace wallet* (below).

## The recovery phrase

- Standard BIP-39 (English), derivation path `m/44'/60'/0'/0/0`. The tests derive the address from the words with an
  independent BIP-32/BIP-44 implementation and check published vectors, so the address you see in MetaMask or OKX is
  the address MoneySwitch shows.
- It is returned **once**, by the create (or replace) response: admin only, `Cache-Control: no-store`. It is stored only
  inside the encrypted keystore, never in the database, the audit log or any log.
- **Check:** `POST /v1/admin/wallet/backup/confirm` with two 1-based positions and the two words; the server compares
  them and records `backup_confirmed_at`.
- **Reveal later:** Wallet page, *Danger zone*, *Reveal recovery phrase*. You must type the current wallet address
  exactly. The response is `no-store`, the audit log records *that* it happened (never what), and the Dashboard hides
  the words again after a minute.
- Wallets created by an earlier release with a password also carry the phrase inside their keystore: unlock the
  wallet with its password once, then reveal and confirm it.

## What happens at startup

1. `MONEYSWITCH_WALLET_PASSWORD`, or the contents of `MONEYSWITCH_WALLET_PASSWORD_FILE`, if that is **non-empty**. An empty
   variable, an empty or blank file, and an unreadable file all count as "not configured" (a warning is logged). The
   placeholder file that older Docker deployments mount is therefore harmless.
2. Otherwise `wallet-unlock.secret`.
3. Otherwise the wallet stays locked until an administrator unlocks it in the Dashboard.

A source that exists but does not open the wallet is logged as an error (never with the credential), shown on the Wallet
page and as an Overview banner, and the next source is still tried, so a stale password in the environment cannot lock
out a wallet whose secret works. `GET /v1/admin/wallet` reports the outcome as `health.auto_unlock_ok`.

## Turn auto-unlock on or off

*Wallet → Danger zone → Auto-unlock.*

- **On** needs the wallet unlocked (open it with its password first). The wallet is re-encrypted with a fresh random
  secret and the secret file is written.
- **Off** needs a new password (8+ characters). The wallet is re-encrypted with it and the secret file is removed.
- If the unlock secret ever stops matching the wallet file, unlock with the password and use *Repair* (this is "on" again).

Both directions are crash-safe: the new keystore is built and test-decrypted before anything on disk changes, the previous
keystore is kept as `wallet.json.bak-<timestamp>` (delete the copies yourself once you are happy), the secret is installed
before the swap or removed after it, and a failure part-way puts the files back. Operations on one data folder never
overlap. At no point is there a keystore that nothing can open.

## Replace wallet

Use it when the password is lost, when auto-unlock is broken beyond repair, or when you suspect the key leaked.

`POST /v1/admin/wallet/replace` with `confirm_address` (the current address, exactly) plus the body of *create* or *import*:

- Refused with **409 `WALLET_BUSY`** while any payment is `reserved` (in flight).
- `wallet.json` (and `wallet-unlock.secret`, if there is one) are **moved** to `<data folder>/retired/`, under names
  containing the old address and a timestamp. They are never deleted. The retirement (address, time, reason, file names)
  is recorded in the database and an audit row is written.
- The new wallet is created or imported with auto-unlock by default; the phrase of a new wallet is returned once.
- MoneyKeys, budgets, approvals, payment history and notification settings are untouched. On-chain reconciliation of
  older unknown payments keeps working: it uses the sender address stored on each payment, not the current wallet.
- Funds in the old wallet stay at the old address. The Wallet page lists every retired wallet with its **live USDC
  balance**. To recover them, import the old recovery phrase into MetaMask/OKX, or import the file from `retired/` with
  its original password.

## Health

`GET /v1/admin/wallet` keeps its earlier fields and adds `health`:

| Field | Meaning |
| --- | --- |
| `unlock_mode` | `auto` (secret file), `env_or_file` (startup password), `manual`, or `none` (no wallet) |
| `auto_unlock_ok` | result of the last real decrypt attempt: `true`, `false`, or `null` (manual / none / not tried) |
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
| Import | `POST /v1/admin/wallet/import` | `kind`: `mnemonic` (`mnemonic`), `private_key` (`private_key`) or `keystore` (`keystore`, `source_password`); optional `password` |
| Unlock | `POST /v1/admin/wallet/unlock` | `password` |
| Confirm backup | `POST /v1/admin/wallet/backup/confirm` | `positions: [i, j]`, `words: [w1, w2]` |
| Reveal | `POST /v1/admin/wallet/reveal` | `confirm_address` |
| Auto-unlock | `POST /v1/admin/wallet/auto-unlock` | `enabled: true`, or `enabled: false` with `password` |
| Download backup | `POST /v1/admin/wallet/backup` | none: a password wallet's own file. With `password`: a portable keystore protected by it (an auto-unlock wallet's own file is never offered: its secret is never exported) |
| Replace | `POST /v1/admin/wallet/replace` | `confirm_address`, optional `reason` (`lost_password`, `suspected_leak`, `other`), then the body of create or import |
| Retired wallets | `GET /v1/admin/wallet/retired` | none; each with `usdc_balance` on the selected network |
| Status and health | `GET /v1/admin/wallet` | none |

New passwords need at least eight characters. Import supports bounded-size V3 AES-128-CTR keystores with scrypt or
PBKDF2; malformed input and excessive KDF work are rejected. Errors never echo what you sent.

## Files in the data folder

| File | What it is |
| --- | --- |
| `wallet.json` | the encrypted keystore (with the encrypted recovery phrase inside) |
| `wallet-unlock.secret` | the auto-unlock secret (mode 0600 where the OS supports it); absent in password mode |
| `wallet.json.bak-<timestamp>` | the keystore as it was before an auto-unlock change |
| `retired/` | files of replaced wallets: `wallet-<address>-<timestamp>.json` and, if there was one, `wallet-unlock-<address>-<timestamp>.secret` |

Treat all of them as private keys.

## If something goes wrong

| Situation | What to do |
| --- | --- |
| Lost the password of a password-mode wallet | You cannot open it. *Replace wallet*. Recover the old funds with the recovery phrase if you wrote it down, or with the file in `retired/` and the password if it turns up |
| The Overview says auto-unlock is broken | Unlock with the password if you have one, then *Repair*; otherwise *Replace wallet* |
| The server (or its disk) is gone | Create a new instance, import the **recovery phrase**. The address and funds come back |
| You think the key leaked | Move the funds out with a wallet app using the phrase, then *Replace wallet* with reason *Suspected leak* |
| You never confirmed the backup | Wallet page → *Finish the backup first*: type the address, write the words down, answer two |
