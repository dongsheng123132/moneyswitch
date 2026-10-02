export type { ProxyResolution, ProxySource } from "./types.js";
export { resolveOutboundProxy, type ResolveOutboundProxyOptions } from "./resolve.js";
export { installOutboundProxy, getInstalledOutboundProxy, closeOutboundProxy, redactProxyUrl, hostPortOf } from "./install.js";
export { isAlwaysDirectHost, matchesNoProxyEntry, shouldBypassProxy } from "./bypass.js";
export { callerDeadlineDispatcher } from "./caller-deadline.js";
export {
  parseProxyServerValue,
  parseProxyOverride,
  readWindowsSystemProxy,
  defaultRegQuery,
  type RegQueryFn,
  type RegValueName,
  type WindowsSystemProxy,
} from "./windows-proxy.js";
