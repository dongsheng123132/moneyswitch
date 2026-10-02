/**
 * Turns a /v1/fetch envelope into the MCP tool result for `paid_fetch`.
 * Pure (no env, no network) so it can be unit-tested; index.ts only wires it up.
 *
 * Messages for outcomes where money may have moved are bilingual (zh + en) and
 * blunt about NOT retrying: an agent that retries a call that already settled
 * (or may still settle) pays twice.
 */

export interface PaidFetchToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  // MCP's CallToolResult carries an index signature (e.g. _meta); keep this assignable to it.
  [key: string]: unknown;
}

type Json = Record<string, any> | null;

function amountOf(json: Json): string {
  const a = json?.payment?.amount;
  return typeof a === "string" ? a : "?";
}

/** payment_unknown: we signed a payment and lost the response. Outcome unknown, may be charged. */
export function paymentUnknownText(json: Json): string {
  const code = json?.code ?? "TIMEOUT_AFTER_PAYMENT";
  const amount = amountOf(json);
  return (
    `付款已签名并发出，但没有收到卖家的完整响应，扣款结果未知（可能已经扣了 ${amount} USDC）。` +
    `请不要自动重试：重试会再签一笔、再付一次钱。该金额在链上对账前会继续占用这把 key 的预算；` +
    `用 money_history 查看（status=unknown 之后会变成 settled 或 failed），或联系 key 的主人。(code=${code})\n` +
    `A payment of ${amount} USDC was signed and sent, but the seller's response never arrived, so the outcome is UNKNOWN: ` +
    `you MAY have been charged. Do NOT retry automatically — a retry signs and pays again. ` +
    `The amount stays reserved against this key's budget until it is reconciled on-chain; ` +
    `check money_history (status "unknown" becomes "settled" or "failed") or ask the key owner. (code=${code})` +
    (json?.reason ? `\n\n${json.reason}` : "")
  );
}

/** UPSTREAM_BODY_INCOMPLETE: settlement confirmed, but the response body was cut off. Definitely charged. */
export function bodyIncompleteText(json: Json): string {
  const amount = amountOf(json);
  const tx = json?.payment?.tx_hash ?? "(unknown)";
  return (
    `付款已确认成交（${amount} USDC，tx ${tx}），但卖家的响应内容没有完整收到。已经扣款。` +
    `请不要自动重试：重试会再付一次钱。需要内容的话拿着 tx 去找卖家。(code=UPSTREAM_BODY_INCOMPLETE)\n` +
    `The payment of ${amount} USDC was settled (tx ${tx}) but the seller's response body was cut off. You HAVE been charged. ` +
    `Do NOT retry automatically — a retry pays again. If you need the content, contact the seller with the tx hash. ` +
    `(code=UPSTREAM_BODY_INCOMPLETE)` +
    (json?.reason ? `\n\n${json.reason}` : "")
  );
}

/** Appended to results where `charged` is "maybe" but we do have a response (e.g. 200 without a settlement header, or PAYMENT_REJECTED). */
export function chargedMaybeNote(json: Json): string {
  return (
    `注意 / Note: charged="maybe" —— 已签名并发出付款，但没有确认是否成交，可能已扣款，请不要盲目重试。\n` +
    `A payment was signed and sent but its settlement was not confirmed, so you may have been charged. Do not retry blindly` +
    (json?.reserved_until_expiry ? "; the amount stays reserved until it is reconciled." : ".")
  );
}

export function formatPaidFetchResult(httpStatus: number, json: Json): PaidFetchToolResult {
  if (json?.status === "approval_required") {
    return {
      content: [
        {
          type: "text",
          text:
            `已提交人工审批 approval_id=${json.approval_id}，等用户批准后用同一参数加 approval_id 重试。\n` +
            `(Submitted for manual approval, approval_id=${json.approval_id}. ` +
            `Wait for the user to approve it, then retry paid_fetch with the exact same url/method/body plus approval_id="${json.approval_id}".)`,
        },
      ],
    };
  }

  if (json?.status === "payment_unknown") {
    return {
      content: [
        { type: "text", text: paymentUnknownText(json) },
        { type: "text", text: JSON.stringify(json, null, 2) },
      ],
      isError: true,
    };
  }

  if (json?.status === "error" && json?.code === "UPSTREAM_BODY_INCOMPLETE") {
    return {
      content: [
        { type: "text", text: bodyIncompleteText(json) },
        { type: "text", text: JSON.stringify(json, null, 2) },
      ],
      isError: true,
    };
  }

  if (httpStatus !== 200 || json?.status === "denied" || json?.status === "error" || json?.status === "payment_failed") {
    const content: PaidFetchToolResult["content"] = [
      { type: "text", text: `paid_fetch failed: ${JSON.stringify(json ?? { http_status: httpStatus })}` },
    ];
    if (json?.charged === "maybe") content.push({ type: "text", text: chargedMaybeNote(json) });
    return { content, isError: true };
  }

  const content: PaidFetchToolResult["content"] = [{ type: "text", text: JSON.stringify(json, null, 2) }];
  if (json?.charged === "maybe") content.push({ type: "text", text: chargedMaybeNote(json) });
  return { content };
}
