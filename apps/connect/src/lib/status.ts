/**
 * SPEC-v0.3-employee.md §B.2 step 1: verify a MoneyKey against GET /v1/status.
 */
export interface StatusResult {
  ok: boolean;
  httpStatus: number;
  body: unknown;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchStatus(
  server: string,
  key: string,
  fetchImpl: FetchLike = fetch
): Promise<StatusResult> {
  const base = server.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/v1/status`, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, httpStatus: res.status, body };
}
