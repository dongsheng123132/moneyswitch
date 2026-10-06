import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { createMoneyKey, authenticateMoneyKey, getMoneyKeyById, listMoneyKeys } from "../src/keys.js";
import { createChildKey, createChildKeyInTransaction, DelegationError, type CreateChildKeyInput } from "../src/delegation.js";
import { rotateMoneyKeySecret } from "../src/rotate.js";
import * as chainModule from "../src/chain.js";
import { getKeyChain } from "../src/chain.js";
import { parseUsdcToMicros as usdc } from "../src/money.js";

/** SPEC.md §1 (v0.7.2): a key's network type is written when it is issued, inherited by child keys, and never changed. */

const OPTS = { maxDepth: 3 };

function mk(db: ReturnType<typeof freshDb>["db"], over: Partial<Parameters<typeof createMoneyKey>[1]> = {}) {
  return createMoneyKey(db, { name: "root", totalBudget: usdc("10"), dailyBudget: usdc("2"), perRequestLimit: usdc("1"), allowedHosts: ["example.com:443"], canDelegate: true, ...over });
}
const childInput = (over: Partial<CreateChildKeyInput> = {}): CreateChildKeyInput => ({ name: "child", dailyBudget: usdc("1"), totalBudget: usdc("5"), perRequestLimit: usdc("0.5"), ...over });

describe("createMoneyKey: networkMode", () => {
  it("is stored and read back as given; left out it is null (a key from before network types)", () => {
    const { db } = freshDb();
    expect(mk(db, { networkMode: "testnet" }).row.networkMode).toBe("testnet");
    expect(mk(db, { networkMode: "mainnet" }).row.networkMode).toBe("mainnet");
    expect(mk(db).row.networkMode).toBeNull();
    expect(mk(db, { networkMode: null }).row.networkMode).toBeNull();
    expect(listMoneyKeys(db).map((k) => k.networkMode).sort()).toEqual(["mainnet", null, null, "testnet"]);
  });

  it("survives authentication, lookup and a reset of the secret unchanged", () => {
    const { db } = freshDb();
    const { plaintextKey, row } = mk(db, { networkMode: "mainnet" });
    expect(authenticateMoneyKey(db, plaintextKey).networkMode).toBe("mainnet");
    expect(getMoneyKeyById(db, row.id)!.networkMode).toBe("mainnet");
    const rotated = rotateMoneyKeySecret(db, row.id)!;
    expect(rotated.row.networkMode).toBe("mainnet");
    expect(authenticateMoneyKey(db, rotated.plaintextKey).networkMode).toBe("mainnet");
  });
});

