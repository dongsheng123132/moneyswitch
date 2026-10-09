# 官网发布与参赛准备状态

日期：2026-10-09（北京时间）。这是提交准备记录，不是比赛平台的成功回执。

## 官网已发布

- 发布版本：`82c7839bc262973bd69a381eee4b6a3777eeec81`，基于 v0.7.6 源码。
- GitHub Pages：[发布成功](https://github.com/dongsheng123132/moneyswitch/actions/runs/37883060669)。
- 对应 [CI 检查](https://github.com/dongsheng123132/moneyswitch/actions/runs/37883060733)已全部通过：Ubuntu 和 Windows 的构建与测试均为 success。
- 官网：[moneyswitch.dev](https://moneyswitch.dev/)。
- 统一取稿入口：[文章、图片、Logo](https://moneyswitch.dev/media/)。
- 新观点文章：[中文](https://moneyswitch.dev/blog/cloud-wallet-for-ai-bots/zh/) / [English](https://moneyswitch.dev/blog/cloud-wallet-for-ai-bots/)。
- 试用与贡献：[试用](https://moneyswitch.dev/pilot/zh/) / [提 PR](https://moneyswitch.dev/contribute/zh/)。
- [参赛 Logo PNG](https://moneyswitch.dev/assets/img/moneyswitch-logo-512.png)：512 × 512，82,658 字节，262,144 像素；从已有品牌 SVG 原样导出。
- 官网 22 项页面和下载文件与发布源一致；外部网络另确认素材中心、新英文文章和贡献页可读。
- 本地浏览器 41 个页面/宽度组合检查通过，六份下载稿与博客源稿一致，旧图文保留。

## 填写工作台

运行本地 `python -m http.server 8770 --bind 127.0.0.1 --directory <本目录>` 后打开：
http://127.0.0.1:8770/submission-workbench.html

页面只读本目录 JSON，提供逐字段复制；不会登录或提交比赛平台。16 个字段、桌面/手机宽度与复制按钮已检查。离线也可以直接阅读 `submission.en.md`，复制英文正文。

团队公开介绍采用用户确认的“贺去病（hecare）”。项目名改为 MoneySwitch，GitHub 栏必须是源码仓库，不能用 GitHub Pages 页面。

## 仍需完成后才能称为最终提交

1. **两段视频已完成并补入工作台**：[技术演示](https://moneyswitch.dev/videos/technical-demo/) / [Pitch](https://moneyswitch.dev/videos/pitch/)。成片、实际测试网交易及发布记录见 `video-delivery.md`。比赛账号中的保存结果未由本工具读取。
2. **Alibaba / Qwen 字段已确认并补齐**：要求公开发表的文章，使用 https://moneyswitch.dev/blog/qwen-agent-pays-nansen/ 。最新用户截图是准确字段要求的来源。
3. 核验评委能实际使用的访问方式。app 首页、healthz、公开测试付款报价可达，但不等于评委已能登录操作；自托管评估路线已写好，专门的托管评委权限仍未配置。
4. 上传 Logo，移除没有实现的 Mera 赏金，检查剩余项并保存。当前没有操作比赛账号，没有提交表单。

表单显示截止时间：2026-10-14 11:59 GMT+8。
