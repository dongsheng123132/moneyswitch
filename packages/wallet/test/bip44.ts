// Test-only: derives an Ethereum address from a BIP-39 phrase WITHOUT going through ethers' HD wallet,
// so the driver's "standard path" claim is checked against an independent implementation of
// BIP-39 (seed), BIP-32 (child key derivation) and BIP-44 (m/44'/60'/0'/0/0).
// Only primitives are shared with the code under test: sha512/hmac/pbkdf2/secp256k1 from node:crypto
// and keccak256 from ethers (a hash function, not HD logic).
import { createECDH, createHmac, pbkdf2Sync } from "node:crypto";
import { getAddress, keccak256 } from "ethers";

const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HARDENED = 0x80000000;

const hmac512 = (key: Buffer, data: Buffer) => createHmac("sha512", key).update(data).digest();
const toBytes32 = (n: bigint) => Buffer.from(n.toString(16).padStart(64, "0"), "hex");
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

function publicKey(priv: bigint, compressed: boolean): Buffer {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(toBytes32(priv));
  return ecdh.getPublicKey(null, compressed ? "compressed" : "uncompressed");
}

export function bip39Seed(phrase: string): Buffer {
  return pbkdf2Sync(Buffer.from(phrase.normalize("NFKD")), Buffer.from("mnemonic"), 2048, 64, "sha512");
}

export function derivePrivateKey(phrase: string, path = "m/44'/60'/0'/0/0"): bigint {
  const master = hmac512(Buffer.from("Bitcoin seed"), bip39Seed(phrase));
  let key = BigInt("0x" + master.subarray(0, 32).toString("hex"));
  let chain = master.subarray(32);
  for (const part of path.split("/").slice(1)) {
    const hardened = part.endsWith("'");
    const index = Number(hardened ? part.slice(0, -1) : part) + (hardened ? HARDENED : 0);
    const data = hardened
      ? Buffer.concat([Buffer.from([0]), toBytes32(key), u32(index)])
      : Buffer.concat([publicKey(key, true), u32(index)]);
    const i = hmac512(chain, data);
    key = (BigInt("0x" + i.subarray(0, 32).toString("hex")) + key) % ORDER;
    chain = i.subarray(32);
  }
  return key;
}

/** Checksummed address of account 0 for `phrase`. */
export function addressFromPhrase(phrase: string, path?: string): string {
  const uncompressed = publicKey(derivePrivateKey(phrase, path), false); // 0x04 || X || Y
  return getAddress("0x" + keccak256(uncompressed.subarray(1)).slice(-40));
}
