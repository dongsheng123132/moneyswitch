/**
 * Request-body encoding for paid fetches (CONTRACT: /v1/fetch body encoding).
 *
 *   - a string is sent VERBATIM (the caller already encoded it);
 *   - anything else (object, array, number, boolean, null) is sent as
 *     JSON.stringify(body), and gets `content-type: application/json` unless
 *     the caller already set a content-type (any header casing);
 *   - `undefined` means "no body".
 *
 * This is the single source of truth for what goes on the wire AND for what an
 * approval's body_sha256 binds to (see sha256OfBody in approval.ts): the hash
 * is taken over exactly the bytes the seller will receive, so an approved retry
 * of the same request always matches, and a different wire body never does.
 */
export function encodeRequestBody(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

export interface ResolvedRequestBody {
  body: string | undefined;
  headers: Record<string, string> | undefined;
}

/** Wire body plus the headers to send with it (adds application/json for non-string bodies when the caller set no content-type). */
export function resolveRequestBody(
  body: unknown,
  headers: Record<string, string> | undefined
): ResolvedRequestBody {
  const encoded = encodeRequestBody(body);
  if (encoded === undefined || typeof body === "string") {
    return { body: encoded, headers };
  }
  const hasContentType = headers
    ? Object.keys(headers).some((k) => k.toLowerCase() === "content-type")
    : false;
  return {
    body: encoded,
    headers: hasContentType ? headers : { ...(headers ?? {}), "content-type": "application/json" },
  };
}