describe("createChildKey: the child pays on the same kind of chain as its parent", () => {
  it("inherits testnet and mainnet", () => {
    const { db } = freshDb();
    for (const mode of ["testnet", "mainnet"] as const) {
      const parent = mk(db, { networkMode: mode });
      expect(createChildKey(db, parent.row.id, childInput(), OPTS).row.networkMode).toBe(mode);
    }
  });

  it("a parent from before network types has a child without one", () => {
    const { db } = freshDb();
    const parent = mk(db);
    expect(createChildKey(db, parent.row.id, childInput(), OPTS).row.networkMode).toBeNull();
  });

  it("naming the parent's own value is accepted; any other value is INVALID_REQUEST on network_mode, and no key is created", () => {
    const { db } = freshDb();
    const testnet = mk(db, { networkMode: "testnet" });
    expect(createChildKey(db, testnet.row.id, childInput({ networkMode: "testnet" }), OPTS).row.networkMode).toBe("testnet");
    const count = () => listMoneyKeys(db).length;
    const before = count();
    let err: unknown;
    try {
      createChildKey(db, testnet.row.id, childInput({ networkMode: "mainnet" }), OPTS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DelegationError);
    expect(err).toMatchObject({ code: "INVALID_REQUEST", field: "network_mode", parentValue: "testnet", httpStatus: 400 });
    const old = mk(db);
    expect(() => createChildKey(db, old.row.id, childInput({ networkMode: "testnet" }), OPTS)).toThrowError(/network_mode/);
    expect(count()).toBe(before + 1); // nothing was added by the refused ones: only the "old" parent above
  });

  it("goes all the way down: a grandchild has the root's type", () => {
    const { db } = freshDb();
    const root = mk(db, { networkMode: "mainnet" });
    const kid = createChildKey(db, root.row.id, childInput({ canDelegate: true }), OPTS);
    expect(createChildKey(db, kid.row.id, childInput(), OPTS).row.networkMode).toBe("mainnet");
  });

  it("the same inside the creation transaction", () => {
    const { db, sqlite } = freshDb();
    const parent = mk(db, { networkMode: "testnet" });
    expect(createChildKeyInTransaction(sqlite, db, parent.row.id, childInput(), OPTS).row.networkMode).toBe("testnet");
  });
});

describe("chainNetworkMode: the network type of a key as its chain defines it", () => {
  const { chainNetworkMode } = chainModule;
  const typed = (db: ReturnType<typeof freshDb>["db"], mode: "testnet" | "mainnet" | null) => mk(db, { networkMode: mode }).row;

  it("a key's own type, else the first typed ancestor's, else null", () => {
    const { db, sqlite } = freshDb();
    const parent = typed(db, "mainnet");
    const kid = createChildKey(db, parent.id, childInput({ canDelegate: true }), OPTS).row;
    const grandkid = createChildKey(db, kid.id, childInput(), OPTS).row;
    sqlite.prepare("UPDATE money_keys SET network_mode = NULL WHERE id IN (?, ?)").run(kid.id, grandkid.id); // keys of a database from before the column
    expect(chainNetworkMode(getKeyChain(db, grandkid.id))).toEqual({ conflict: false, mode: "mainnet" });
    expect(chainNetworkMode(getKeyChain(db, kid.id))).toEqual({ conflict: false, mode: "mainnet" });
    expect(chainNetworkMode(getKeyChain(db, parent.id))).toEqual({ conflict: false, mode: "mainnet" });
    const old = typed(db, null);
    const oldKid = createChildKey(db, old.id, childInput(), OPTS).row;
    expect(chainNetworkMode(getKeyChain(db, oldKid.id))).toEqual({ conflict: false, mode: null });
  });

  it("two typed levels that differ are a conflict, wherever they are in the chain", () => {
    const { db, sqlite } = freshDb();
    const parent = typed(db, "testnet");
    const kid = createChildKey(db, parent.id, childInput({ canDelegate: true }), OPTS).row;
    const grandkid = createChildKey(db, kid.id, childInput(), OPTS).row;
    sqlite.prepare("UPDATE money_keys SET network_mode = 'mainnet' WHERE id = ?").run(grandkid.id); // no code path does this
    expect(chainNetworkMode(getKeyChain(db, grandkid.id))).toEqual({ conflict: true });
    sqlite.prepare("UPDATE money_keys SET network_mode = NULL WHERE id = ?").run(grandkid.id);
    sqlite.prepare("UPDATE money_keys SET network_mode = 'mainnet' WHERE id = ?").run(kid.id);
    expect(chainNetworkMode(getKeyChain(db, grandkid.id))).toEqual({ conflict: true });
  });
});

describe("createChildKey under a parent that has no type of its own", () => {
  it("takes the type its parent's chain defines, and compares a named type with that one", () => {
    const { db, sqlite } = freshDb();
    const root = mk(db, { networkMode: "testnet" });
    const middle = createChildKey(db, root.row.id, childInput({ canDelegate: true }), OPTS).row;
    sqlite.prepare("UPDATE money_keys SET network_mode = NULL WHERE id = ?").run(middle.id);
    const leaf = createChildKey(db, middle.id, childInput(), OPTS).row;
    expect(leaf.networkMode).toBe("testnet");
    expect(() => createChildKey(db, middle.id, childInput({ networkMode: "mainnet" }), OPTS)).toThrowError(/network_mode/);
    expect(createChildKey(db, middle.id, childInput({ networkMode: "testnet" }), OPTS).row.networkMode).toBe("testnet");
  });

  it("a parent whose own chain disagrees with itself gets no child", () => {
    const { db, sqlite } = freshDb();
    const root = mk(db, { networkMode: "testnet" });
    const middle = createChildKey(db, root.row.id, childInput({ canDelegate: true }), OPTS).row;
    sqlite.prepare("UPDATE money_keys SET network_mode = 'mainnet' WHERE id = ?").run(middle.id);
    let err: unknown;
    try {
      createChildKey(db, middle.id, childInput(), OPTS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DelegationError);
    expect(err).toMatchObject({ code: "INVALID_REQUEST", field: "network_mode" });
  });
});
