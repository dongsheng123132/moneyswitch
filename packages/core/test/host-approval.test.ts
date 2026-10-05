import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import os from "node:os";
import { freshDb } from "./helpers.js";
import { createMoneyKey, getMoneyKeyById, revokeMoneyKey } from "../src/keys.js";
import { createChildKey } from "../src/delegation.js";
import { parseUsdcToMicros as usdc } from "../src/money.js";
import { APPROVAL_TTL_MS, createApproval, decideApproval, getApproval, sha256OfBody, validateApprovalForUse } from "../src/approval.js";
import {
  AllowHostError,
  HOST_LOOKUP_TIMEOUT_MS,
  MAX_PENDING_HOST_APPROVALS,
  approveHostApproval,
  createHostApproval,
  hostOfApproval,
  hostPortOf,
  isHostListed,
  isNonPublicAddress,
  normalizedAllowedEntry,
  normalizedHostname,
} from "../src/host-approval.js";
import { checkHostAllowed, checkHostAllowedForChain } from "../src/gate.js";
import { MoneySwitchError, limitFields } from "../src/types.js";
import { listAudit } from "../src/audit.js";
import type { MoneySwitchDb } from "@moneyswitch/db";

function key(db: MoneySwitchDb, over: Partial<Parameters<typeof createMoneyKey>[1]> = {}) {
  return createMoneyKey(db, {
    name: "root",
    totalBudget: usdc("10"),
    dailyBudget: usdc("1"),
    perRequestLimit: usdc("0.5"),
    allowedHosts: ["known.example:443"],
    maxPaymentsPerMinute: 100,
    canDelegate: true,
    ...over,
  }).row;
}

// DNS is replaced: a name resolves to a public address unless a test says otherwise (no test depends on the network).
const dns = vi.hoisted(() => ({
  answers: new Map<string, string[]>(),
  failing: new Set<string>(),
  calls: [] as string[],
  hook: null as null | (() => void),
  hang: false,
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (name: string) => {
    dns.calls.push(name);
    if (dns.hang) return new Promise(() => {});
    dns.hook?.();
    if (dns.failing.has(name)) throw Object.assign(new Error("getaddrinfo ENOTFOUND " + name), { code: "ENOTFOUND" });
    return (dns.answers.get(name) ?? ["93.184.216.34"]).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }),
}));
beforeEach(() => {
  dns.answers.clear();
  dns.failing.clear();
  dns.calls.length = 0;
  dns.hook = null;
  dns.hang = false;
});
afterEach(() => {
  vi.useRealTimers();
});

const URL_NEW = "https://api.newhost.example/v1/data?x=1";
const ask = (keyId: string, over: Record<string, unknown> = {}) => ({ keyId, url: URL_NEW, method: "GET", body: undefined as unknown, ...over });
const allowed = (db: MoneySwitchDb, id: string) => getMoneyKeyById(db, id)!.allowedHosts;
const auditActions = (db: MoneySwitchDb) => listAudit(db).map((a) => a.action);

async function refusal(p: Promise<unknown>): Promise<AllowHostError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AllowHostError);
    return e as AllowHostError;
  }
  throw new Error("expected the approval to be refused");
}

describe("isNonPublicAddress: IPv4", () => {
  // [range, addresses inside it (first, last, one in the middle), the addresses just outside it]
  const ranges: Array<[string, string[], string[]]> = [
    ["0.0.0.0/8", ["0.0.0.0", "0.255.255.255"], ["1.0.0.0"]],
    ["10.0.0.0/8", ["10.0.0.0", "10.1.2.3", "10.255.255.255"], ["9.255.255.255", "11.0.0.0"]],
    ["100.64.0.0/10", ["100.64.0.0", "100.100.100.200", "100.127.255.255"], ["100.63.255.255", "100.128.0.0"]],
    ["127.0.0.0/8", ["127.0.0.1", "127.255.255.255"], ["126.255.255.255", "128.0.0.0"]],
    ["169.254.0.0/16", ["169.254.0.0", "169.254.169.254", "169.254.255.255"], ["169.253.255.255", "169.255.0.0"]],
    ["172.16.0.0/12", ["172.16.0.0", "172.20.1.1", "172.31.255.255"], ["172.15.255.255", "172.32.0.0"]],
    ["192.0.0.0/24", ["192.0.0.0", "192.0.0.255"], ["191.255.255.255", "192.0.1.0"]],
    ["192.0.2.0/24", ["192.0.2.0", "192.0.2.255"], ["192.0.1.255", "192.0.3.0"]],
    ["192.168.0.0/16", ["192.168.0.0", "192.168.1.1", "192.168.255.255"], ["192.167.255.255", "192.169.0.0"]],
    ["198.18.0.0/15", ["198.18.0.0", "198.19.255.255"], ["198.17.255.255", "198.20.0.0"]],
    ["198.51.100.0/24", ["198.51.100.0", "198.51.100.255"], ["198.51.99.255", "198.51.101.0"]],
    ["203.0.113.0/24", ["203.0.113.0", "203.0.113.255"], ["203.0.112.255", "203.0.114.0"]],
    ["224.0.0.0/4", ["224.0.0.1", "239.255.255.255"], ["223.255.255.255"]],
    ["240.0.0.0/4", ["240.0.0.0", "250.1.2.3", "255.255.255.255"], []],
  ];
  for (const [range, inside, outside] of ranges) {
    it(`${range}: every address inside is non-public, the neighbours outside are not`, () => {
      for (const a of inside) expect(isNonPublicAddress(a), a).toBe(true);
      for (const a of outside) expect(isNonPublicAddress(a), a).toBe(false);
    });
  }

  it("public addresses are not", () => {
    for (const a of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "151.101.1.69", "172.217.14.206", "104.18.12.34", "192.0.1.1", "100.63.0.1"]) {
      expect(isNonPublicAddress(a), a).toBe(false);
    }
  });
});

