import { defineMessages } from "../index";

/** Copy for the approval push-notification settings (Approvals page). */
export const notifyStrings = defineMessages(
  {
    title: "Notifications",
    subtitle: "Get a message on your phone the moment a payment needs your approval.",
    intro:
      "When a payment reaches a key's approval threshold, MoneySwitch sends one message to every channel you set up below, with a link to approve it here. Approvals expire after 10 minutes. A request the agent repeats while the first one is still pending is not announced again, and a key that floods approvals gets one summary message instead of one per approval. Webhook URLs and tokens are secrets: they are stored on this server and only ever shown masked.",
    linkIs: "The link in the message:",
    noPublicUrl:
      "MONEYSWITCH_PUBLIC_URL is not set on the server, so the message will not contain a link; it will tell you to open this Approvals page instead.",

    configured: "Configured",
    notConfigured: "Not configured",
    fromEnv: "Set by an environment variable on the server; change it there.",
    keepHint: "Currently {masked}. Leave empty to keep it.",
    keepHintSet: "Currently set. Leave empty to keep it.",
    clearField: "Clear",
    willClear: "Will be cleared when you save.",
    undoClear: "Undo",

    feishuName: "Feishu (Lark) group bot",
    wecomName: "WeCom group bot",
    telegramName: "Telegram bot",
    webhookName: "Generic webhook",

    f_feishu_webhook: "Webhook address",
    f_feishu_secret: "Signing secret (optional)",
    f_wecom_webhook: "Webhook address",
    f_telegram_bot_token: "Bot token",
    f_telegram_chat_id: "Chat id",
    f_webhook_url: "URL",

    howTo: "How do I get this?",
    helpFeishu:
      "In the Feishu group: Settings, Bots, Add bot, Custom bot. Copy the webhook address (https://open.feishu.cn/open-apis/bot/v2/hook/...). In the bot's security settings, \"Signature verification\" is recommended: paste its secret here. If you use \"Custom keywords\" instead, add the keyword MoneySwitch. If you use an IP allowlist, allow this server's public IP.",
    helpWecom:
      "In the WeCom group chat: the ... menu, Add group bot, create a new bot, copy its Webhook address (https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...). There is no signing option, so keep the address private. WeCom allows 20 messages per minute per bot.",
    helpTelegram:
      "Talk to @BotFather: /newbot, then copy the token (123456:ABC...). Add the bot to your chat or group and send it a message, then open https://api.telegram.org/bot<token>/getUpdates in a browser and copy chat.id (groups are negative numbers). A public channel can be given as @channelname.",
    helpWebhook:
      "MoneySwitch POSTs JSON to this URL: {\"event\":\"approval_required\",\"approval\":{\"id\",\"key_name\",\"key_prefix\",\"amount\",\"currency\",\"host\",\"path\",\"method\",\"expires_at\"},\"approve_url\"}. Any 2xx answer counts as delivered. It never contains the query string, headers or body of the paid request.",

    save: "Save",
    saving: "Saving...",
    saved: "Saved.",
    nothingToSave: "Nothing changed.",
    sendTest: "Send test message",
    sending: "Sending...",
    testNone: "No channel is configured yet. Save one first.",
    testOk: "Delivered",
    testFailed: "Failed: {error}",

    err_INVALID_URL: "{field}: that is not a valid http(s) URL.",
    err_INVALID_VALUE: "{field}: that value is not allowed.",
    err_INVALID_TELEGRAM_BOT_TOKEN: "{field}: that does not look like a Telegram bot token (123456:ABC...).",
    err_INVALID_TELEGRAM_CHAT_ID: "{field}: that does not look like a chat id (a number, or @channelname).",
    err_FIELD_FROM_ENV: "{field} is set by an environment variable and cannot be changed here.",
    err_other: "Could not save: {message}",
  },
  {
    title: "通知",
    subtitle: "有付款需要你审批时，第一时间把消息推到你的手机上。",
    intro:
      "某笔付款达到 Key 的审批阈值时，MoneySwitch 会向下面你配置的每个渠道各发一条消息，并附上到这里审批的链接。审批 10 分钟后过期。同一个请求在第一条还没处理时被重复发起，不会重复提醒；某个 Key 短时间内产生大量审批时，只发一条汇总消息。Webhook 地址和令牌都是机密：保存在这台服务器上，页面上只显示打码后的样子。",
    linkIs: "消息里的链接：",
    noPublicUrl: "服务器没有设置 MONEYSWITCH_PUBLIC_URL，所以消息里不会带链接，只会提示你打开本审批页面。",

    configured: "已配置",
    notConfigured: "未配置",
    fromEnv: "由服务器上的环境变量提供，请在那里修改。",
    keepHint: "当前：{masked}。留空表示不修改。",
    keepHintSet: "已设置。留空表示不修改。",
    clearField: "清除",
    willClear: "保存时会被清除。",
    undoClear: "撤销",

    feishuName: "飞书群机器人",
    wecomName: "企业微信群机器人",
    telegramName: "Telegram 机器人",
    webhookName: "通用 Webhook",

    f_feishu_webhook: "Webhook 地址",
    f_feishu_secret: "签名密钥（可选）",
    f_wecom_webhook: "Webhook 地址",
    f_telegram_bot_token: "Bot Token",
    f_telegram_chat_id: "Chat ID",
    f_webhook_url: "URL",

    howTo: "怎么获取？",
    helpFeishu:
      "在飞书群里：设置 → 群机器人 → 添加机器人 → 自定义机器人，复制 webhook 地址（https://open.feishu.cn/open-apis/bot/v2/hook/...）。建议在机器人的安全设置里勾选「签名校验」，把得到的密钥填到下面；如果用的是「自定义关键词」，就添加关键词 MoneySwitch；如果用 IP 白名单，请放行这台服务器的公网 IP。",
    helpWecom:
      "在企业微信群聊里：右上角「…」→ 添加群机器人 → 新创建一个机器人，复制它的 Webhook 地址（https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...）。企业微信没有签名选项，请保管好这个地址。每个机器人每分钟最多发 20 条。",
    helpTelegram:
      "找 @BotFather，发 /newbot，复制得到的 token（形如 123456:ABC...）。把机器人加进你的聊天或群并给它发一条消息，然后在浏览器打开 https://api.telegram.org/bot<token>/getUpdates，复制其中的 chat.id（群是负数）。公开频道可以直接填 @频道名。",
    helpWebhook:
      "MoneySwitch 会向这个 URL POST 一段 JSON：{\"event\":\"approval_required\",\"approval\":{\"id\",\"key_name\",\"key_prefix\",\"amount\",\"currency\",\"host\",\"path\",\"method\",\"expires_at\"},\"approve_url\"}。对方返回任意 2xx 即视为送达。内容里不会有这笔付款请求的 query 参数、请求头或请求体。",

    save: "保存",
    saving: "保存中…",
    saved: "已保存。",
    nothingToSave: "没有改动。",
    sendTest: "发送测试消息",
    sending: "发送中…",
    testNone: "还没有配置任何渠道，请先保存一个。",
    testOk: "已送达",
    testFailed: "失败：{error}",

    err_INVALID_URL: "{field}：不是有效的 http(s) 地址。",
    err_INVALID_VALUE: "{field}：这个值不被允许。",
    err_INVALID_TELEGRAM_BOT_TOKEN: "{field}：看起来不是 Telegram bot token（形如 123456:ABC...）。",
    err_INVALID_TELEGRAM_CHAT_ID: "{field}：看起来不是 chat id（数字，或 @频道名）。",
    err_FIELD_FROM_ENV: "{field} 由环境变量提供，不能在这里修改。",
    err_other: "保存失败：{message}",
  }
);
