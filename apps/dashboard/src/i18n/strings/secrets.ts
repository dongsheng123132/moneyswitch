import { defineMessages } from "../index";

/**
 * Copy for the three kinds of thing the dashboard shows: a secret (amber: a MoneyKey, the administrator token), a public address
 * (green: the wallet address people send USDC to), and the guard that blocks a secret pasted where it does not belong.
 */
export const secretStrings = defineMessages(
  {
    secretBadge: "Secret",
    publicBadge: "Public",

    // <PublicAddress>
    publicAddressNote: "Public: this is where USDC is sent. Safe to share.",
    shareAddress: "Share",
    showQr: "QR code",
    hideQr: "Hide QR",

    // <SecretNotice>
    secretNoticeTitle: "Secret — only for your own AI",
    secretNoticeBody: "Whoever has this key can spend your money within its limits. Give it only to your own AI; never send it to a seller.",

    // key-input guard
    guardBlockedTitle: "Blocked — that was a secret",
    keyGuardAddressTitle: "That's an address, not a token",
    key_LOOKS_LIKE_ADDRESS:
      "That is a public 0x… wallet address, not a token. The administrator token starts with ms_admin_ and a MoneyKey with mk_live_. The 0x address is where USDC is sent.",
    key_LOOKS_LIKE_PRIVATE_KEY: "That looks like a wallet private key. This field takes the administrator token, never a private key. We cleared the field.",
    key_LOOKS_LIKE_MNEMONIC: "That looks like a wallet recovery phrase. This field takes the administrator token, never a recovery phrase. We cleared the field.",
  },
  {
    secretBadge: "保密",
    publicBadge: "公开",

    publicAddressNote: "公开：USDC 就转到这个地址，可以放心分享。",
    shareAddress: "分享",
    showQr: "二维码",
    hideQr: "收起二维码",

    secretNoticeTitle: "保密——只给你自己的 AI",
    secretNoticeBody: "拿到它的人能在额度内花你的钱。只交给你自己的 AI，不要发给卖家。",

    guardBlockedTitle: "已拦截——这是一个秘密",
    keyGuardAddressTitle: "这是地址，不是令牌",
    key_LOOKS_LIKE_ADDRESS: "这是公开的 0x… 钱包地址，不是令牌。管理员令牌以 ms_admin_ 开头，MoneyKey 以 mk_live_ 开头。0x 地址是用来收 USDC 的。",
    key_LOOKS_LIKE_PRIVATE_KEY: "这看起来是钱包私钥。这里只填管理员令牌，不接收私钥。已为你清空输入框。",
    key_LOOKS_LIKE_MNEMONIC: "这看起来是钱包助记词。这里只填管理员令牌，不接收助记词。已为你清空输入框。",
  }
);