describe("isNonPublicAddress: IPv6", () => {
  it(":: and ::1, unique-local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8, documentation 2001:db8::/32", () => {
    for (const a of [
      "::", "::1", "0:0:0:0:0:0:0:1",
      "fc00::", "fc00::1", "fd12:3456::1", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "fe80::1", "fe80::abcd:1", "febf::1",
      "fec0::1", "feff::1",
      "ff00::", "ff02::1", "ffff::1",
      "2001:db8::", "2001:db8::1", "2001:0db8:ffff:ffff::1",
    ]) {
      expect(isNonPublicAddress(a), a).toBe(true);
    }
  });

  it("the addresses just outside those ranges, and public ones, are not", () => {
    for (const a of ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e", "2001:db9::1", "2001:db7::1", "2001:4860::1", "2400:cb00::1"]) {
      expect(isNonPublicAddress(a), a).toBe(false);
    }
  });

  it("the IPv4 inside ::ffff:0:0/96, 64:ff9b::/96 and 2002::/16 is judged by the IPv4 rules", () => {
    for (const a of [
      "::ffff:10.0.0.1", "::ffff:0a00:0001", "::ffff:127.0.0.1", "::ffff:7f00:1", "::FFFF:10.0.0.1", "::ffff:100.100.100.200", "::ffff:169.254.169.254", "::ffff:255.255.255.255",
      "64:ff9b::a00:1", "64:ff9b::10.0.0.1", "64:ff9b::7f00:1", "64:ff9b::6464:64c8",
      "2002:0a00:0001::", "2002:7f00:1::", "2002:c0a8:101::1", "2002:a9fe:a9fe::",
    ]) {
      expect(isNonPublicAddress(a), a).toBe(true);
    }
    for (const a of ["::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "64:ff9b::8.8.8.8", "2002:0808:0808::", "2002:5db8:d822::1"]) {
      expect(isNonPublicAddress(a), a).toBe(false);
    }
  });

  it("the IPv4 inside ::ffff:0:0:0/96 (SIIT, `::ffff:0:a.b.c.d`) is judged by the IPv4 rules too", () => {
    for (const a of ["::ffff:0:a00:1", "::ffff:0:10.0.0.1", "::ffff:0:7f00:1", "::ffff:0:127.0.0.1", "::FFFF:0:A9FE:A9FE", "::ffff:0:100.100.100.200", "::ffff:0:ffff:ffff"]) {
      expect(isNonPublicAddress(a), a).toBe(true);
    }
    for (const a of ["::ffff:0:808:808", "::ffff:0:8.8.8.8", "::ffff:0:5db8:d822"]) expect(isNonPublicAddress(a), a).toBe(false);
  });

  it("100::/64 (discard-only), 2001::/32 (Teredo), 3fff::/20 and the whole of 64:ff9b:1::/48 are refused outright", () => {
    for (const a of [
      "100::", "100::1", "100:0:0:0:ffff:ffff:ffff:ffff",
      "2001::", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:0:ffff:ffff:ffff:ffff:ffff:ffff",
      "3fff::", "3fff::1", "3fff:abc::1", "3fff:0fff:ffff:ffff:ffff:ffff:ffff:ffff",
      "64:ff9b:1::", "64:ff9b:1::1", "64:ff9b:1::808:808", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff", // (the last two would embed a public IPv4 if it were read as one)
    ]) {
      expect(isNonPublicAddress(a), a).toBe(true);
    }
    // just outside them
    for (const a of ["3fff:1000::1", "3ffe::1", "64:ff9b:2::1", "2001:4860::1", "2001:4860:4860::8888", "2606:4700:4700::1111"]) {
      expect(isNonPublicAddress(a), a).toBe(false);
    }
  });

  it("brackets, any letter case and a zone id do not change the answer", () => {
    expect(isNonPublicAddress("[::1]")).toBe(true);
    expect(isNonPublicAddress("[FE80::1]")).toBe(true);
    expect(isNonPublicAddress("fe80::1%eth0")).toBe(true);
    expect(isNonPublicAddress("[2606:4700:4700::1111]")).toBe(false);
    expect(isNonPublicAddress("2606:4700:4700::1111%eth0")).toBe(false);
  });
});

describe("isNonPublicAddress: names", () => {
  it("localhost and *.localhost are, in any case and with a trailing dot", () => {
    for (const n of ["localhost", "LOCALHOST", "localhost.", "foo.localhost", "a.b.localhost", "Foo.LocalHost."]) expect(isNonPublicAddress(n), n).toBe(true);
  });

  it("any other name is not judged here (only DNS can say)", () => {
    for (const n of ["example.com", "api.newhost.example", "localhost.example.com", "notlocalhost", "mylocalhost", "fc00.example.com", "10.example.com", ""]) {
      expect(isNonPublicAddress(n), n).toBe(false);
    }
  });
});

describe("hostPortOf", () => {
  it("lower-case host, port always explicit", () => {
    expect(hostPortOf(new URL("https://API.NewHost.example/v1"))).toBe("api.newhost.example:443");
    expect(hostPortOf(new URL("http://Seller.Example/x"))).toBe("seller.example:80");
    expect(hostPortOf(new URL("https://seller.example:8443/x"))).toBe("seller.example:8443");
  });

  it("one trailing dot is dropped: example.com. is example.com (and an IDN name is its punycode form)", () => {
    expect(hostPortOf(new URL("https://Example.COM./x"))).toBe("example.com:443");
    expect(hostPortOf(new URL("http://example.com.:8080/x"))).toBe("example.com:8080");
    expect(hostPortOf(new URL("https://BÜCHER.Example./x"))).toBe("xn--bcher-kva.example:443");
    expect(hostPortOf(new URL("https://example.com../x"))).toBe("example.com.:443"); // one dot, not all of them
    expect(hostPortOf(new URL("http://[::1]:8080/"))).toBe("[::1]:8080");
    expect(normalizedHostname(new URL("https://API.Example.com./"))).toBe("api.example.com");
    expect(normalizedHostname(new URL("https://api.example.com/"))).toBe("api.example.com");
  });
});

describe("hostOfApproval", () => {
  it("is the host:port approving a 'host' approval lists, and nothing for a payment approval", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db, { allowedHosts: [] });
    for (const url of ["https://API.NewHost.example/v1?x=1", "http://Seller.Example:8080/x", "https://BÜCHER.Example./x", "https://api.newhost.example./x"]) {
      const a = createHostApproval(sqlite, db, ask(k.id, { url }));
      expect(hostOfApproval(a), url).not.toBeNull();
      expect((await approveHostApproval(sqlite, db, a.id)).host, url).toBe(hostOfApproval(a));
    }
    expect(allowed(db, k.id)).toEqual(["api.newhost.example:443", "seller.example:8080", "xn--bcher-kva.example:443"]);
    const p = createApproval(db, { keyId: k.id, url: URL_NEW, method: "GET", body: undefined, network: "n", asset: "a", payTo: "0xpay", amount: 5n });
    expect(hostOfApproval(p)).toBeNull();
    expect(hostOfApproval({ kind: "host", url: "not a url" })).toBeNull();
  });
});

