import type { ServerConfig } from "./config.js";
import type { AppContext } from "./context.js";

/**
 * The address every link the server builds for itself points at: the approve_url that /v1/fetch hands out (and the skill tells the AI
 * to pass on to a person), the base of /skill.md, the public_base the Dashboard reads, the first-run sign-in link.
 *
 * It is MONEYSWITCH_PUBLIC_URL, else the address this server itself listens on. NEVER anything from the request (Host,
 * X-Forwarded-*, Origin): the sender chooses those, and a link the server presents as its own that can be steered to another site is a
 * phishing path for the administrator token.
 */

/** The host part of a URL a person can open: a wildcard bind address means "this machine". */
function browsableHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "") return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

/** The address the server listens on, as a URL. */
export function bindOrigin(config: Pick<ServerConfig, "host" | "port">): string {
  return `http://${browsableHost(config.host)}:${config.port}`;
}

export function publicBaseUrl(config: Pick<ServerConfig, "host" | "port"> & { publicUrl?: string | null }): string {
  return config.publicUrl?.replace(/\/+$/, "") || bindOrigin(config);
}

export function publicBase(ctx: AppContext): string {
  return publicBaseUrl(ctx.config);
}
