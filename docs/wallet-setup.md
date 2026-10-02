# Wallet setup and recovery

The setup guide and Wallet page offer the same three methods:

1. **Create a new wallet**: generate a new address on the server and encrypt it with your chosen password.
2. **Import private key**: use an existing dedicated EVM payment wallet. The server validates and encrypts the key; it does not return it in responses or logs.
3. **Restore encrypted backup**: select an Ethereum V3 keystore JSON file, enter its original password, and choose a new password. The address stays the same.

Imports are only available in an empty instance. Neither creation nor import can replace an existing wallet. To set up another wallet, start an instance with a separate `MONEYSWITCH_DATA_DIR` and port. Keep mainnet and testnet instances separate.

Before funding, save the password in your password manager and use **Download encrypted backup**. Keep the backup and its password separately. Downloading a backup does not reset its password. An administrator token or MoneyKey cannot unlock a wallet. If both the password and any separate original private-key backup are lost, creating a new wallet cannot recover or transfer the old funds.

For unattended self-hosting, mount a private password file and set `MONEYSWITCH_WALLET_PASSWORD_FILE` to its path. Keep this secret out of Git, public files, command history, and ordinary application logs.

## Administrator API

These are administrator-only routes; employee MoneyKeys are rejected. Send secrets in the JSON body over HTTPS (or local loopback), never in URLs. Each action is implemented once in the server wallet driver and shared by setup, dashboard, and API clients.

| Action | Route | JSON body |
| --- | --- | --- |
| Create | `POST /v1/admin/wallet/create` | `password` |
| Import a private key | `POST /v1/admin/wallet/import` | `kind: "private_key"`, `private_key`, new `password` |
| Restore backup | `POST /v1/admin/wallet/import` | `kind: "keystore"`, `keystore` (JSON string), `source_password`, new `password` |
| Download backup | `POST /v1/admin/wallet/backup` | None; returns `address` and encrypted `keystore` |
| Unlock | `POST /v1/admin/wallet/unlock` | `password` |

New passwords require at least eight characters. Import supports bounded-size Ethereum V3 AES-128-CTR keystores with scrypt or PBKDF2; malformed input and excessive KDF work are rejected. Backup responses use `Cache-Control: no-store`. Wallet creation publishes a complete file atomically and never overwrites another creation/import, including concurrent attempts.