describe("a trailing dot does not make another host", () => {
  const keyRow = (allowedHosts: string[]) => ({ allowedHosts }) as never;
  const allows = (list: string[], url: string) => {
    try {
      checkHostAllowed(new URL(url), keyRow(list));
      return true;
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("HOST_NOT_ALLOWED");
      return false;
    }
  };

  it("the allowed check: example.com. is allowed where example.com is, as host:port or as the bare host, in any case", () => {
    expect(allows(["example.com:443"], "https://example.com./x")).toBe(true);
    expect(allows(["example.com:443"], "https://EXAMPLE.com./x")).toBe(true);
    expect(allows(["example.com"], "https://example.com./x")).toBe(true);
    expect(allows(["example.com"], "http://example.com.:8080/x")).toBe(true);
    expect(allows(["example.com:8080"], "http://example.com.:8080/x")).toBe(true);
    // ... and still nothing else
    expect(allows(["example.com:443"], "http://example.com./x")).toBe(false); // port 80
    expect(allows(["example.com:443"], "https://example.org./x")).toBe(false);
    expect(allows(["example.com:443"], "https://sub.example.com./x")).toBe(false);
    expect(allows(["example.com:443"], "https://example.com../x")).toBe(false); // only one dot is dropped
    expect(allows([], "https://example.com./x")).toBe(false);
    // the unchanged cases
    expect(allows(["example.com:443"], "https://example.com/x")).toBe(true);
    expect(allows(["example.com:443"], "https://evil.com/")).toBe(false);
  });

  it("an allowed_hosts entry is spelled the same way: lower case, one trailing dot dropped from its host part", () => {
    expect(normalizedAllowedEntry("Example.COM.")).toBe("example.com");
    expect(normalizedAllowedEntry("example.com.:443")).toBe("example.com:443");
    expect(normalizedAllowedEntry("EXAMPLE.com.:8443")).toBe("example.com:8443");
    expect(normalizedAllowedEntry("example.com")).toBe("example.com");
    expect(normalizedAllowedEntry("example.com:443")).toBe("example.com:443");
    expect(normalizedAllowedEntry("example.com..:443")).toBe("example.com.:443"); // one dot, not all of them
    expect(normalizedAllowedEntry("[::1]:8080")).toBe("[::1]:8080");
    expect(normalizedAllowedEntry("[::1]")).toBe("[::1]");
    expect(normalizedAllowedEntry(".")).toBe(".");
    expect(normalizedAllowedEntry("")).toBe("");
  });

  it("a dotted entry allows the host with or without the dot: 'example.com.:443' and 'example.com.' (the gate)", () => {
    for (const entry of ["example.com.:443", "example.com.", "EXAMPLE.com.:443", "example.com:443", "example.com"]) {
      expect(allows([entry], "https://example.com/x"), entry).toBe(true);
      expect(allows([entry], "https://example.com./x"), entry).toBe(true);
      expect(allows([entry], "https://Example.COM.:443/x"), entry).toBe(true);
    }
    // the entry's port still counts, and its dot makes no other host
    expect(allows(["example.com.:443"], "http://example.com./x")).toBe(false); // port 80
    expect(allows(["example.com.:443"], "https://example.com.:8443/x")).toBe(false);
    expect(allows(["example.com.:443"], "https://sub.example.com./x")).toBe(false);
    expect(allows(["example.com.:443"], "https://example.org./x")).toBe(false);
    expect(allows(["example.com."], "https://example.com.:8443/x")).toBe(true); // a bare host entry is any port
    expect(allows(["example.com."], "https://example.org/x")).toBe(false);
    expect(allows(["example.com.."], "https://example.com./x")).toBe(false); // only one dot is dropped, on either side
    expect(allows(["example.com.:80"], "http://example.com/x")).toBe(true);
    expect(isHostListed(new URL("https://example.com./x"), ["other.example:443", "example.com.:443"])).toBe(true);
    expect(isHostListed(new URL("https://example.com./x"), [])).toBe(false);
  });

  it("a dotted entry for a host that is on a child key's list is allowed down the chain", () => {
    const { db } = freshDb();
    const root = key(db, { allowedHosts: ["example.com.:443"] });
    const { row: child } = createChildKey(db, root.id, { name: "kid", dailyBudget: usdc("1"), totalBudget: usdc("1"), perRequestLimit: usdc("0.1") }, { maxDepth: 3 });
    expect(child.allowedHosts).toEqual(["example.com.:443"]);
    expect(() => checkHostAllowedForChain(db, new URL("https://example.com/x"), child)).not.toThrow();
    expect(() => checkHostAllowedForChain(db, new URL("https://example.com./x"), child)).not.toThrow();
    expect(() => checkHostAllowedForChain(db, new URL("https://example.org/x"), child)).toThrow(MoneySwitchError);
  });

  it("approving a host that the key lists with a dot adds no second entry, whichever way the request is spelled", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db, { allowedHosts: ["example.com.:443", "bare.example."] });
    for (const url of ["https://example.com/x", "https://example.com./x", "https://EXAMPLE.com.:443/x"]) {
      const a = createHostApproval(sqlite, db, ask(k.id, { url }));
      expect((await approveHostApproval(sqlite, db, a.id)).approval.status, url).toBe("approved");
    }
    const b = createHostApproval(sqlite, db, ask(k.id, { url: "https://bare.example:8443/x" }));
    await approveHostApproval(sqlite, db, b.id);
    expect(allowed(db, k.id)).toEqual(["example.com.:443", "bare.example."]);
    // and a host that is not listed is still appended, in its own normalized form
    const c = createHostApproval(sqlite, db, ask(k.id, { url: "https://Other.Example./x" }));
    await approveHostApproval(sqlite, db, c.id);
    expect(allowed(db, k.id)).toEqual(["example.com.:443", "bare.example.", "other.example:443"]);
  });

  it("asking for example.com. and example.com is one approval; approving lists one entry, and a request for either is then allowed", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    const a = createHostApproval(sqlite, db, ask(k.id, { url: "https://api.newhost.example./v1" }));
    expect(createHostApproval(sqlite, db, ask(k.id, { url: "https://api.newhost.example/v2" })).id).toBe(a.id);
    expect(createHostApproval(sqlite, db, ask(k.id, { url: "https://API.NewHost.example.:443/v3" })).id).toBe(a.id);
    expect(sqlite.prepare("SELECT count(*) AS n FROM approvals").get()).toEqual({ n: 1 });
    expect((await approveHostApproval(sqlite, db, a.id)).host).toBe("api.newhost.example:443");
    expect(dns.calls).toEqual(["api.newhost.example"]); // the look is for the name that is listed
    expect(allowed(db, k.id)).toEqual(["known.example:443", "api.newhost.example:443"]);
    const listed = getMoneyKeyById(db, k.id)!;
    expect(() => checkHostAllowed(new URL("https://api.newhost.example./x"), listed)).not.toThrow();
    expect(() => checkHostAllowed(new URL("https://api.newhost.example/x"), listed)).not.toThrow();
    // a dotted request for a host that is already listed makes no second entry, as host:port or as the bare host
    const again = createHostApproval(sqlite, db, ask(k.id, { url: "https://api.newhost.example./again" }));
    expect((await approveHostApproval(sqlite, db, again.id)).approval.status).toBe("approved");
    const bare = key(db, { name: "bare", allowedHosts: ["bare.example"] });
    const b = createHostApproval(sqlite, db, ask(bare.id, { url: "https://bare.example.:8443/x" }));
    await approveHostApproval(sqlite, db, b.id);
    expect(allowed(db, k.id)).toEqual(["known.example:443", "api.newhost.example:443"]);
    expect(allowed(db, bare.id)).toEqual(["bare.example"]);
  });
});

