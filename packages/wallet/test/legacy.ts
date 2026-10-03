import fs from "node:fs";
import path from "node:path";
import { encryptKeystoreJson, HDNodeWallet, Wallet, type KeystoreAccount } from "ethers";

/**
 * A wallet.json exactly as an OLDER version wrote a password wallet. Such wallets can no longer be created, only found: the server
 * unlocks them at startup with MONEYSWITCH_WALLET_PASSWORD(_FILE) and otherwise leaves them locked until the wallet is replaced.
 * `marker: false` leaves out the x-moneyswitch field, as the very first releases did. A light scrypt keeps a test from waiting for
 * the production cost.
 */
export async function writeLegacyPasswordWallet(
  dataDir: string,
  password: string,
  opts: { wallet?: Wallet | HDNodeWallet; marker?: boolean } = {}
): Promise<Wallet | HDNodeWallet> {
  const wallet = opts.wallet ?? Wallet.createRandom();
  const account: KeystoreAccount = { address: wallet.address, privateKey: wallet.privateKey };
  // a wallet generated here carried its phrase inside the keystore (x-ethers), a wallet imported from a bare key did not
  if (wallet instanceof HDNodeWallet && wallet.mnemonic) account.mnemonic = { path: wallet.path!, locale: "en", entropy: wallet.mnemonic.entropy };
  const data = JSON.parse(await encryptKeystoreJson(account, password, { scrypt: { N: 2 ** 10, r: 8, p: 1 } }));
  if (opts.marker !== false) data["x-moneyswitch"] = { version: 1, protection: "password" };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "wallet.json"), JSON.stringify(data), { mode: 0o600 });
  return wallet;
}
