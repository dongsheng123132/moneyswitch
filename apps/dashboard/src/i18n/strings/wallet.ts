import { defineMessages } from "../index";

/** Copy for the Wallet page (SPEC.md §1, §2, §5): create, the 12 words, status, replace. */
export const walletStrings = defineMessages(
  {
    // --- create --------------------------------------------------------------
    setupTitle: "Create the wallet",
    setupLead:
      "MoneySwitch keeps a small wallet on this server. Your AI spends from it, within the limits you set on each key. Put in only what you are happy for an AI to spend.",
    createExplain:
      "One click makes a new wallet. It unlocks itself after every restart, so nobody has to type a password. You get 12 recovery words, shown once: have pen and paper ready.",
    createButton: "Create wallet",
    creating: "Creating…",
    createFailed: "Could not create the wallet: {message}",
    orphanTitle: "Files of an earlier wallet are still in the data folder",
    orphanBody:
      "wallet.json is missing, but {secrets} unlock file(s) and {retired} file(s) in retired/ are still there. The usual cause is a data folder mounted from the wrong place. Restore wallet.json from your backup first. A new wallet keeps those files; it never overwrites them.",
    orphanAck: "I understand, create a new wallet anyway",

    // --- the 12 words ---------------------------------------------------------
    phraseTitle: "Your 12 recovery words",
    phraseWarnTitle: "Write them down now. They are shown only once.",
    phraseWarnBody:
      "Anyone with these words controls this wallet's money. MoneySwitch keeps no copy it can show you, so it cannot show them again. They also work in wallet apps such as MetaMask (standard path m/44'/60'/0'/0/0).",
    wordsLabel: "The 12 recovery words, numbered",
    phraseCopy: "Copy the words",
    phraseAck: "I wrote all 12 words down",
    phraseDone: "Done",
    phraseSaving: "Saving…",
    phraseAckFailed: "Could not record it: {message}. The words are still on screen: try again.",
    phraseAckStale:
      "These words belong to a wallet that has been replaced since they were shown, so they cannot be confirmed. Nothing was recorded. Reload the page: it shows the current wallet.",

    // --- status ---------------------------------------------------------------
    addressTitle: "Wallet address",
    addressLead: "Send USDC to this address. It is the same address on every chain below; the balances are separate.",
    chainCol: "Chain",
    balanceCol: "USDC balance",
    balanceUnknown: "unknown",
    overLimit: "over the {limit} USDC limit",
    viewExplorer: "View on explorer",
    floatNote: "Keep only a small amount here: the limit is {limit} USDC per chain (MONEYSWITCH_WALLET_FLOAT_LIMIT).",
    fundTestnet: "To fund a test wallet, get free test USDC from the faucet. No gas token is needed: the facilitator pays the gas.",
    fundFaucet: "Open the USDC faucet",
    fundMainnet: "This chain uses real USDC. Send only what you are willing to let your AI spend.",

    checksTitle: "State",
    checkUnlock: "Unlocks itself after a restart",
    checkProtect: "Unlock file readable only by this server's account",
    checkBackup: "Recovery words written down",
    yes: "Yes",
    no: "No",
    notVerified: "Not verified: {detail}",
    notConfirmed: "Not confirmed",
    notApplicable: "Not applicable",

    // --- problems -------------------------------------------------------------
    lockedTitle: "The wallet is locked, so every payment fails",
    locked_secret_missing: "Its unlock file is missing from the data folder.",
    locked_secret_empty: "Its unlock file in the data folder is empty.",
    locked_secret_unreadable: "Its unlock file in the data folder cannot be read.",
    locked_secret_wrong: "The unlock file in the data folder does not open it.",
    locked_fix: "Restore the unlock file from a backup of the data folder and restart the server, or replace the wallet below (the old files stay in retired/).",
    locked_password:
      "It was made by an older version and is protected by a password. Set MONEYSWITCH_WALLET_PASSWORD (or MONEYSWITCH_WALLET_PASSWORD_FILE) on the server and restart it, or replace the wallet below.",
    locked_env_wrong:
      "The password in MONEYSWITCH_WALLET_PASSWORD(_FILE) does not open it. Correct it and restart the server, or replace the wallet below.",
    secretGoneTitle: "The unlock file has disappeared",
    secretGoneBody: "The wallet works now, but after the next restart it will be locked. Restore the file from a backup of the data folder.",
    unprotectedTitle: "The data folder could not be locked down",
    unprotectedBody: "Other accounts on this machine may be able to read the file that opens the wallet. Keep only a small amount in it. {detail}",
    backupMissingTitle: "You have not confirmed the 12 words",
    backupMissingBody:
      "The words cannot be shown again. If you did not write them down, replace the wallet below to get new words: you lose nothing while the wallet is empty.",
    retiredOpenerTitle: "An old unlock file still opens this wallet without its password",
    retiredOpenerBody: "{files} (in retired/). It is removed once the server starts with the password.",
    orphanWalletTitle: "Files of an earlier wallet are in the data folder",
    orphanWalletBody: "{secrets} unlock file(s) of other wallets and {retired} file(s) in retired/. They are kept and never used for this wallet.",

    // --- replaced wallets -----------------------------------------------------
    retiredTitle: "Replaced wallets",
    retiredLead:
      "The files of an old wallet were moved to the retired/ folder of the data directory, never deleted. If one of them still holds money, follow the recovery steps in docs/wallet-setup.md.",
    retiredAddress: "Address",
    retiredOn: "Replaced on",
    retiredReason: "Reason",
    retiredBalance: "USDC",
    retiredFiles: "Files in retired/",
    retiredFilesKeystoreAndSecret: "keystore + unlock file",
    retiredFilesKeystore: "keystore only",

    // --- replace --------------------------------------------------------------
    replaceTitle: "Replace the wallet",
    replaceLead:
      "Makes a new wallet with new 12 words. The old wallet's files move to retired/ (never deleted); keys, limits and history stay as they are. Use it when the wallet will not unlock, was exposed, or you never wrote the words down.",
    replaceReasonLabel: "Why",
    reason_replaced: "I just want a new wallet",
    reason_lost_password: "It will not unlock (lost password or unlock file)",
    reason_suspected_leak: "I think it was exposed",
    replaceConfirmLabel: "Type the current wallet address to confirm",
    replaceButton: "Replace wallet",
    replacing: "Replacing…",
    replaceBusy: "A payment is being made right now. Wait a moment and try again: nothing was changed.",
    replaceMismatch: "That is not the current address. Type it exactly as shown above.",
    replaceFailed: "Could not replace the wallet: {message}",
    replaceMoveMoney: "Move any money you want to keep out of the old wallet first: after the swap this server no longer signs for it.",
    replaceCurrentLabel: "The wallet that will be retired (do not send money to it):",
  },
  {
    // --- create --------------------------------------------------------------
    setupTitle: "创建钱包",
    setupLead: "MoneySwitch 在这台服务器上放一个小钱包。你的 AI 在每把 Key 设的额度内从里面花钱。只放你愿意让 AI 花的钱。",
    createExplain: "点一下就创建一个新钱包。它每次重启后会自己解锁，不用输入密码。你会得到 12 个恢复词，只显示一次：请先准备好纸和笔。",
    createButton: "创建钱包",
    creating: "创建中…",
    createFailed: "创建钱包失败：{message}",
    orphanTitle: "数据目录里还有旧钱包的文件",
    orphanBody:
      "wallet.json 不见了，但还留着 {secrets} 个解锁文件和 retired/ 里的 {retired} 个文件。最常见的原因是数据目录挂载错了位置。请先从备份恢复 wallet.json。新建钱包会保留这些文件，不会覆盖它们。",
    orphanAck: "我明白了，仍然创建新钱包",

    // --- the 12 words ---------------------------------------------------------
    phraseTitle: "你的 12 个恢复词",
    phraseWarnTitle: "现在就抄下来。它们只显示这一次。",
    phraseWarnBody:
      "拿到这些词的人就能控制钱包里的钱。MoneySwitch 没有可显示的副本，所以不能再显示。这些词也能在 MetaMask 等钱包 App 里使用（标准路径 m/44'/60'/0'/0/0）。",
    wordsLabel: "12 个恢复词（带序号）",
    phraseCopy: "复制这些词",
    phraseAck: "我已把 12 个词全部抄下",
    phraseDone: "完成",
    phraseSaving: "保存中…",
    phraseAckFailed: "没能记录下来：{message}。这些词还在屏幕上，请再试一次。",
    phraseAckStale: "这些词属于一个在它们显示之后已被更换的钱包，所以无法确认，也没有记录任何东西。请刷新页面：那里显示的是当前的钱包。",

    // --- status ---------------------------------------------------------------
    addressTitle: "钱包地址",
    addressLead: "把 USDC 转到这个地址。下面每条链上都是同一个地址，余额各算各的。",
    chainCol: "链",
    balanceCol: "USDC 余额",
    balanceUnknown: "未知",
    overLimit: "超过 {limit} USDC 上限",
    viewExplorer: "在浏览器中查看",
    floatNote: "这里只放小钱：每条链上限 {limit} USDC（MONEYSWITCH_WALLET_FLOAT_LIMIT）。",
    fundTestnet: "给测试钱包充值：到水龙头领免费测试 USDC。不需要 gas 代币，gas 由 facilitator 代付。",
    fundFaucet: "打开 USDC 水龙头",
    fundMainnet: "这条链用的是真实 USDC。只转你愿意让 AI 花的数额。",

    checksTitle: "状态",
    checkUnlock: "重启后能自己解锁",
    checkProtect: "解锁文件只有本服务账户能读",
    checkBackup: "恢复词已抄下",
    yes: "是",
    no: "否",
    notVerified: "未能确认：{detail}",
    notConfirmed: "未确认",
    notApplicable: "不适用",

    // --- problems -------------------------------------------------------------
    lockedTitle: "钱包已锁定，所有付款都会失败",
    locked_secret_missing: "数据目录里找不到它的解锁文件。",
    locked_secret_empty: "数据目录里它的解锁文件是空的。",
    locked_secret_unreadable: "数据目录里它的解锁文件读不了。",
    locked_secret_wrong: "数据目录里的解锁文件打不开这个钱包。",
    locked_fix: "请从数据目录的备份恢复解锁文件并重启服务器，或者在下面更换钱包（旧文件会留在 retired/）。",
    locked_password:
      "它是旧版本建的、用密码保护的钱包。请在服务器上设置 MONEYSWITCH_WALLET_PASSWORD（或 MONEYSWITCH_WALLET_PASSWORD_FILE）后重启，或者在下面更换钱包。",
    locked_env_wrong: "MONEYSWITCH_WALLET_PASSWORD(_FILE) 里的密码打不开它。请改正后重启服务器，或者在下面更换钱包。",
    secretGoneTitle: "解锁文件不见了",
    secretGoneBody: "钱包现在还能用，但下次重启后会被锁住。请尽快从数据目录的备份恢复这个文件。",
    unprotectedTitle: "没能把数据目录锁成只有本账户可访问",
    unprotectedBody: "这台机器上的其他账户可能读到能打开钱包的文件。请只放小钱。{detail}",
    backupMissingTitle: "你还没有确认 12 个恢复词",
    backupMissingBody: "这些词不能再显示。如果你没抄下来，请在下面更换钱包拿一套新词：钱包还是空的时候，换掉不会有任何损失。",
    retiredOpenerTitle: "一个旧的解锁文件仍能不用密码打开这个钱包",
    retiredOpenerBody: "{files}（在 retired/ 里）。服务器带着密码启动后会把它删除。",
    orphanWalletTitle: "数据目录里有旧钱包的文件",
    orphanWalletBody: "{secrets} 个其他钱包的解锁文件，以及 retired/ 里的 {retired} 个文件。它们都会保留，也不会用于这个钱包。",

    // --- replaced wallets -----------------------------------------------------
    retiredTitle: "已更换的旧钱包",
    retiredLead: "旧钱包的文件被移到数据目录的 retired/ 文件夹，从不删除。如果其中某个还有钱，请按 docs/wallet-setup.md 里的恢复步骤操作。",
    retiredAddress: "地址",
    retiredOn: "更换时间",
    retiredReason: "原因",
    retiredBalance: "USDC",
    retiredFiles: "retired/ 里的文件",
    retiredFilesKeystoreAndSecret: "钱包文件 + 解锁文件",
    retiredFilesKeystore: "只有钱包文件",

    // --- replace --------------------------------------------------------------
    replaceTitle: "更换钱包",
    replaceLead:
      "创建一个新钱包和一套新的 12 个词。旧钱包的文件会移到 retired/（从不删除）；Key、额度和账单都保持不变。适用于钱包打不开、可能泄露，或者当时没抄恢复词。",
    replaceReasonLabel: "原因",
    reason_replaced: "只是想换个新钱包",
    reason_lost_password: "打不开（密码或解锁文件丢了）",
    reason_suspected_leak: "我觉得它可能泄露了",
    replaceConfirmLabel: "输入当前钱包地址以确认",
    replaceButton: "更换钱包",
    replacing: "更换中…",
    replaceBusy: "此刻正有一笔付款在进行。稍等一下再试：什么都没有改动。",
    replaceMismatch: "这不是当前地址。请照上面显示的原样输入。",
    replaceFailed: "更换钱包失败：{message}",
    replaceMoveMoney: "想保留的钱请先从旧钱包转出：换完之后，这台服务器不再替旧钱包签名。",
    replaceCurrentLabel: "将被停用的钱包（不要再向它转钱）：",
  }
);
