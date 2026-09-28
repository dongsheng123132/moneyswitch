// Spawned by test/exit.test.ts — NOT run directly by vitest. Imports the
// built @moneyswitch/net (dist/install.js, same as any consumer would) so
// this exercises the real RoutingDispatcher/ProxyAgent code path, not a
// mock. Starts a local HTTP "target" server plus a tiny local CONNECT-
// capable "proxy" server (so the test needs no real network access), calls
// installOutboundProxy() pointed at that local proxy, does one fetch
// through the proxy and one direct fetch to the local target, then lets
// main() return with no explicit process.exit() call — the exact shape of
// the script that reproduced "Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c" on Windows
// (Node 24.19) before packages/net/src/install.ts started closing the
// dispatcher on `beforeExit`. Prints one JSON line to stdout so the test
// can assert on the observed statuses; the thing actually under test is
// this process's own exit code, asserted by the parent.
import http from "node:http";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const { installOutboundProxy } = await import(
  pathToFileURL(path.join(here, "..", "..", "dist", "install.js")).href
);

function startTarget() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok-from-target");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Minimal CONNECT proxy that always tunnels to the local target, regardless
 * of the requested CONNECT host — lets the fixture use a non-private
 * hostname (so it's actually routed through the ProxyAgent, not bypassed)
 * without needing real DNS/internet. */
function startProxy(targetPort) {
  const server = http.createServer((_req, res) => {
    res.writeHead(501);
    res.end();
  });
  server.on("connect", (req, clientSocket, head) => {
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const target = await startTarget();
const targetPort = target.address().port;
const proxy = await startProxy(targetPort);
const proxyPort = proxy.address().port;

const resolution = installOutboundProxy({ env: { MONEYSWITCH_PROXY: `http://127.0.0.1:${proxyPort}` } });

const viaProxy = await fetch(`http://fake-external.invalid:${targetPort}/`);
const viaProxyBody = await viaProxy.text();
const direct = await fetch(`http://127.0.0.1:${targetPort}/`);
const directBody = await direct.text();

await new Promise((resolve) => target.close(resolve));
await new Promise((resolve) => proxy.close(resolve));

process.stdout.write(
  JSON.stringify({
    resolutionSource: resolution.source,
    viaProxyStatus: viaProxy.status,
    viaProxyBody,
    directStatus: direct.status,
    directBody,
  }) + "\n"
);
// Deliberately no process.exit() call here: the point of this fixture is to
// let the process exit *naturally* once the event loop is empty.
