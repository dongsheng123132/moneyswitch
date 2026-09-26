import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { COOKIE_NAME, guardRequest, readCookie, SessionManager } from "./session.js";
import { DesktopService, UserError } from "./service.js";
import { ALL_AGENTS, type AgentId } from "./plan.js";

export interface UiServerOptions {
  port: number;
  service: DesktopService;
  /** Directory with index.html / app.js / app.css (dist/ui). */
  assetsDir: string;
  sessions?: SessionManager;
  log?: (line: string) => void;
}

const MAX_BODY = 64 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", ...extra });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new UserError(413, "TOO_LARGE", "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        const v = JSON.parse(raw);
        resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {});
      } catch {
        reject(new UserError(400, "BAD_JSON", "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveAsset(res: http.ServerResponse, assetsDir: string, urlPath: string) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  if (!/^[A-Za-z0-9._-]+$/.test(rel)) return send(res, 404, { error: "NOT_FOUND" });
  const file = path.join(assetsDir, rel);
  if (!fs.existsSync(file)) return send(res, 404, { error: "NOT_FOUND" });
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

function agentParam(v: string): AgentId {
  if (!(ALL_AGENTS as string[]).includes(v)) throw new UserError(404, "UNKNOWN_AGENT", "unknown agent");
  return v as AgentId;
}

export function createUiServer(opts: UiServerOptions) {
  const sessions = opts.sessions ?? new SessionManager(opts.port);
  const svc = opts.service;
  const log = opts.log ?? (() => undefined);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    try {
      const denied = guardRequest(sessions, { method, headers: req.headers, url: p });
      if (denied) return send(res, denied.status, { error: denied.code, message: denied.message });

      if (!p.startsWith("/api/")) {
        if (method !== "GET" && method !== "HEAD") return send(res, 405, { error: "METHOD_NOT_ALLOWED" });
        return serveAsset(res, opts.assetsDir, p);
      }

      // Log method + path only: never bodies, tokens or keys.
      log(`${method} ${p}`);
      const body = method === "GET" ? {} : await readBody(req);
      const m = (re: RegExp) => re.exec(p);
      let r: RegExpExecArray | null;

      if (method === "POST" && p === "/api/session") {
        const sid = sessions.exchange(body.token);
        if (!sid) return send(res, 401, { error: "BAD_TOKEN", message: "this link was already used or is wrong; run `moneyswitch ui` again" });
        return send(res, 200, { ok: true }, { "Set-Cookie": sessions.cookieHeader(sid) });
      }
      if (method === "POST" && p === "/api/logout") {
        const sid = readCookie(req.headers.cookie, COOKIE_NAME);
        if (sid) sessions.revoke(sid);
        return send(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (method === "GET" && p === "/api/state") return send(res, 200, await svc.state());
      if (method === "GET" && p === "/api/usage") return send(res, 200, await svc.usage());
      if (method === "POST" && p === "/api/detect") {
        svc.detect(true);
        return send(res, 200, await svc.state());
      }
      if (method === "PUT" && p === "/api/account") return send(res, 200, await svc.setAccount(body.server, body.key));
      if (method === "DELETE" && p === "/api/account") return send(res, 200, await svc.clearAccount());
      if (method === "POST" && p === "/api/bulk/preview") return send(res, 200, await svc.bulkPreview());
      if (method === "POST" && p === "/api/bulk/apply") return send(res, 200, await svc.bulkApply(body.planId));

      if ((r = m(/^\/api\/agents\/([a-z]+)\/(brain|brain\/test|wallet|wallet\/child|preview|apply)$/))) {
        const agent = agentParam(r[1]);
        const what = r[2];
        if (method === "PUT" && what === "brain") return send(res, 200, await svc.saveBrain(agent, body));
        if (method === "POST" && what === "brain/test") return send(res, 200, await svc.testBrain(agent, body));
        if (method === "POST" && what === "wallet/child") return send(res, 200, await svc.createChild(agent, body));
        if (method === "PUT" && what === "wallet") return send(res, 200, await svc.pasteWallet(agent, body));
        if (method === "DELETE" && what === "wallet") return send(res, 200, await svc.clearWallet(agent, body));
        if (method === "POST" && what === "preview") return send(res, 200, await svc.preview(agent, body.action));
        if (method === "POST" && what === "apply") return send(res, 200, await svc.apply(agent, body.action, body.planId));
      }
      return send(res, 404, { error: "NOT_FOUND" });
    } catch (e) {
      if (e instanceof UserError) return send(res, e.status, { error: e.code, message: e.message, detail: e.detail ?? null });
      log(`error ${method} ${p}: ${(e as Error).message}`);
      return send(res, 500, { error: "INTERNAL", message: (e as Error).message });
    }
  });
  return { server, sessions };
}
