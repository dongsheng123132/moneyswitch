import { defineMessages } from "../index";

/**
 * SPEC-v0.5 §1 — the "three things" mental model. The single most important
 * copy in v0.5: private key (never shown) / MoneyKey (secret, amber) /
 * receiving address (public, green). Reused by the wallet,
 * earnings and login pages.
 */
export const threeThings = defineMessages(
  {
    title: "The three things in MoneySwitch",
    subtitle: "Two of them are secrets. One is meant to be shared. Keep payment access separate from wallet recovery credentials.",
    openButton: "What are the three things?",

    pkName: "Private key",
    pkMetaphor: "The key to the safe",
    pkWho: "Give it to: nobody",
    pkBody:
      "It controls the wallet. MoneySwitch keeps it encrypted on disk and uses it in server memory to sign. Agents receive a limited MoneyKey. Write the 12-word recovery phrase down and keep it offline; with auto-unlock, anyone who can read the server's data folder can spend the wallet, so protect that folder.",

    mkName: "MoneyKey (mk_live_…)",
    mkMetaphor: "A capped company card for an employee",
    mkWho: "Give it to: only your own AI",
    mkBody:
      "Secret. Whoever holds it can spend your money up to its limits. Never send it to a seller, never paste it into a website, never post it in a chat.",

    addrName: "Receiving address (0x…)",
    addrMetaphor: "Your payment QR code",
    addrWho: "Give it to: anyone",
    addrBody: "Public. Others use it to pay you. It can only receive money, so it is safe to share, print, or put on every price tag.",

    secretBadge: "Secret",
    publicBadge: "Public",
    neverShownBadge: "Never shown",

    // <PublicAddress>
    publicAddressNote: "Public: people pay you with this. Safe to share.",
    shareAddress: "Share",
    showQr: "QR code",
    hideQr: "Hide QR",

    // <SecretNotice>
    secretNoticeTitle: "Secret — only for your own AI",
    secretNoticeBody:
      "Whoever has this key can spend your money within its limits. Don't send it to sellers — to get paid, share your receiving address (0x…) instead.",

    // key-input guard title
    guardBlockedTitle: "Blocked — that was a secret",

    // key inputs
    keyGuardAddressTitle: "That's an address, not a key",
    key_LOOKS_LIKE_ADDRESS:
      "That is a public 0x… receiving address, not a key. A MoneyKey starts with mk_live_ (the admin token with ms_admin_). The 0x address is what you give to people who pay you.",
    key_LOOKS_LIKE_PRIVATE_KEY:
      "That looks like a wallet private key. This field accepts a MoneyKey, not a private key. Use the dedicated wallet import page only when restoring your own wallet. We cleared the field.",
    key_LOOKS_LIKE_MNEMONIC: "That looks like a wallet recovery phrase. This field accepts a MoneyKey, not a recovery phrase. We cleared the field.",
  },
  {
    title: "MoneySwitch 里的三样东西",
    subtitle: "两样是秘密，一样是拿来分享的。请分清付款权限与钱包恢复凭据。",
    openButton: "三样东西分别是什么？",

    pkName: "私钥",
    pkMetaphor: "保险柜钥匙",
    pkWho: "给谁：谁都不给",
    pkBody: "它控制钱包本身。MoneySwitch 把它加密保存在磁盘上，在服务器内存里签名；Agent 使用受限的 MoneyKey。请把 12 个单词的恢复短语抄下来离线保存；开启自动解锁后，任何能读取服务器数据目录的人都能动用这个钱包，所以要保护好该目录。",

    mkName: "MoneyKey（mk_live_…）",
    mkMetaphor: "给员工的限额副卡",
    mkWho: "给谁：只给你自己的 AI",
    mkBody: "保密。拿到它的人能在额度内花你的钱。不要发给卖家，不要贴进任何网站，不要发到群里。",

    addrName: "收款地址（0x…）",
    addrMetaphor: "收款码",
    addrWho: "给谁：可以给任何人",
    addrBody: "公开。别人付钱给你就用它。它只能收钱，可以放心分享、打印、写在每个价签上。",

    secretBadge: "保密",
    publicBadge: "公开",
    neverShownBadge: "永不显示",

    publicAddressNote: "公开：别人付钱给你用它，可以放心分享。",
    shareAddress: "分享",
    showQr: "二维码",
    hideQr: "收起二维码",

    secretNoticeTitle: "保密——只给你自己的 AI",
    secretNoticeBody: "拿到它的人能在额度内花你的钱，不要发给卖家。想收钱，请分享你的收款地址（0x…）。",

    guardBlockedTitle: "已拦截——这是一个秘密",

    keyGuardAddressTitle: "这是地址，不是 Key",
    key_LOOKS_LIKE_ADDRESS: "这是公开的 0x… 收款地址，不是 Key。MoneyKey 以 mk_live_ 开头（管理员口令以 ms_admin_ 开头）。0x 地址是给付钱给你的人用的。",
    key_LOOKS_LIKE_PRIVATE_KEY: "这看起来是钱包私钥。这里填写 MoneyKey，不接收私钥。仅在恢复自己的钱包时使用专门的钱包导入入口。已为你清空输入框。",
    key_LOOKS_LIKE_MNEMONIC: "这看起来是钱包助记词。这里填写 MoneyKey，不接收助记词。已为你清空输入框。",
  }
);
