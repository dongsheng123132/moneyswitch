export type { ProxyResolution, ProxySource } from "./types.js";
export { resolveOutboundProxy, type ResolveOutboundProxyOptions } from "./resolve.js";
export { installOutboundProxy, getInstalledOutboundProxy, redactProxyUrl, hostPortOf } from "./install.js";
export { isAlwaysDirectHost, matchesNoProxyEntry, shouldBypassProxy } from "./bypass.js";
export {
  parseProxyServerValue,
  parseProxyOverride,
  readWindowsSystemProxy,
  defaultRegQuery,
  type RegQueryFn,
  type RegValueName,
  type WindowsSystemProxy,
} from "./windows-proxy.js";
