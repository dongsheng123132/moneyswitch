/** Where the resolved outbound proxy came from (priority order, highest first). */
export type ProxySource = "MONEYSWITCH_PROXY" | "env" | "windows-system" | "none";

export interface ProxyResolution {
  /** Full proxy URL (e.g. "http://127.0.0.1:7897"), or null when no proxy applies. */
  url: string | null;
  source: ProxySource;
  /**
   * Hostnames / patterns that always bypass the proxy, on top of the
   * hard-coded loopback + private ranges (which are never overridable):
   * NO_PROXY/no_proxy entries, plus ProxyOverride entries on Windows.
   */
  noProxy: string[];
}
