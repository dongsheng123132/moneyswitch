# 钱包创建、恢复与真实测试网验收

日期：2026-10-03（Asia/Shanghai）。本地代码基线 `ec7b89a`。

## 钱包与资金边界

- 旧主网钱包 `0xAB094E59e980c45D735F407514bEBdfc8a365C6E` 仍然锁定，余额 0.52 USDC。没有从它转出资金。
- 原 Monad 测试网钱包 `0xFEd3f24cee2B3E2d94ad9f561ead4fEA589Ce2e3` 的已保存密码验证成功。启动前通过 SQLite backup API 备份原数据库，并复制加密钱包备份。
- 新测试钱包 `0xa6B560320Be77563dC31e4d5A90132Bff8aF5B87` 使用独立目录 `C:/1mineyswitch/.data/testnet-new-20261003`，保存了随机密码、加密钱包及加密备份。没有覆盖旧钱包。
- 所有本次结算使用 Monad 测试网 `eip155:10143`，USDC 合约 `0x534b2f3A21130d7a60830c2Df862319e593943A3`。

## 真实链上收款和付款

使用仓库独立的 `apps/demo-seller` 启动两个本地接收端，真实结算经 `https://x402-facilitator.molandak.org`。没有使用 mock facilitator，也不是对 Nansen 的主网购买。

| 验证 | 金额 | 交易 |
| --- | --- | --- |
| 原测试钱包付款，新钱包收款 | 0.01 测试 USDC | [收款交易](https://testnet.monadvision.com/tx/0xb52e956608b73e87a6546ce2e8168c7e9d69ed8d8b7732cb855fc8b20d9bf982) |
| 新钱包付款，原测试钱包作为测试接收方 | 0.01 测试 USDC | [付款交易](https://testnet.monadvision.com/tx/0xe9b892e043bf031af619167099faba3e16e798b0f79c5a39ee3cadc7c10bd091) |

两笔均通过 MoneySwitch `/v1/fetch`，返回 `status: ok`、`charged: yes`、上游 HTTP 200、`mock: false`，并返回报告正文。随后独立查询 Monad RPC，确认交易状态成功、USDC Transfer 的发送方/接收方及金额均正确。

每笔使用独立 MoneyKey，总额/日额/单笔均为 0.01，限于对应本地接收端，测试结束后撤销。调用前写入独占标记防止脚本重跑；没有重试付费请求。

最终余额：新测试钱包 0，原测试钱包 1.51 测试 USDC，旧主网钱包 0.52 USDC。新钱包收到的 0.01 已用于第二笔测试，回到原测试钱包。

## 本地功能验证

- Wallet driver：8 项通过，包括新建、私钥导入、加密备份恢复同地址、错误密码拒绝、已有钱包不被覆盖、并发创建、KDF 上限及余额 RPC 错误处理。
- Server：钱包导入/备份和日志保护相关 3 项通过。覆盖管理员权限、拒绝员工 Key、加密备份可恢复、导入数据与错误 JSON 不回显秘密。
- Dashboard：51 项现有测试通过；前后端构建通过。
- 在独立、无资金的临时环境中运行 Playwright：三种入口、新建、下载并解密备份、错误密码失败、正确恢复同地址、私钥导入均通过。临时浏览器和服务已关闭。

代码改动在本地验收；尚未更新线上 `app.moneyswitch.dev`。

余额查询原先使用 ethers 的独立 HTTP 连接，绕过服务器的代理，导致本机页面余额为空。现已改用付款共用的 fetch 连接及 15 秒超时；重启新测试实例后 `/v1/admin/wallet` 正确返回余额 `0`、已解锁、真实测试网模式。
