import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { createDefaultRpcTransport } from "@solana/kit";
import { installOutboundProxy, closeOutboundProxy } from "@moneyswitch/net";

// Resolve the same Undici copy used by MoneySwitch's global routing dispatcher,
// rather than adding another version or replacing Node's native fetch.
const netRequire = createRequire(import.meta.resolve("@moneyswitch/net"));
const { getGlobalDispatcher, setGlobalDispatcher } = netRequire("undici");
const received: Array<{ rawHeaders: string[]; body: Buffer }> = [];
let server: http.Server;
let url: string;
let previousGlobal: ReturnType<typeof getGlobalDispatcher>;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      received.push({ rawHeaders: request.rawHeaders, body });
      let payload;
      try { payload = JSON.parse(body.toString("utf8")); }
      catch { response.writeHead(400).end(); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "local-rpc-ok" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  previousGlobal = getGlobalDispatcher();
  // The production routing dispatcher always bypasses proxies for loopback.
  installOutboundProxy({ env: { MONEYSWITCH_PROXY: "http://127.0.0.1:1" }, platform: "linux" });
  expect(getGlobalDispatcher()).not.toBe(previousGlobal);
});

afterAll(async () => {
  if (previousGlobal) setGlobalDispatcher(previousGlobal);
  server?.closeAllConnections();
  await closeOutboundProxy();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Solana Kit transport through Node fetch and MoneySwitch's Undici dispatcher", () => {
  it.each([
    { name: "ASCII", owner: "11111111111111111111111111111111" },
    { name: "Chinese Unicode", owner: "员工-中文💡" },
  ])("sends a single correct UTF-8 content-length for $name RPC input", async ({ name, owner }) => {
    const payload = { jsonrpc: "2.0", id: "rpc-regression", method: "getAccountInfo", params: [owner] };
    const before = received.length;
    const transport = createDefaultRpcTransport({ url });
    const result = await transport({ payload, signal: AbortSignal.timeout(2_000) });
    expect(result).toMatchObject({ jsonrpc: "2.0", result: "local-rpc-ok" });
    expect(received).toHaveLength(before + 1);
    const request = received[before];
    const lengthHeaders = request.rawHeaders.flatMap((header, i, all) =>
      i % 2 === 0 && header.toLowerCase() === "content-length" ? [all[i + 1]] : []);
    expect(lengthHeaders).toEqual([String(request.body.byteLength)]);
    expect(JSON.parse(request.body.toString("utf8"))).toMatchObject({ jsonrpc: "2.0", method: "getAccountInfo", params: [owner] });

    if (name === "Chinese Unicode") {
      expect(request.body.byteLength).toBeGreaterThan(request.body.toString("utf8").length);
    }
  }, 5_000);
});
