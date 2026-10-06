# x402 测试网收款验证服务

给新用户和新部署用来确认「付款端设置对了」的一个小服务：一个收费接口，每次 **0.01 测试 USDC**，只在 **Monad 测试网**，没有真实价值。

- 说明页：<https://app.moneyswitch.dev/x402-testnet/>
- 收费接口：`GET https://app.moneyswitch.dev/x402-testnet/check`
- 价格：每次 **0.01 测试 USDC**（10000 最小单位），网络 `eip155:10143`（Monad 测试网）。
- USDC 合约：`0x534b2f3A21130d7a60830c2Df862319e593943A3`。收款地址显示在说明页上。

没有主网收款服务。设置 `RECEIVER_MODE=mainnet`（或任何不是 `testnet` 的值）会让进程拒绝启动，而不是悄悄变成别的东西。

## 使用

在付款端创建 MoneyKey（实例启用了 Monad 测试网时，建 **测试网 key** 的表单里勾选「允许测试付款接口」即可，它会加上允许域名 `app.moneyswitch.dev:443`；主网 key 不提供这个选项），每笔和总额可先设为 `0.01`。向付款端的 `POST /v1/fetch` 发送下面的 JSON，并用该 Key 认证：

```json
{"url":"https://app.moneyswitch.dev/x402-testnet/check","method":"GET","max_price":"0.01"}
```

浏览器直接访问收费接口返回 HTTP 402 是正常报价，不会扣款。客户端签名付款后，服务通过 facilitator 验证和结算；成功返回 JSON 验证结果及 `PAYMENT-RESPONSE` 收据。保留交易哈希并在链上核对。若状态为不确定或 `charged: maybe`，先核对交易，不能自动重试。

付款钱包必须解锁（默认由服务器自动解锁，见 `docs/wallet-setup.md`），Key 的额度和域名白名单也必须满足，钱包里要有测试 USDC。收款服务只使用公开收款地址，不加载钱包、密码或管理员凭据。协议参考：[Monad 官方 x402 指南](https://docs.monad.xyz/guides/x402)。

## 构建与部署

在完成仓库依赖安装和构建后运行 `node scripts/build-receiver.mjs`，得到 `.data/receiver-release/`，包括独立 Node bundle、Dockerfile、Caddy 片段、启动脚本和 SHA256SUMS。依赖来自仓库锁定的 x402 SDK 2.27.0，由现有 esbuild 打包。

上传该目录的文件到服务器的一个新 release 目录，在该目录执行：

```sh
PAY_TO=<收款地址（公开地址）> sh ./run-receiver.sh
```

容器 `moneyswitch-receiver-testnet`，镜像 `moneyswitch-receiver:testnet`，容器内监听 4021，宿主机只发布 `127.0.0.1:4031`；Caddy 把 `/x402-testnet/*` 转发给它。容器使用只读文件系统、普通用户，不挂载钱包或任何密钥，日志仅记录成功结算的公开交易信息。

部署脚本拒绝覆盖已有同名容器。Caddy 变更前留备份并验证（`activate-caddy.sh`）。回滚时恢复备份中的 MoneySwitch 片段，验证并 reload Caddy，再停止收款容器。

## 验证

`node --test apps/demo-seller/receiver.test.mjs` 覆盖准确报价（0.01、测试网 USDC 合约、收款地址）、无效签名拒绝、结算失败不提供内容、成功结算返回收据，以及「没有主网路径、拒绝 `RECEIVER_MODE=mainnet`」。结算成功/失败的单元测试使用模拟 facilitator，不代表真实链上付款。

验证结果必须包含结算收据/交易哈希与 MoneySwitch「账单」页里的这一笔；单独收到 HTTP 402 只说明报价成功。若付款人与收款人为同一个钱包，链上余额可能不变，但受限 Key 的付款额度仍会消耗。
