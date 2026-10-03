# Approval push notifications

When a payment reaches a key's approval threshold it pauses and waits for you
(`/v1/approvals`, Dashboard → Approvals). Approvals expire after 10 minutes, so
MoneySwitch can also push a short message to your phone the moment one appears.

```
[MoneySwitch] 有一笔付款等你审批
Key：Codex
金额：0.15 USDC
去向：api.example.com/deep-report
方法：GET
有效期：10 分钟内处理，过期自动作废
审批编号：9f1c…
去审批：https://pay.example.com/approvals
```

The message names the key, the amount, the destination **host and path only**
(never the query string, headers or request body), the method, the time left,
the approval id and a link. With no `MONEYSWITCH_PUBLIC_URL` the last line
says to open the Dashboard's Approvals page instead of giving a link.

Channels (use any combination, each gets its own copy):

| Channel | What you need |
| --- | --- |
| Feishu / Lark group bot | custom bot webhook, optional signing secret |
| WeCom group bot | group bot webhook |
| Telegram | bot token + chat id |
| Generic webhook | a URL that accepts a JSON POST |

## Configure it

**Dashboard:** Approvals page → *Notifications*. Fill in a channel, *Save*, then
*Send test message*; every configured channel reports ok or the reason it
failed. Saved secrets are shown masked (`https://••••.feishu.cn/••••6789`: the
host is hidden too, since for many webhook services the host is the secret) and
are never returned in full; leave a box empty to keep the stored value.

**Environment variables** (headless deploys; each one overrides the stored value
of the same field and makes it read-only in the Dashboard and API):

| Variable | |
| --- | --- |
| `MONEYSWITCH_NOTIFY_FEISHU_WEBHOOK` | Feishu custom bot webhook URL |
| `MONEYSWITCH_NOTIFY_FEISHU_SECRET` | its signing secret (only if "signature verification" is on) |
| `MONEYSWITCH_NOTIFY_WECOM_WEBHOOK` | WeCom group bot webhook URL |
| `MONEYSWITCH_NOTIFY_TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `MONEYSWITCH_NOTIFY_TELEGRAM_CHAT_ID` | Telegram chat id (`-100…`, or `@channelname`) |
| `MONEYSWITCH_NOTIFY_WEBHOOK_URL` | generic webhook URL |
| `MONEYSWITCH_NOTIFY_INTERVAL_MS` | how often the outbox looks for new approvals (default 2500, `0` = off) |
| `MONEYSWITCH_PUBLIC_URL` | base of the link in the message (`{url}/approvals`) |

**Admin API** (admin token, like the other admin routes):

```bash
# what is configured (masked) and where each value comes from (env | db)
curl -s http://127.0.0.1:4020/v1/admin/notify -H "Authorization: Bearer $ADMIN"

# partial update; "" clears a field. env-supplied fields answer 409 FIELD_FROM_ENV
curl -s -X PUT http://127.0.0.1:4020/v1/admin/notify -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  -d '{"feishu":{"webhook":"https://open.feishu.cn/open-apis/bot/v2/hook/…","secret":"…"},
       "telegram":{"bot_token":"123456:ABC…","chat_id":"-1001234567890"}}'

# send a test message to every configured channel -> {"results":[{"channel":"feishu","ok":true},…]}
curl -s -X POST http://127.0.0.1:4020/v1/admin/notify/test -H "Authorization: Bearer $ADMIN"
```

## Getting the webhooks

- **Feishu:** in the group, Settings → Bots → Add bot → *Custom bot*; copy the
  webhook (`https://open.feishu.cn/open-apis/bot/v2/hook/…`). Under security
  settings, "Signature verification" is recommended (paste the secret above).
  If you use "Custom keywords" instead, add the keyword `MoneySwitch`. If you
  use an IP allowlist, allow this server's public IP. Limit: 100 messages/min,
  5/s per bot.
- **WeCom:** in the group chat, `…` → Add group bot → create one, copy the
  Webhook address (`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…`).
  There is no signing option, so treat the address as a password. Limit: 20
  messages/min per bot.
- **Telegram:** talk to @BotFather, `/newbot`, copy the token. Add the bot to
  your chat, send it a message, open
  `https://api.telegram.org/bot<token>/getUpdates` and copy `chat.id` (groups
  are negative numbers).
- **Generic webhook:** MoneySwitch POSTs this (any 2xx counts as delivered):

  ```json
  {
    "event": "approval_required",
    "approval": {
      "id": "…", "key_name": "Codex", "key_prefix": "mk_live_ab12",
      "amount": "0.15", "currency": "USDC",
      "host": "api.example.com", "path": "/deep-report", "method": "GET",
      "expires_at": "2026-10-02T08:10:00.000Z"
    },
    "approve_url": "https://pay.example.com/approvals"
  }
  ```

  `POST /v1/admin/notify/test` sends `{"event":"test","approval":null,"approve_url":…}`.
  When one key floods the approval queue (see below) you get one summary
  instead: `{"event":"approval_digest","approval":null,"key_name":"Codex",
  "key_prefix":"mk_live_ab12","pending_count":7,"approve_url":…}`.

## How delivery behaves

- It runs beside the HTTP server and is never on the payment path: a slow,
  failing or unreachable webhook cannot slow down or fail `/v1/fetch`.
- The state lives in the database (`approvals.notified_at` and the table
  `approval_notify_deliveries`, one row per approval and channel), so it
  survives restarts: anything still pending and unexpired that was not
  announced yet is sent after a restart. Each approval is announced once per
  channel, also when two server processes share a database. An approval that
  expired while it waited is never sent.
- Every channel is delivered and retried on its own. If Telegram times out
  while the generic webhook answered, Telegram is retried with back-off (15 s,
  30 s, 60 s, 120 s) up to 5 attempts and then dropped with a `warn` log line,
  while the webhook is not sent the same approval again. The approval itself
  stays pending in the Dashboard.
- Channels do not hold each other up: a black-holed channel only delays its
  own messages (a few sends in flight per channel, each bounded by an 8 s
  timeout), not the ones for the other channels.
- No flood. A request the agent repeats while the first one is still pending
  and already announced (same key, URL, method, body, payee and price; e.g. an
  OpenAI SDK retrying a `409 APPROVAL_REQUIRED` answer, or an agent looping on
  a blocked call) is not announced again; the Approvals page still lists every
  one. Beyond that, one key gets at most 5 approval messages per minute and
  channel, then a single summary message ("this key has N approvals waiting"),
  then silence until the minute is over. Other keys are not affected, and the
  decision is stored, so it is never reversed later.
- Outbound requests use the same proxy as the rest of the server
  (`MONEYSWITCH_PROXY`, `HTTPS_PROXY`, Windows system proxy). Redirects are not
  followed.
- Webhook URLs, tokens and secrets are stored in the server's SQLite file and
  never logged, never returned in full and never written to the audit log (it
  records which fields changed, not their values). Use the environment
  variables if you would rather not store them in the database at all.
- The link in the message opens the Dashboard, so the Dashboard must be
  reachable from your phone (VPN, Tailscale, or an authenticated reverse
  proxy). Do not expose it unprotected just for this; see
  [`security.md`](security.md).

## Payload references

- Feishu custom bot (message format, signature, error codes):
  <https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot>
- WeCom group bot (message format, limits):
  <https://developer.work.weixin.qq.com/document/path/91770>; error codes
  (`errcode` 0 = success): <https://developer.work.weixin.qq.com/document/path/90313>
- Telegram Bot API `sendMessage`: <https://core.telegram.org/bots/api#sendmessage>
