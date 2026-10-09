# Metropolis 两段必填视频

制作日期：2026-10-09。创建者署名：贺去病 / hecare。以下为完成的成片及其官网发布入口；赛事表单的保存和提交仍需在已登录的比赛页面完成。

| 表单字段 | 官网播放页 | 时长 |
|---|---|---|
| Technical demo video | https://moneyswitch.dev/videos/technical-demo/ | 121.68 秒（2:01.68） |
| Pitch video | https://moneyswitch.dev/videos/pitch/ | 97.8 秒（1:37.8） |

备用 MP4 直链：

- https://moneyswitch.dev/assets/video/moneyswitch-technical-demo-20261009.mp4
- https://moneyswitch.dev/assets/video/moneyswitch-pitch-20261009.mp4

官网 [素材中心](https://moneyswitch.dev/media/) 同时提供观看和下载入口，方便其他平台推广使用。

## 技术演示

完整保留实际 v0.7.6 Dashboard 的 121.68 秒连续录像，1280 × 800，H.264 / AAC，带英文系统合成旁白、底部字幕和 fast start。新增字幕区不遮挡产品画面。录制源码版本 `0600d4b944402c081c215edb4598916c0ceb0cf5`，在独立本地实例运行，生产配置没有修改。

两个脚本 HTTP 客户端各持独立 MoneyKey，不冒充某个模型的实时对话。第一笔直接支付；第二笔到达 0.01 的审批线，返回等待审批且未扣款，通过实际 Dashboard Approve 后续付。画面展示 Bills、独立额度、撤销确认及撤销后的状态；实际后续 API 返回 `401 KEY_REVOKED`。

- [第一笔测试网交易](https://testnet.monadvision.com/tx/0x5905bf72c2527379987e85fd4646164e2b7f7de36ad193e18bd1ab7346bef82d)
- [审批后的第二笔交易](https://testnet.monadvision.com/tx/0xbb69c7e8a9e0d6494c17c552248694025c3c59e3ccd73325965585e962b1a1ad)

公共 RPC 对两笔均返回 `status=0x1`，测试 USDC Transfer 各 10000 micros，即各 0.01；余额从 1.48 降至 1.46。测试币无货币价值，没有使用主网资金。视频与公开说明不包含完整 MoneyKey、管理员凭证、PIN、私钥或恢复词。

## Pitch

1920 × 1080 / 30 fps，H.264 / AAC，英文合成旁白和大号内嵌字幕。第三人称介绍 hecare，不克隆或冒充创建者的声音。10 个场景涵盖多设备钱包问题、自托管钱包、独立预算与审批、USDC / x402、Monad 与 Base、历史 Qwen/Nansen 实验、热钱包信任边界以及试用和 PR 邀请。

历史实验明确标注 2026-09-27，五笔主网付款共 0.09 USDC，不是新录制的主网付款，也不是用户数或收入指标。

## 文件与验证

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| moneyswitch-technical-demo-20261009.mp4 | 3808368 | `d4c608f2c749eaa9235f12a8a070f2b893660b0f807d343022c962ea8f4f97dd` |
| moneyswitch-pitch-20261009.mp4 | 13101722 | `f6a98957d58d93fa85adfd298b3b6e525db8d117835ec87a2df9eb3e60ba54fe` |

成片已完整解码，核对声音、字幕和关键帧；技术演示保留 3042 帧，原画面 SSIM 0.999508。视频通过独立媒体 Release `metropolis-videos-2026-10-09` 分发，设置 `latest=false`，不改变应用最新版本。Pages 发布步骤按 manifest 校验大小和 SHA-256 后托管 MP4。

浏览器控制工具在本轮启动失败，未操作赛事账号、代填、保存或提交。用户已报告其他文案填写完成；本轮补齐截图中缺少的两个必填视频链接。
