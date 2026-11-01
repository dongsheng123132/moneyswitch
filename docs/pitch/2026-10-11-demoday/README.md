# MoneySwitch · 5 分钟 Demo Day

公开演示地址：<https://app.moneyswitch.dev/demoday.html>。独立 HTML，不需要管理员登录，不读取钱包、Key 或账本，不自动请求付费服务。

唯一源码：`apps/dashboard/public/demoday.html`。网站静态构建直接包含它；本地交付由 `node scripts/export-demoday.mjs` 生成到 `.data/demoday/MoneySwitch-DemoDay-5min.html`，字节和 SHA256 与源码一致。HTML 内嵌样式、脚本和二维码，断网可浏览；交易浏览器与管理后台需联网才能打开。

共 8 页，配套 [5 分钟讲稿](speaker-notes.md)。前 7 页约 3 分 45 秒，现有 Key 与账单展示 1 分钟，最后一页邀请 15 秒。示例卡片及交互流程明确使用模拟数据；Base Sepolia 与 Solana Devnet 付款证据链接来自已确认的两笔测试付款。

现场使用：

1. 先打开演示地址、本地 HTML 备用文件，以及已登录的 Key / 账单标签页。
2. `F` 全屏；左右方向键、空格或屏幕按钮翻页，`Home` / `End` 跳转首尾页。
3. `N` 显示当前页讲稿；`T` 控制演讲计时。投屏时按需关闭讲稿。
4. 第 7 页可以交互演示模拟请求，也可以切到已付款账单现场核验。模拟按钮不会发起交易。
5. 网站加载慢时保留 HTML 演示，使用已列出的交易链接供会后核验；避免现场重新付款。

公开稿不包含真实管理员凭据、MoneyKey、助记词、钱包余额、私人用途或服务器配置。用途是调用方自述，默认隐藏是展示选择；Solana 主网付款尚未启用。
