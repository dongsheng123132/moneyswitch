# Solana 主网 USDC 付款

Solana 主网付款需要管理员显式启用。查看主网余额和充值不会自动开启付款，也不会更改已有 MoneyKey 的网络类型。

## 启用

把 `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` 追加到现有 `MONEYSWITCH_NETWORKS`，保留原列表和 `MONEYSWITCH_DEFAULT_NETWORK`。例如同时保留三条测试链：

```sh
export MONEYSWITCH_NETWORKS=eip155:10143,eip155:84532,solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1,solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
export MONEYSWITCH_SOLANA_MAINNET_RPC_URL=https://api.mainnet-beta.solana.com
```

修改后重启服务。默认配置继续只启用原有测试网；`MONEYSWITCH_MAINNET_ENABLED` 的历史开关只选择 Monad，不会开启 Solana 主网。

美国服务器的发布包可以在其 `/opt/moneyswitch/releases/<revision>` 目录中执行：

```sh
sh upgrade-us.sh --enable-solana-mainnet
```

这个选项读取旧容器的有效网络列表，先备份原配置、停止写入并验证数据备份，再原子追加 Solana 主网；已有网络、默认链和其他配置保留。没有网络列表的历史配置保留原有效 Monad 网络。未知参数拒绝执行。配置更新、容器启动或健康检查失败时，恢复原配置和旧容器；不删除数据卷，不更换钱包，也不发送付款。无此选项的升级不会新增付款网络。

## 地址、资金和 MoneyKey

Solana 主网和 Devnet 使用同一个派生地址，两个网络的余额分别查询。EVM 地址和 Solana 地址不同，尽管两者来自同一份加密恢复词。主网接受 Circle USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`，6 位小数；Devnet USDC mint 和测试币余额不能用于主网付款。付款客户端使用该钱包的 USDC associated token account，其他 token account 中的币不计入其可付款余额。

使用 `network_mode: "mainnet"` 的 MoneyKey。测试网 key 继续只能花测试币；主网和测试网同时启用时，没有类型的旧 key 继续只允许测试网，不能因升级而花到真钱。已有预算、域名白名单、撤销状态和人工审批继续生效。

要固定选择 Solana 主网，`POST /v1/fetch` 传：

```json
{
  "url": "https://seller.example/protected",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "max_price": "0.01",
  "purpose": "Solana mainnet connectivity check"
}
```

这是请求格式示例，不是已验证的卖家。固定网络后，卖家未接受该网络、key 类型不匹配或余额不足时不会改到其他链付款。主网付款使用真实 USDC；启用网络本身不会扣款。

## 卖家与手续费

卖家必须报价 x402 v2 `exact`、Solana 主网 CAIP-2 和主网 USDC mint，并提供 `extra.feePayer`。手续费付款人必须与 MoneySwitch 钱包不同；钱包不能兼任 fee payer，否则 SOL 手续费会绕过 MoneyKey 的 USDC 预算。手续费由卖家或 facilitator 的独立 sponsor 支付，不要求往 MoneySwitch 钱包充值 SOL。

卖家采用的 facilitator 必须实际支持上述主网、协议版本和 scheme。网络配置里的 facilitator 地址不保证任意卖家能结算；只支持 Devnet 的演示卖家不能用真钱测试，要求 CDP 认证的端点也不能在缺少相应服务端凭据时视为可用。

## 不确定扣款

签名交易在发送前保存。重启、超时、RPC 失败、空交易历史和过期 blockhash 都不能证明未扣款；额度保持预留，直到匹配的 finalized 交易证明成功或执行失败。保留账单和对账证据，不删除 `unknown` 记录来重试付款。启用主网和显示余额不等于完成主网结算验证，真实付款验证须单独记录金额、交易 ID 和 finalized 链上证据。

参考：[Solana 网络](https://solana.com/docs/references/clusters)、[Circle USDC 合约地址](https://developers.circle.com/stablecoins/usdc-contract-addresses)、[官方 x402 SVM 实现](https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/svm)。Devnet 的独立验证记录见 [solana-devnet.md](solana-devnet.md)。
