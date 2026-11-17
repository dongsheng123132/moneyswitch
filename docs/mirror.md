# 多平台镜像同步指南

把 MoneySwitch 同步到 GitHub 之外的代码托管平台，扩大曝光和下载。
**主仓库永远是 GitHub**；镜像仓只做分发，Issue / PR 只在 GitHub 收。

## 平台清单

| 平台 | 网址 | 区域 | README | 优先级 |
|---|---|---|---|---|
| Gitee | gitee.com | 国内 | 审核安全版 | ⭐⭐⭐⭐ |
| GitCode | gitcode.com | 国内 | 审核安全版 | ⭐⭐⭐ |
| CNB | cnb.cool | 国内 | 审核安全版 | ⭐⭐⭐ |
| GitLab | gitlab.com | 海外 | 原版 | ⭐⭐⭐ |
| Codeberg | codeberg.org | 海外 | 原版 | ⭐⭐⭐ |

国内平台用 `README.cn-mirror.md`（弱化加密货币措辞，过审更稳）。
海外平台用原版 `README.md`。

## 一次性准备工作

### 1. 在各平台建空仓库

每个平台注册账号，创建**公开**空仓库 `moneyswitch`（不要初始化 README / .gitignore）：

| 平台 | 新建仓库地址 | 填进 config 的 `repo` 格式 |
|---|---|---|
| Gitee | https://gitee.com/projects/new | `你的用户名/moneyswitch` |
| GitCode | https://gitcode.com/new | `你的用户名/moneyswitch` |
| CNB | https://cnb.cool/new | `组织或用户名/moneyswitch` |
| GitLab | https://gitlab.com/projects/new | `你的用户名/moneyswitch` |
| Codeberg | https://codeberg.org/repo/create | `你的用户名/moneyswitch` |

### 2. 生成访问令牌

每个平台生成一个有 **write_repository / push** 权限的 Personal Access Token：

| 平台 | 令牌设置页 | 权限 |
|---|---|---|
| Gitee | https://gitee.com/profile/personal_access_tokens | 项目 → 读写 |
| GitCode | https://gitcode.com/settings/token | 代码仓 → 读写 |
| CNB | https://cnb.cool/settings/tokens | 仓库 → 读写 |
| GitLab | https://gitlab.com/-/user_settings/personal_access_tokens | `write_repository` |
| Codeberg | https://codeberg.org/user/settings/applications | `write:repository` |

### 3. 配置本地脚本

```powershell
# 复制配置模板
Copy-Item scripts\mirror.config.example.json scripts\mirror.config.json
# 编辑 mirror.config.json，把 YOUR_* 换成你的用户名/组织名
```

令牌放环境变量（**不要写进 config 文件**）：

```powershell
# PowerShell —— 当前会话
$env:GITEE_TOKEN = "gitee_xxx"
$env:GITCODE_TOKEN = "gitcode_xxx"
$env:CNB_TOKEN = "cnb_xxx"
$env:GITLAB_TOKEN = "glpat-xxx"
$env:CODEBERG_TOKEN = "codeberg_xxx"

# 或写进用户级环境变量（长期）
setx GITEE_TOKEN "gitee_xxx"
```

### 4. 首次推送

```powershell
# 先看会做什么
node scripts/mirror-push.mjs --dry-run

# 配置 git remote（可选，也方便手动 push）
node scripts/mirror-push.mjs --setup

# 实际推送
node scripts/mirror-push.mjs

# 只推某一个
node scripts/mirror-push.mjs --only gitee
```

## GitHub Action 自动同步

推到 `main` 或打 `v*` tag 时，自动推到所有已配置的镜像。

### 在 GitHub 仓库设置 Secrets

路径：**Settings → Secrets and variables → Actions → New repository secret**

| Secret 名 | 值 |
|---|---|
| `GITEE_TOKEN` | Gitee 个人访问令牌 |
| `GITEE_REPO` | `你的用户名/moneyswitch` |
| `GITCODE_TOKEN` | GitCode 令牌 |
| `GITCODE_REPO` | `你的用户名/moneyswitch` |
| `CNB_TOKEN` | CNB 令牌 |
| `CNB_REPO` | `组织或用户名/moneyswitch` |
| `GITLAB_TOKEN` | GitLab PAT |
| `GITLAB_REPO` | `你的用户名/moneyswitch` |
| `CODEBERG_TOKEN` | Codeberg 令牌 |
| `CODEBERG_REPO` | `你的用户名/moneyswitch` |

只配一部分也可以：Action 会跳过缺少 secret 的平台。

### 验证

推一次 `main`，在 GitHub **Actions → Mirror** 里看日志。
或手动触发：**Actions → Mirror → Run workflow**。

## 国内平台过审要点

`README.cn-mirror.md` 已按以下原则改写，降低被拒审/下架概率：

| 原版表述 | 安全版表述 | 原因 |
|---|---|---|
| Web3 云钱包 | 可编程支付网关 | 「钱包 + 虚拟货币」易触发金融类审核 |
| USDC / 稳定币 | 链上稳定币结算 / 结算通道 | 技术事实保留，不作价值宣传 |
| 真钱 | 正式环境资金 | 「真钱」口语化，易被误判为赌博/交易 |
| 测试币没有价值 | 测试环境，无货币价值 | 同上 |
| Monad / Base 主网 | 正式环境 A / B | 弱化具体公链品牌，详情在 SPEC |
| 链上交易 | 结算凭证 | 避免「交易」关键词 |
| 出资人 | 管理员 | 「出资」有集资联想 |

另外注意：

- 不要在描述、标签里出现：**炒币、数字货币交易、虚拟货币理财、入金、出金、提币、交易所**。
- 仓库 Topics/标签建议用：`ai-agent` `payment` `api-gateway` `self-hosted` `spending-control` `automation`。
- 如果平台拒审，可在申诉里说明：「开发者工具，自托管支付编排，非金融业务，无面向公众的集资或交易功能」。
- Gitee 对「钱包」类项目审核较严；若仍被拒，把标题改成 **MoneySwitch — AI Agent 费用管控与支付编排工具** 再提交。

## 同步机制说明

- 国内镜像推送时，脚本会临时把 `README.md` 换成 `README.cn-mirror.md` 再推，推完还原。
- 使用 `git push --force` 到镜像仓的 `main`；镜像仓不要接受外部 PR，否则会被下次同步覆盖。
- Tags 也会同步，方便镜像仓用户下载 Release 产物（Release 附件本身只在 GitHub）。

## 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| `403` / `Authentication failed` | 令牌过期或权限不足 | 重新生成令牌，确认有 write 权限 |
| `repository not found` | `repo` 路径写错，或仓库是私有的 | 核对 `用户名/仓库名`，改为公开仓 |
| Gitee 推上去后 README 不对 | 用了原版 README | 确认 config 里 `"cn": true` |
| Action 里某平台被跳过 | 对应 secret 未配置 | 补齐 `*_TOKEN` 和 `*_REPO` |
| Windows 下中文乱码 | 控制台编码 | `chcp 65001` 或用 Windows Terminal |

## 别忘了

镜像建好后，在以下位置补上链接：

- [ ] `README.md` 底部加「其他镜像」小节
- [ ] 官网 moneyswitch.dev 的页脚 / 下载页
- [ ] 各平台仓库描述写同一句话，便于搜索