describe("createHostApproval", () => {
  it("is a pending 'host' approval bound to key/url/method/body hash, with no price and the usual 10 minute TTL", () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    const before = Date.now();
    const a = createHostApproval(sqlite, db, ask(k.id, { method: "POST", body: { q: 1 } }));
    expect(a).toMatchObject({ keyId: k.id, url: URL_NEW, method: "POST", kind: "host", status: "pending", network: "", asset: "", payTo: "", amount: 0n });
    expect(a.bodySha256).toBe(createHash("sha256").update('{"q":1}', "utf8").digest("hex"));
    expect(a.bodySha256).toBe(sha256OfBody({ q: 1 }));
    expect(new Date(a.expiresAt).getTime() - before).toBeGreaterThanOrEqual(APPROVAL_TTL_MS - 1000);
    expect(new Date(a.expiresAt).getTime() - before).toBeLessThanOrEqual(APPROVAL_TTL_MS + 5000);
    expect(getApproval(db, a.id)).toEqual(a);
  });

  it("a payment approval created the old way is still kind 'payment'", () => {
    const { db } = freshDb();
    const k = key(db);
    const p = createApproval(db, { keyId: k.id, url: URL_NEW, method: "GET", body: undefined, network: "n", asset: "a", payTo: "0xpay", amount: 5n });
    expect(p.kind).toBe("payment");
    expect(getApproval(db, p.id)!.kind).toBe("payment");
  });

  it("asking again for the same host:port returns the same pending approval, whatever the path, query, case or method of the later request", () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    const a = createHostApproval(sqlite, db, ask(k.id));
    expect(createHostApproval(sqlite, db, ask(k.id)).id).toBe(a.id);
    expect(createHostApproval(sqlite, db, ask(k.id, { url: "https://API.NewHost.example/other/path" })).id).toBe(a.id);
    expect(createHostApproval(sqlite, db, ask(k.id, { url: "https://api.newhost.example:443/x", method: "POST", body: { q: 1 } })).id).toBe(a.id);
    expect(sqlite.prepare("SELECT count(*) AS n FROM approvals").get()).toEqual({ n: 1 });
    // the one that was waiting is returned as it was made: url, method and body hash are the first request's
    expect(createHostApproval(sqlite, db, ask(k.id, { url: "https://api.newhost.example/other", method: "POST" }))).toEqual(a);
  });

  it("another port, another scheme's port, another host or another key is another approval", () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    const other = key(db, { name: "other" });
    const a = createHostApproval(sqlite, db, ask(k.id));
    const ids = new Set([
      a.id,
      createHostApproval(sqlite, db, ask(k.id, { url: "https://api.newhost.example:8443/x" })).id,
      createHostApproval(sqlite, db, ask(k.id, { url: "http://api.newhost.example/x" })).id,
      createHostApproval(sqlite, db, ask(k.id, { url: "https://other.newhost.example/x" })).id,
      createHostApproval(sqlite, db, ask(other.id)).id,
    ]);
    expect(ids.size).toBe(5);
  });

  it("a denied or expired approval no longer stands for its host: a new one is made", () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    const first = createHostApproval(sqlite, db, ask(k.id));
    decideApproval(db, first.id, "denied");
    const second = createHostApproval(sqlite, db, ask(k.id));
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("pending");
    sqlite.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), second.id);
    const third = createHostApproval(sqlite, db, ask(k.id));
    expect(third.id).not.toBe(second.id);
    expect(third.status).toBe("pending");
  });

  it(`a key holds at most ${MAX_PENDING_HOST_APPROVALS} pending new hosts: the next one is RATE_LIMITED and nothing is created`, () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    const mine = Array.from({ length: MAX_PENDING_HOST_APPROVALS }, (_, i) => createHostApproval(sqlite, db, ask(k.id, { url: `https://h${i}.example/x` })));
    expect(MAX_PENDING_HOST_APPROVALS).toBe(5);
    let err: unknown;
    try {
      createHostApproval(sqlite, db, ask(k.id, { url: "https://h5.example/x" }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MoneySwitchError);
    expect((err as MoneySwitchError).code).toBe("RATE_LIMITED");
    // it is this key's own limit, said the way the per-minute one is: limit_scope "self" and the key's prefix
    expect((err as MoneySwitchError).limit).toEqual({ scope: "self", keyPrefix: k.keyPrefix });
    expect(limitFields(err)).toEqual({ limit_scope: "self", limit_key_prefix: k.keyPrefix });
    expect(sqlite.prepare("SELECT count(*) AS n FROM approvals").get()).toEqual({ n: 5 });
    // a host that is already waiting is not a new host: it still gets its own approval back
    expect(createHostApproval(sqlite, db, ask(k.id, { url: "https://h3.example/y" })).id).toBe(mine[3].id);
    // the limit is per key
    const other = key(db, { name: "other" });
    expect(createHostApproval(sqlite, db, ask(other.id, { url: "https://h5.example/x" })).status).toBe("pending");
  });

  it("only unexpired pending host approvals count: a decision or an expiry frees a place; payment approvals never take one", () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    for (let i = 0; i < 3; i++) createApproval(db, { keyId: k.id, url: `https://pay${i}.example/x`, method: "GET", body: undefined, network: "n", asset: "a", payTo: "0xpay", amount: 5n });
    const hosts = Array.from({ length: 5 }, (_, i) => createHostApproval(sqlite, db, ask(k.id, { url: `https://h${i}.example/x` })));
    expect(() => createHostApproval(sqlite, db, ask(k.id, { url: "https://new1.example/x" }))).toThrow("RATE_LIMITED");
    decideApproval(db, hosts[0].id, "denied");
    expect(createHostApproval(sqlite, db, ask(k.id, { url: "https://new1.example/x" })).status).toBe("pending");
    expect(() => createHostApproval(sqlite, db, ask(k.id, { url: "https://new2.example/x" }))).toThrow("RATE_LIMITED");
    sqlite.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), hosts[1].id); // not yet swept: still 'pending' in the table
    expect(createHostApproval(sqlite, db, ask(k.id, { url: "https://new2.example/x" })).status).toBe("pending");
    expect(() => createHostApproval(sqlite, db, ask(k.id, { url: "https://new3.example/x" }))).toThrow("RATE_LIMITED");
  });
});

