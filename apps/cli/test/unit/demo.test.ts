import { describe, it, expect } from "vitest";
import { buildDemoInvocation, looksLikePackageNotFound, isOfficialRegistry, DEMO_HELP } from "../../src/demo.js";
import { parseTopArgv, TOP_HELP } from "../../src/cli.js";

describe("moneyswitch demo", () => {
  it("dispatches demo + --version", () => {
    expect(parseTopArgv(["demo", "--no-open"])).toEqual({ kind: "demo", args: ["--no-open"] });
    expect(parseTopArgv(["--version"])).toEqual({ kind: "version" });
  });

  it("runs the matching moneyswitch-server version through npx, passing args through", () => {
    const inv = buildDemoInvocation(["--port", "4100", "--no-open"], {}, "0.5.1");
    expect(inv.spec).toBe("moneyswitch-server@0.5.1");
    expect(inv.npxArgs).toEqual(["-y", "--package=moneyswitch-server@0.5.1", "--", "moneyswitch-server", "demo", "--port", "4100", "--no-open"]);
    expect(inv.registry).toBeNull();
  });

  it("--registry goes to npx, not to the demo", () => {
    for (const args of [["--registry=https://registry.npmjs.org/"], ["--registry", "https://registry.npmjs.org/"]]) {
      const inv = buildDemoInvocation(args, {}, "0.5.1");
      expect(inv.registry).toBe("https://registry.npmjs.org/");
      expect(inv.npxArgs).toEqual(["-y", "--registry=https://registry.npmjs.org/", "--package=moneyswitch-server@0.5.1", "--", "moneyswitch-server", "demo"]);
    }
  });

  it("MONEYSWITCH_SERVER_SPEC overrides the package spec (e.g. a local tarball)", () => {
    const inv = buildDemoInvocation([], { MONEYSWITCH_SERVER_SPEC: "C:/tmp/moneyswitch-server-0.5.1.tgz" }, "0.5.1");
    expect(inv.spec).toBe("C:/tmp/moneyswitch-server-0.5.1.tgz");
    expect(inv.npxArgs).toContain("--package=C:/tmp/moneyswitch-server-0.5.1.tgz");
  });

  it("detects npm not-found errors and the official registry", () => {
    expect(looksLikePackageNotFound("npm error code E404\nnpm error 404 Not Found - GET https://registry.npmmirror.com/moneyswitch-server")).toBe(true);
    expect(looksLikePackageNotFound("npm error code ETARGET\nnpm error notarget No matching version found for moneyswitch-server@0.5.1.")).toBe(true);
    expect(looksLikePackageNotFound("[demo] failed to start: EADDRINUSE")).toBe(false);
    expect(isOfficialRegistry("https://registry.npmjs.org/")).toBe(true);
    expect(isOfficialRegistry("https://registry.npmmirror.com")).toBe(false);
  });

  it("help says it downloads the AGPL server package", () => {
    expect(DEMO_HELP).toContain("AGPL-3.0-only");
    expect(DEMO_HELP).toContain("moneyswitch-server");
    expect(TOP_HELP).toContain("moneyswitch demo");
    expect(TOP_HELP).toContain("AGPL-3.0-only");
  });
});
