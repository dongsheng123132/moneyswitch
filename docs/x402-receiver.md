# x402 主网收款验证服务

- 说明页：<https://app.moneyswitch.dev/x402-receive/>
- 收费接口：`GET https://app.moneyswitch.dev/x402-receive/mainnet/check`
- 价格：每次 **0.1 USDC**（100000 最小单位），仅 **Monad 主网 `eip155:143`**。
- 收款地址：`0xc81fd592ba7de5f567538a9aea253d883618b6e2`，为现有美国服务器钱包地址。
- USDC 合约：`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`。

这是独立收款服务。现有 MoneySwitch 测试网实例的网络配置不变；同一个 EVM 地址的主网余额与测试网余额互相独立，主网收入不会显示成测试币。

## 使用

在付款端创建 MoneyKey，允许域名 `app.moneyswitch.dev:443`，每笔和总额可先设为 `0.1`。向付款端的 `POST /v1/fetch` 发送下面的 JSON，并用该 Key 认证：

```json
{"url":"https://app.moneyswitch.dev/x402-receive/mainnet/check","method":"GET","max_price":"0.1"}
```

浏览器直接访问收费接口返回 HTTP 402 是正常报价，不会扣款。客户端签名付款后，服务通过 Molandak facilitator 验证和结算；成功返回 JSON 验证结果及 `PAYMENT-RESPONSE` 收据。保留交易哈希并在链上核对。若状态为不确定或 `charged: maybe`，先核对交易，不能自动重试。

付款钱包必须解锁，Key 的额度和域名白名单也必须满足。收款服务只使用公开收款地址，不加载钱包、密码或管理员凭据。协议参考：[Monad 官方 x402 指南](https://docs.monad.xyz/guides/x402)。

## 构建与部署

在完成仓库依赖安装和构建后运行 `node scripts/build-receiver.mjs`，得到 `.data/receiver-release/`，包括独立 Node bundle、Dockerfile、Caddy 片段、启动脚本和 SHA256SUMS。依赖来自仓库锁定的 x402 SDK 2.27.0，由现有 esbuild 打包。

上传该目录的文件到美国服务器的一个新 release 目录，在该目录执行：

```sh
PAY_TO=0xc81fd592ba7de5f567538a9aea253d883618b6e2 sh ./run-receiver.sh
```

首次部署目录：`/opt/moneyswitch/receiver-releases/20261003-mainnet-010`。容器 `moneyswitch-receiver-mainnet`，镜像 `moneyswitch-receiver:mainnet-010`，仅发布 `127.0.0.1:4021`；Caddy 将 `/x402-receive/*` 转发给它。容器使用只读文件系统、普通用户，无钱包挂载，日志仅记录成功结算的公开交易信息。

部署脚本拒绝覆盖已有同名容器。Caddy 变更前留备份并验证；首次备份位于 `/opt/moneyswitch/caddy-backups/20261003-091843`。回滚时恢复该备份中的 MoneySwitch 片段，验证并 reload Caddy，再停止收款容器。

## 验证

`node --test apps/demo-seller/receiver.test.mjs` 覆盖准确报价、无效签名拒绝、结算失败不提供内容、成功结算返回收据。结算成功/失败单元测试使用模拟 facilitator，不代表真实链上付款。

2026-10-03：本地和美国服务器裸网均确认说明页 HTTP 200、主网报价 HTTP 402、原站点健康检查 HTTP 200；收款容器 healthy。

本次真实购买请求（没有成功付款）：

1. 用户提供的原 Key 仅允许 `127.0.0.1:4021`，购买美国接口返回 `HOST_NOT_ALLOWED`、`charged: no`。
2. 为同一笔用户授权的 0.1 USDC 购买，通过管理员 API 创建临时 Key，仅允许 `app.moneyswitch.dev:443`，单次/每日/总额度均为 0.1 USDC，15 分钟过期。调用返回 `WALLET_LOCKED`、`charged: no`，随后已撤销临时 Key。
3. 原付款钱包仍锁定，主网余额仍为 0.52 USDC；第一笔请求前后链上收款余额均为 0。没有产生交易哈希，也没有证明本次真实链上付款成功。付款端拒绝发生在向卖方发送签名之前。

只有找到原密码并解锁，或用独立保存的原始私钥/助记词恢复付款钱包，才能继续购买。下载同一个加密钱包备份、创建新的 MoneyKey、搭建自己的卖方，都不能代替原钱包签名。


## 独立测试网入口

`RECEIVER_MODE=testnet` 运行 Monad 测试网接收端：说明页 `/x402-testnet/`、收费接口 `/x402-testnet/check`，固定每次 0.01 测试 USDC；它不提供主网路径。默认模式仍为 mainnet，保留原来的 0.1 主网价格。

美国测试实例用独立容器 `moneyswitch-receiver-testnet`，宿主机 `127.0.0.1:4031` 映射容器 4021，通过 Caddy 的 `/x402-testnet/*` 转发；不挂载钱包或任何密钥。MoneyKey 需允许 `app.moneyswitch.dev:443`。

验证结果必须包含结算收据/交易哈希与 MoneySwitch 流水；单独收到 HTTP 402 只说明报价成功。若付款人与收款人为同一个钱包，链上余额可能不变，但受限 Key 的付款额度仍会消耗。