describe("approveHostApproval", () => {
  it("adds the host:port (lower-case, port explicit) to the key's allowed hosts, approves the approval and audits it, all together", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    const a = createHostApproval(sqlite, db, ask(k.id, { url: "https://API.NewHost.example/v1/data?x=1" }));
    const { approval, host } = await approveHostApproval(sqlite, db, a.id);
    expect(host).toBe("api.newhost.example:443");
    expect(approval).toMatchObject({ id: a.id, status: "approved", kind: "host" });
    expect(approval.decidedAt).not.toBeNull();
    expect(getApproval(db, a.id)!.status).toBe("approved");
    expect(allowed(db, k.id)).toEqual(["known.example:443", "api.newhost.example:443"]);
    const audit = listAudit(db).filter((r) => r.action === "key.allow_host");
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe("admin");
    expect(audit[0].detail).toEqual({ keyId: k.id, host: "api.newhost.example:443", approvalId: a.id });
    expect(dns.calls).toEqual(["api.newhost.example"]);
  });

  it("an http URL lists port 80, an explicit port is kept", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db, { allowedHosts: [] });
    const a = createHostApproval(sqlite, db, ask(k.id, { url: "http://Seller.Example/x" }));
    const b = createHostApproval(sqlite, db, ask(k.id, { url: "https://seller.example:8443/x" }));
    await approveHostApproval(sqlite, db, a.id);
    await approveHostApproval(sqlite, db, b.id);
    expect(allowed(db, k.id)).toEqual(["seller.example:80", "seller.example:8443"]);
  });

  it("is idempotent: a host that is already listed (as host:port or as the bare host) is not added twice, and the approval is still approved", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db, { allowedHosts: ["known.example:443", "api.newhost.example:443", "bare.example"] });
    for (const url of ["https://api.newhost.example/x", "https://bare.example:8443/x"]) {
      const a = createHostApproval(sqlite, db, ask(k.id, { url }));
      expect((await approveHostApproval(sqlite, db, a.id)).approval.status).toBe("approved");
    }
    expect(allowed(db, k.id)).toEqual(["known.example:443", "api.newhost.example:443", "bare.example"]);
  });

  it("approving the same approval twice is refused the second time and adds nothing more", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    const a = createHostApproval(sqlite, db, ask(k.id));
    await approveHostApproval(sqlite, db, a.id);
    expect((await refusal(approveHostApproval(sqlite, db, a.id))).code).toBe("APPROVAL_NOT_PENDING");
    expect(allowed(db, k.id)).toEqual(["known.example:443", "api.newhost.example:443"]);
    expect(auditActions(db).filter((x) => x === "key.allow_host")).toHaveLength(1);
  });

  it("only the key's own list grows: another key's list, and the approval's decision for a deny, are untouched", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    const other = key(db, { name: "other" });
    const a = createHostApproval(sqlite, db, ask(k.id));
    await approveHostApproval(sqlite, db, a.id);
    expect(allowed(db, other.id)).toEqual(["known.example:443"]);
    const d = createHostApproval(sqlite, db, ask(k.id, { url: "https://denied.example/x" }));
    decideApproval(db, d.id, "denied"); // deny is the plain decision, unchanged
    expect(allowed(db, k.id)).toEqual(["known.example:443", "api.newhost.example:443"]);
  });

  it("a child key's approval is refused: nothing is added, the approval stays pending, no DNS look is made", async () => {
    const { db, sqlite } = freshDb();
    const parent = key(db);
    const { row: child } = createChildKey(db, parent.id, { name: "child", dailyBudget: usdc("1"), totalBudget: usdc("10"), perRequestLimit: usdc("0.5") }, { maxDepth: 3 });
    const a = createHostApproval(sqlite, db, ask(child.id));
    expect((await refusal(approveHostApproval(sqlite, db, a.id))).code).toBe("ALLOW_HOST_CHILD_KEY");
    expect(getApproval(db, a.id)!.status).toBe("pending");
    expect(allowed(db, child.id)).toEqual(allowed(db, parent.id));
    expect(allowed(db, parent.id)).toEqual(["known.example:443"]);
    expect(auditActions(db)).not.toContain("key.allow_host");
    expect(dns.calls).toEqual([]);
  });

  it("a revoked key, an expired approval, a decided approval, a payment approval and an unknown id are refused", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    const revoked = key(db, { name: "revoked" });
    const forRevoked = createHostApproval(sqlite, db, ask(revoked.id));
    revokeMoneyKey(db, revoked.id);
    expect((await refusal(approveHostApproval(sqlite, db, forRevoked.id))).code).toBe("ALLOW_HOST_KEY_NOT_ACTIVE");

    const stale = createHostApproval(sqlite, db, ask(k.id, { url: "https://stale.example/x" }));
    sqlite.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), stale.id);
    expect((await refusal(approveHostApproval(sqlite, db, stale.id))).code).toBe("APPROVAL_NOT_PENDING");

    const denied = createHostApproval(sqlite, db, ask(k.id, { url: "https://denied.example/x" }));
    decideApproval(db, denied.id, "denied");
    expect((await refusal(approveHostApproval(sqlite, db, denied.id))).code).toBe("APPROVAL_NOT_PENDING");

    const payment = createApproval(db, { keyId: k.id, url: "https://pay.example/x", method: "GET", body: undefined, network: "n", asset: "a", payTo: "0xpay", amount: 5n });
    expect((await refusal(approveHostApproval(sqlite, db, payment.id))).code).toBe("APPROVAL_NOT_PENDING");
    expect(getApproval(db, payment.id)!.status).toBe("pending");

    expect((await refusal(approveHostApproval(sqlite, db, "no-such-id"))).code).toBe("APPROVAL_NOT_FOUND");
    expect(allowed(db, k.id)).toEqual(["known.example:443"]);
    expect(allowed(db, revoked.id)).toEqual(["known.example:443"]);
  });

  it("a name that resolves to a private address is refused with ALLOW_HOST_PRIVATE_HOST, nothing is added and the approval stays pending", async () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "100.100.100.200", "192.168.1.1", "::1", "fd00::1", "::ffff:10.0.0.1", "64:ff9b::a00:1"]) {
      const { db, sqlite } = freshDb();
      const k = key(db);
      dns.answers.set("api.newhost.example", [address]);
      const a = createHostApproval(sqlite, db, ask(k.id));
      const err = await refusal(approveHostApproval(sqlite, db, a.id));
      expect(err.code, address).toBe("ALLOW_HOST_PRIVATE_HOST");
      expect(err.message).toContain("api.newhost.example");
      expect(getApproval(db, a.id)!.status, address).toBe("pending");
      expect(allowed(db, k.id), address).toEqual(["known.example:443"]);
      expect(auditActions(db), address).not.toContain("key.allow_host");
    }
  });

  it("one private address among public ones is enough to refuse", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    dns.answers.set("api.newhost.example", ["93.184.216.34", "2606:4700:4700::1111", "10.0.0.5"]);
    const a = createHostApproval(sqlite, db, ask(k.id));
    expect((await refusal(approveHostApproval(sqlite, db, a.id))).code).toBe("ALLOW_HOST_PRIVATE_HOST");
    expect(getApproval(db, a.id)!.status).toBe("pending");
    // every address public: approved
    dns.answers.set("api.newhost.example", ["93.184.216.34", "2606:4700:4700::1111"]);
    expect((await approveHostApproval(sqlite, db, a.id)).approval.status).toBe("approved");
  });

  /** What os.networkInterfaces() answers: this machine has exactly these addresses. */
  const machineHas = (...addresses: string[]) =>
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      eth0: addresses.map((address) => ({ address, netmask: "255.255.255.0", family: address.includes(":") ? "IPv6" : "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: null })),
    } as never);

  it("an address bound to one of this machine's own network interfaces is refused like a private one, in any spelling; an address that is not stays fine", async () => {
    const nics = machineHas("151.101.1.69", "2606:4700:4700::1111"); // both public: only the interface list says they are "ours"
    try {
      for (const answer of [["151.101.1.69"], ["93.184.216.34", "151.101.1.69"], ["::ffff:151.101.1.69"], ["2606:4700:4700::1111"], ["93.184.216.34", "2606:4700:4700::1111"]]) {
        const { db, sqlite } = freshDb();
        const k = key(db);
        dns.answers.set("api.newhost.example", answer);
        const a = createHostApproval(sqlite, db, ask(k.id));
        const err = await refusal(approveHostApproval(sqlite, db, a.id));
        expect(err.code, answer.join()).toBe("ALLOW_HOST_PRIVATE_HOST");
        expect(err.message).toContain("api.newhost.example");
        expect(getApproval(db, a.id)!.status, answer.join()).toBe("pending");
        expect(allowed(db, k.id), answer.join()).toEqual(["known.example:443"]);
        expect(auditActions(db), answer.join()).not.toContain("key.allow_host");
      }
      // a literal address of this machine, too (its "look" answers itself)
      {
        const { db, sqlite } = freshDb();
        const k = key(db);
        dns.answers.set("151.101.1.69", ["151.101.1.69"]);
        const a = createHostApproval(sqlite, db, ask(k.id, { url: "http://151.101.1.69:8080/x" }));
        expect((await refusal(approveHostApproval(sqlite, db, a.id))).code).toBe("ALLOW_HOST_PRIVATE_HOST");
        expect(allowed(db, k.id)).toEqual(["known.example:443"]);
      }
      // the same name with an answer that is not on the machine: approved
      const { db, sqlite } = freshDb();
      const k = key(db);
      dns.answers.set("api.newhost.example", ["151.101.1.70", "2606:4700:4700::1112"]);
      const a = createHostApproval(sqlite, db, ask(k.id));
      expect((await approveHostApproval(sqlite, db, a.id)).approval.status).toBe("approved");
      expect(nics).toHaveBeenCalled();
    } finally {
      nics.mockRestore();
    }
  });

  it("a literal private address or localhost name in the approval is refused without any DNS look", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    for (const url of ["http://100.100.100.200/x", "http://[::1]/x", "http://[::ffff:10.0.0.1]/x", "http://localhost/x", "http://api.localhost:8080/x"]) {
      const a = createApproval(db, { keyId: k.id, url, method: "GET", body: undefined, network: "", asset: "", payTo: "", amount: 0n, kind: "host" });
      expect((await refusal(approveHostApproval(sqlite, db, a.id))).code, url).toBe("ALLOW_HOST_PRIVATE_HOST");
      expect(getApproval(db, a.id)!.status).toBe("pending");
    }
    expect(dns.calls).toEqual([]);
    expect(allowed(db, k.id)).toEqual(["known.example:443"]);
  });

  it("a public literal address is looked up like any host (no network for an address) and is approved", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    dns.answers.set("93.184.216.34", ["93.184.216.34"]);
    const a = createHostApproval(sqlite, db, ask(k.id, { url: "http://93.184.216.34:8080/x" }));
    expect((await approveHostApproval(sqlite, db, a.id)).host).toBe("93.184.216.34:8080");
    expect(allowed(db, k.id)).toContain("93.184.216.34:8080");
  });

  it("a failed DNS look fails closed: ALLOW_HOST_UNRESOLVED, nothing is added, the approval stays pending and can be approved later", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    dns.failing.add("api.newhost.example");
    const a = createHostApproval(sqlite, db, ask(k.id));
    const err = await refusal(approveHostApproval(sqlite, db, a.id));
    expect(err.code).toBe("ALLOW_HOST_UNRESOLVED");
    expect(err.message).toBe("api.newhost.example could not be resolved (lookup failed, empty, or over 3 s): nothing was added, and the request stays waiting for approval");
    expect(getApproval(db, a.id)!.status).toBe("pending");
    expect(allowed(db, k.id)).toEqual(["known.example:443"]);
    expect(auditActions(db)).not.toContain("key.allow_host");
    dns.failing.clear();
    expect((await approveHostApproval(sqlite, db, a.id)).approval.status).toBe("approved");
    expect(allowed(db, k.id)).toContain("api.newhost.example:443");
  });

  it("an empty DNS answer is a failure too", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    dns.answers.set("api.newhost.example", []);
    const a = createHostApproval(sqlite, db, ask(k.id));
    expect((await refusal(approveHostApproval(sqlite, db, a.id))).code).toBe("ALLOW_HOST_UNRESOLVED");
    expect(getApproval(db, a.id)!.status).toBe("pending");
  });

  it(`a DNS look that does not answer within ${HOST_LOOKUP_TIMEOUT_MS} ms fails closed`, async () => {
    expect(HOST_LOOKUP_TIMEOUT_MS).toBe(3000);
    const { db, sqlite } = freshDb();
    const k = key(db);
    const a = createHostApproval(sqlite, db, ask(k.id));
    dns.hang = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outcome = refusal(approveHostApproval(sqlite, db, a.id));
    await vi.advanceTimersByTimeAsync(HOST_LOOKUP_TIMEOUT_MS - 1);
    expect(getApproval(db, a.id)!.status).toBe("pending"); // still waiting for the look, nothing decided yet
    await vi.advanceTimersByTimeAsync(1);
    expect((await outcome).code).toBe("ALLOW_HOST_UNRESOLVED");
    expect(getApproval(db, a.id)!.status).toBe("pending");
    expect(allowed(db, k.id)).toEqual(["known.example:443"]);
    expect(auditActions(db)).not.toContain("key.allow_host");
  });

  it("what is decided while the DNS look is under way is checked again in the transaction: a denied approval adds nothing", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    const a = createHostApproval(sqlite, db, ask(k.id));
    dns.hook = () => decideApproval(db, a.id, "denied");
    expect((await refusal(approveHostApproval(sqlite, db, a.id))).code).toBe("APPROVAL_NOT_PENDING");
    expect(getApproval(db, a.id)!.status).toBe("denied");
    expect(allowed(db, k.id)).toEqual(["known.example:443"]);
    expect(auditActions(db)).not.toContain("key.allow_host");
  });

  it("a key revoked while the look is under way gets nothing either", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    const a = createHostApproval(sqlite, db, ask(k.id));
    dns.hook = () => revokeMoneyKey(db, k.id);
    expect((await refusal(approveHostApproval(sqlite, db, a.id))).code).toBe("ALLOW_HOST_KEY_NOT_ACTIVE");
    expect(getApproval(db, a.id)!.status).toBe("pending");
    expect(allowed(db, k.id)).toEqual(["known.example:443"]);
  });

  it("the approval and the list change together: when the transaction fails, neither does", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    const a = createHostApproval(sqlite, db, ask(k.id));
    // an audit table that cannot be written takes the whole transaction down
    sqlite.exec("ALTER TABLE audit_log RENAME TO audit_log_gone");
    await expect(approveHostApproval(sqlite, db, a.id)).rejects.toThrow();
    sqlite.exec("ALTER TABLE audit_log_gone RENAME TO audit_log");
    expect(getApproval(db, a.id)!.status).toBe("pending");
    expect(allowed(db, k.id)).toEqual(["known.example:443"]);
    expect(sqlite.inTransaction).toBe(false);
    expect((await approveHostApproval(sqlite, db, a.id)).approval.status).toBe("approved");
  });
});

describe("a host approval is never a payment approval", () => {
  it("validateApprovalForUse refuses it, however well it matches the request", async () => {
    const { db, sqlite } = freshDb();
    const k = key(db);
    const a = createHostApproval(sqlite, db, ask(k.id));
    await approveHostApproval(sqlite, db, a.id);
    expect(() => validateApprovalForUse(db, a.id, { keyId: k.id, url: URL_NEW, method: "GET", body: undefined, network: "", asset: "", payTo: "", amount: 0n })).toThrow("APPROVAL_INVALID");
  });

  it("a payment approval still validates as before", () => {
    const { db } = freshDb();
    const k = key(db);
    const p = createApproval(db, { keyId: k.id, url: URL_NEW, method: "GET", body: undefined, network: "n", asset: "a", payTo: "0xPay", amount: 5n });
    decideApproval(db, p.id, "approved");
    expect(validateApprovalForUse(db, p.id, { keyId: k.id, url: URL_NEW, method: "GET", body: undefined, network: "n", asset: "a", payTo: "0xpay", amount: 5n }).id).toBe(p.id);
  });
});
