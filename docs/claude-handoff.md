# MoneySwitch 接手与部署记录（2026-10-02）

Claude Code 因限额停止后的 timeout、skill、notify 三条已审查分支已整合。原工作树未提交内容保留，接手工作在 `codex/claude-handoff` 隔离工作树完成。

v0.6 买方基础设施：移除卖方收费亭和本机 UI/自动配置命令；保留历史数据库表并建立 `archive/tollbooth-v0.5` 存档。skill + 独立 MoneyKey 为主要接入方式，预算、父 Key 限制、Key 重置、审批和通知沿用统一动作核心。

新增 Monad/Base 主网及测试网允许列表。付款选择、链上凭证、余额和对账按实际链处理；不换币、不跨链。钱包页面按链展示正确合约和浏览器，主网不显示测试币领取指引。

验证：本地 `pnpm build`、全量 `pnpm test` 通过；端到端 91 项通过、1 项跳过。最后的服务端和核心针对性回归分别 164、119 项通过。部署烟雾脚本在 Windows 和美国服务器的 Linux 镜像各通过 15 项，覆盖原生 SQLite、后台资源、初始化、鉴权、钱包加密、Key 重置、预算保留和重启持久化；全部使用独立临时数据，真实付款数为 0。

## 已部署实例

- 后台：`https://app.moneyswitch.dev`
- 官网：`https://moneyswitch.dev`（GitHub Pages，未改动）
- 主机：`siliconvalley` / `43.172.94.101`
- 代码源提交：`919ccae0763a7b7537bc70639698a7f18b29b8d0`
- 源码归档 SHA-256：`d984ecbef08edd8b8af6452e0d3bcfe5380f83870dddb1709c69563859c87e09`
- 镜像：`moneyswitch:919ccae`，ID `sha256:1f8a924869c6aeb7bdf9ab6dc3ef82eb2950c2472b391e74a0a9242aa05048e5`
- 运行目录：`/opt/moneyswitch/releases/919ccae`
- Compose 项目：`moneyswitch`；数据卷：`moneyswitch_moneyswitch-data`
- 配置：`/opt/moneyswitch/config.env`；钱包密码文件位于固定私有目录
- Caddy 片段：`/etc/caddy/conf.d/moneyswitch.caddy`
- Caddy 回滚备份：`/opt/moneyswitch/caddy-backups/20261002-145231`

新建 Cloudflare A 记录 `app.moneyswitch.dev → 43.172.94.101`，仅 DNS，TTL 300。已在服务器及本机直连核对可信 HTTPS：健康、后台、公开 skill 为 200，管理员接口未登录为 403；原官网和同机 shadowfork.net/aiqr.cc 保持 200。

服务默认只启用两个测试网，尚未创建用户自用钱包、充值或执行真实交易。首次初始化链接有效期 30 分钟，管理员信息在私有终端/本地忽略目录提供，不写入仓库。若设置链接过期，可用首次管理员令牌直接登录。主网启用、生产通知渠道和真实链付款需由使用者按自己的资金配置完成。

源代码和镜像已经部署；npm 新版本未发布。该镜像的包内版本仍为 0.5.1，按上述 Git 提交与镜像 ID 识别本次 v0.6 开发实例。后续补充的部署脚本和配置在同一代码仓提交，不另设发行组装源。
