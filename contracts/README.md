# QDayPayReceiver — x402 收款方合约（QDay Aevum testnet）

> One-liner: the `payTo` contract for x402 settlements on QDay Aevum testnet (`chainId 44005`).
> It pulls a payer's EIP-3009 `TransferWithAuthorization` into itself, forwards it to the merchant,
> and records the business order — **all in one atomic transaction**, so money and receipt can never
> diverge. Non-upgradeable, dependency-free, no funds held between calls.

---

## 1. 为什么是「合约当 payTo」

x402 的 exact-EVM 付款里，买家离线签一张 EIP-3009 `TransferWithAuthorization`，`to` 就是 402 报价里的 `payTo`。
如果 `payTo` 是一个普通 EOA，链上只发生「币动了」，商家还得事后把链上转账和业务订单对账，两个坑：

- **对账是的事后动作**：付款成功但 HTTP 响应丢了，客户端会**重试**；重试生成**新 nonce** 的新授权，于是 **tUSD8 被扣两次** —— EIP-3009 只防 nonce 重放，不防「业务订单」重放。
- **收据不在链上**：谁付的、对应哪个订单，只能靠链下记账。

把 `payTo` 指向本合约，卖家结算时调 `pay(orderId, ...)`，一笔交易内完成「验签收款 → 转商户 → 记订单」：

```
   payer (AI agent / 用户)
      │ ① 离线签 EIP-3009 TransferWithAuthorization
      │    domain: name="tUSD8", version="2", chainId=44005, verifyingContract=tUSD8
      │    to = receiver（即 402 报价里的 payTo）
      ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │ QDayPayReceiver.pay(orderId, from, value, validAfter,             │
   │                          validBefore, nonce, v, r, s)             │
   │                                                                   │
   │   checks : orders[orderId] == false  ← 业务幂等（防二次扣款）        │
   │            value != 0, from != 0, beneficiary != 0                │
   │            validAfter <= now < validBefore                        │
   │   ───────                                                         │
   │   effects: orders[orderId] = true                                 │
   │   ───────                                                         │
   │   interact: ② tUSD8.transferWithAuthorization(from, this, ...)    │
   │                └─ 真代币验签 + 烧 nonce，钱进合约                    │
   │             ③ 余额增量必须 == value（防「假成功」代币）              │
   │             ④ tUSD8.safeTransfer(beneficiary, value)              │
   └───────────────────────────────────────────────────────────────────┘
      │ ⑤ emit PaymentReceived(orderId, from, value, nonce, beneficiary)  ← 链上收据
      ▼
   merchant (beneficiary) 收到钱；合约余额回到 0
```

`pay` **任何人可调用**（卖家 / 中继 / 买家都行）：授权凭据是买家的 EIP-3009 签名，不是 `msg.sender`。

## 2. 合约接口

| 函数 | 权限 | 说明 |
|---|---|---|
| `constructor(address token, address owner_, address beneficiary_)` | — | 三者任一为零地址则 revert |
| `pay(bytes32 orderId, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)` | 任何人 | 原子收款：验幂等 → 拉币 → 验到账 → 转商户 → 记订单 + 事件。任一步失败整笔回滚 |
| `setBeneficiary(address)` | owner | 换商户收款地址，emit `BeneficiaryChanged` |
| `rescue(address token, uint256 amount)` | owner | 只能扫**非 tUSD8** 的误入代币；动 tUSD8 直接 revert `ProtectedToken` |
| `transferOwnership(address)` | owner | 移交管理权 |
| `token() / owner() / beneficiary() / orders(bytes32) / isOrderPaid(bytes32) / tokenBalance()` | view | 便于脚本断言 |

不变量：

- **不留存资金**：`pay` 内收进多少立即转出多少；合约 tUSD8 余额在交易外恒为 `0`（e2e 与测试都断言这一点）。
- **一单一次**：`orders[orderId]` 一旦为真永不复位；重试必须换 `orderId` 或走幂等查询。
- **fail-closed**：`SafeERC20` 把「revert」和「返回 false」都当失败；余额增量不等于 `value` 也回滚。
- **不可升级**：没有代理、没有 `delegatecall`。
- **`nonReentrant`** 保护 `pay`（即使代币有回调钩子也无法重入）。

## 3. 三条命令

前置：forge 不在 PATH，全部用绝对路径 `~/.foundry/bin/{forge,cast,anvil}`；solc 0.8.24 已缓存在 `~/.svm/0.8.24/solc-0.8.24`（本机 macOS arm64 无原生 solc，跑的是 `macosx-amd64` 版，Rosetta 执行）。工程**零外部依赖**（没有 forge-std / OZ，见 §8）。

### ① 单元测试（28 用例）

```bash
cd contracts
~/.foundry/bin/forge test -vv
```

实测：`Ran 1 test suite ... 28 tests passed, 0 failed, 0 skipped (28 total tests)`，套件耗时 ~7-9 ms。
无网络时加 `--offline` 一样跑（solc 走本地缓存）。

### ② 本地 fork e2e（真 tUSD8、impersonate 真大户）

```bash
bash contracts/script/e2e-fork.sh        # 从仓库根跑；需要在 contracts/ 内跑也可以
```

脚本自己起 anvil fork（**端口 8547**，lead 的 fork 在 8546），跑完自动关掉。它做的 10 步：

1. 每轮随机生成 deployer/owner、seller、payer、merchant（不落盘）
2. `anvil --fork-url https://rpc-test.qday.info`，校验 `chainId == 44005`
3. 用**生产部署脚本** `script/Deploy.s.sol` 部署 receiver，并从 `broadcast/Deploy.s.sol/44005/run-latest.json` 取地址，回读 `token()/owner()/beneficiary()` 断言构造参数
4. `anvil_impersonateAccount` 真实 tUSD8 大户 `0x94ef…9C05`（持有 1,098,812.003909 tUSD8），转 **0.01 tUSD8** 给 payer
5. payer 离线签 EIP-3009（`name="tUSD8", version="2"`），并用 `cast call` 让**真代币**预检签名（签名错这里就炸，不会到 pay）
6. **seller** 提交 `pay(...)` —— 证明不是付款人也能结算
7. 断言：商户 `+0.01 tUSD8`、payer 归零、合约余额为 `0`
8. 从 `cast receipt` 解析 `PaymentReceived`，断言 emitter/`topic1 == orderId`/value/nonce
9. 用**新 nonce 重放同一 orderId**，断言 revert `OrderAlreadyPaid`、商户余额不动
10. 打印汇总（部署地址、fund tx、pay tx、三处余额前后）

### ③ 部署到真测试网（私钥只走 env）

```bash
cd contracts
export PRIVATE_KEY=0x...            # 只放环境变量，别写进文件/命令行历史
export BENEFICIARY=0xMerchantAddr   # 商户收款地址（不给则默认 = OWNER = deployer）
# export OWNER=0x...                # 可选，默认 = deployer
# export TUSD8=0x...                # 可选，默认就是 QDay tUSD8

~/.foundry/bin/forge script script/Deploy.s.sol \
  --rpc-url https://rpc-test.qday.info \
  --broadcast
```

输出会打印 chainId / 三个构造参数 / 部署地址（`MiniConsole` 走 forge 的 console 通道），交易详情落在 `broadcast/Deploy.s.sol/44005/run-latest.json`。

清空环境变量：`unset PRIVATE_KEY BENEFICIARY OWNER TUSD8`。

## 4. e2e 真实输出（2026-11-10，本机实跑）

```
=== 3. Deploying QDayPayReceiver (forge script script/Deploy.s.sol --broadcast) ===
  receiver deployed at   0x2381e7174d4622810b824e52bc3d858160a43df0
  token()                0x456569838f1d43009A91ebA4263147Afd7233483
  owner()                0xafc57a8732f373124B97466F60d0930b5D74ec4C
  beneficiary()          0xEC55608D5d5ad5d6DB1f587726FBe41e96D58FAf

=== 4. Funding payer from real tUSD8 holder 0x94ef…9C05 ===
  whale balance before   1098812003909
  payer  balance before  0
  fund tx hash           0xdb4f9e4f02c99f8a8457f602b2455fb5fd7e5cc48a317202723ff35039d7abd3
  payer  balance after   10000

=== 5. Signing EIP-3009 TransferWithAuthorization (off-chain, to = receiver) ===
  digest                 0x4cc0e780db1cb2d10b88abb9b6067aa870be94cbf866187daef4a486723d60d7
  signature pre-check: token accepts it (would succeed)

=== 6. Seller submits receiver.pay(...) — one transaction, money + receipt together ===
  pay tx hash            0x8e2dfbd2ed564e369d017b20ff0473c8f7474c3f95b0619039e54823adec4826

=== 7. Balances (before -> after) ===
  merchant (beneficiary)                0 -> 10000          (want +10000)
  payer                             10000 -> 0              (want 0)
  receiver contract                     0 -> 0              (want 0: nothing stranded)

=== 8. On-chain receipt: PaymentReceived event + order state ===
  orders(orderId)        true
  event             PaymentReceived
  event orderId     0xd8b461f6efccb51c790e8698f36eade2fac24ff7dbfbd36b07d303bd0dee4f27  (topic1 match)
  event value       10000
  event nonce       0x696b10859a993513a8eccec6203a8cdd714e9e6723071de84ce328e67cdcd052

=== 9. Replay protection: same orderId with a brand-new nonce + signature ===
  second attempt         reverted with OrderAlreadyPaid(0xd8b4…) as expected
  merchant unchanged     10000 (still 10000)

ALL ASSERTIONS PASSED
```

## 5. 测试覆盖（28 用例）

| 规格要求 | 用例 |
|---|---|
| 正常 pay 转给商户 | `test_PaySettlesToBeneficiary`、`test_PayLeavesNoFundsInContract` |
| 事件字段正确 | `test_PayEmitsPaymentReceived`（`vm.expectEmit` 逐字段） |
| 重复 orderId revert | `test_PayRevertsOnDuplicateOrderId` |
| 重复 orderId（新 nonce 也不行） | `test_PayRevertsOnDuplicateOrderIdWithFreshNonce` |
| nonce 重放 revert | `test_PayRevertsOnNonceReplayWithNewOrderId` |
| 授权过期 revert | `test_PayRevertsOnExpiredAuthorization`、`test_PayRevertsOnValidBeforeBoundary` |
| 未到期 revert | `test_PayRevertsWhenNotYetValid`、`test_PaySucceedsAfterValidAfterPasses` |
| 签名者 ≠ from revert | `test_PayRevertsWhenSignerIsNotPayer` |
| value = 0 revert | `test_PayRevertsOnZeroValue` |
| 零地址校验 | `test_PayRevertsOnZeroOrderId` / `OnZeroFrom` / `ConstructorRevertsOnZero{Beneficiary,Token,Owner}` |
| beneficiary = 0 revert | `test_ConstructorRevertsOnZeroBeneficiary` |
| setBeneficiary 仅 owner | `test_SetBeneficiaryRevertsForNonOwner`（+ 非零校验、改后路由新商户） |
| rescue 不能动 tUSD8 | `test_RescueRevertsForSettlementToken`（+ 非 owner 拒、扫其他币） |
| 其他 | `test_PayCallableByAnyone`、`test_TransferOwnership*`、`test_ConstructorWiresState` |

测试里的 `MockEIP3009Token`（`test/mocks/`）是**真 ecrecover 验签**的 EIP-3009 代币，domain 参数化成 tUSD8 的 `name="tUSD8", version="2"`，不是「永远返回 true」的假验签。

## 6. 字节码核对（已实测）

目标：证明链上代码 == 仓库源码编译结果。设置：**solc 0.8.24、optimizer 开、runs=200、via_ir=false、无 library 链接**（见 `foundry.toml`）。

```bash
cd contracts
ADDR=0x<已部署地址>

# 本地编译产物（runtime code）
~/.foundry/bin/forge inspect src/QDayPayReceiver.sol:QDayPayReceiver deployedBytecode > /tmp/expected.hex
~/.foundry/bin/cast code $ADDR --rpc-url https://rpc-test.qday.info > /tmp/actual.hex

python3 - "$ADDR" <<'PY'
import sys
exp = open('/tmp/expected.hex').read().strip().lower().removeprefix('0x')
act = open('/tmp/actual.hex').read().strip().lower().removeprefix('0x')
TOKEN = '456569838f1d43009a91eba4263147afd7233483'  # 不写 0x；immutable 在部署时被写进 runtime code
print('expected bytes:', len(exp)//2, '| actual bytes:', len(act)//2)
# forge inspect 输出的 immutable 槽位是 0；链上那份里嵌的是真实 token 地址 → 先把两边抹平再比
mask = lambda h: h.replace('00'*12 + TOKEN, '00'*32)
print('RAW EQUAL        :', exp == act)
print('EQUAL AFTER MASK :', mask(exp) == mask(act))
PY
```

本机实测（部署到本地 anvil，同一份源码）：

```
expected bytes: 2937 | actual bytes: 2937
RAW EQUAL        : False      # ← 只差 immutable 的 token 地址那 32 字节
EQUAL AFTER MASK : True       # ← 抹掉后逐字节一致
```

注意两点，别误判成「代码被改过」：

- `token` 是 `immutable`，值在**部署时**烤进 runtime code。`forge inspect` 给的是占位 0，所以直接 `diff` 必然不等 —— 要按上面把该 32 字节抹平。
- 尾部 53 字节是 solc 的 CBOR metadata（含编译器版本串，例如 `0.8.24+commit.e11b9ed9.Darwin.appleclang`）。**换平台编译**（Linux 版 solc）代码段仍一致，但这段 metadata 会不同；想只看代码逻辑就再截掉末尾 106 个 hex 字符。本机因为 `Darwin` 串也一致，抹 immutable 后**整体**相等。

复算事件（不依赖本仓库脚本）：

```bash
~/.foundry/bin/cast receipt <pay_tx_hash> --json --rpc-url https://rpc-test.qday.info
# topic0 = cast keccak 'PaymentReceived(bytes32,address,uint256,bytes32,address)'
# topic1 = orderId(padded)  topic2 = from  topic3 = beneficiary
# data   = value(32B) ++ nonce(32B)
~/.foundry/bin/cast call <receiver> 'orders(bytes32)(bool)' <orderId> --rpc-url https://rpc-test.qday.info
```

## 7. 目录结构

```
contracts/
├── foundry.toml              # solc 0.8.24 / optimizer 200 / via_ir=false
├── README.md
├── src/
│   ├── QDayPayReceiver.sol   # 主体
│   ├── interfaces/IERC20.sol
│   ├── interfaces/IERC3009.sol
│   ├── libraries/SafeERC20.sol
│   └── utils/ReentrancyGuard.sol
├── test/
│   ├── QDayPayReceiver.t.sol # 28 用例
│   ├── mocks/MockEIP3009Token.sol
│   └── utils/TestBase.sol    # 自写的 vm cheatcode 子集 + 断言（替代 forge-std）
└── script/
    ├── Deploy.s.sol          # 生产部署脚本（PRIVATE_KEY 走 env）
    ├── e2e-fork.sh           # fork 端到端
    └── utils/{ScriptBase,MiniConsole}.sol
```

## 8. 依赖策略：零外部依赖

`forge install openzeppelin-contracts` / `forge-std` 会往**仓库根**写 `.gitmodules`，超出本目录的修改范围；网络也不稳。因此：

- **不用 forge-std**：`test/utils/TestBase.sol` 自写 `Vm` 接口（`warp/prank/expectRevert/expectEmit/sign/addr/setBalance…` 用到哪几个写哪几个）+ 断言；`script/utils/MiniConsole.sol` 用 console 地址（`0x…636F6e736f6c652e6c6f67`）自写 `console.log`。
- **不用 OpenZeppelin**：`SafeERC20`、`ReentrancyGuard` 各 ~20 行，语义对齐 OZ。

好处：`git clone` 后无需 `forge install`、无 submodule、`--offline` 直接可跑；币安/审计视角也少一份供应链面。

## 9. 安全边界与已知限制（如实写）

- **信任模型**：owner 能改 `beneficiary`（可把后续收款导向别处）、能扫非 tUSD8 币。这是「商家自营收款合约」的模型，不适合把 owner 交给不受信第三方。
- **`orderId` 由卖家生成**：同一 `orderId` 一旦被用掉就永久占用。若卖家误用相同 `orderId` 收第二笔真实业务，会被拒 —— 这是幂等设计的代价，`orderId` 必须全局唯一（建议 `sha256(receiptId)`）。
- **不收手续费/抽成**：全额转给 beneficiary。
- **不兼容 fee-on-transfer 代币**：`received != value` 会直接回滚（对 tUSD8 无影响，是故意的 fail-closed）。
- **不校验 `to` 是否被代币拉黑**：交给代币自身，失败则整笔回滚。
- **单笔金额上限/日限额**：**没有**。这是原 `QDayAgentBudget`（会话预算托管）方案被砍掉后的范围收缩 —— 本合约只做「真实支付链路」，预算策略应由 x402 报价层（`maxAmountRequired`）承担。

## 10. 踩坑记录（QDay fork / forge 相关，都给过报错原文）

1. **solc 下不下来 → forge build 直接吊死 6 分钟无输出**。本机 `~/.svm` 为空，`forge build` 会去 `binaries.soliditylang.org` 拉 79 MB；走代理只有 ~6-13 KB/s，`curl` 也 180s 超时（`curl: (28) Operation timed out after 180012 milliseconds with 38485890 out of 78981344 bytes received`）。
   解决：手动断点续传落到 svm 缓存目录 —— 文件名必须是 `solc-0.8.24`：
   `curl -L -C - https://binaries.soliditylang.org/macosx-amd64/solc-macosx-amd64-v0.8.24+commit.e11b9ed9 -o ~/.svm/0.8.24/solc-0.8.24 && chmod +x …`
   注意 **macOS arm64 没有原生 solc**（`macosx-aarch64/list.json` 是 404），只能用 `macosx-amd64` 靠 Rosetta 跑。
2. **`cast block latest timestamp` 输出为空**（拿不到字段，`validBefore` 变成 3600 → 代币报 `authorization is expired`）。改用 `cast block latest --json | python3 -c '…["timestamp"]…'`（hex 转 int）。
3. **`expectRevert(bytes4)` 在本版 Foundry 是「完整 revert data 精确匹配」**。带参数的 custom error 会失败：
   `Error != expected error: OrderAlreadyPaid(0x7dfd…) != custom error 0x355803e4`。
   解决：`vm.expectRevert(abi.encodeWithSelector(SEL, arg1, …))` —— 顺带把参数也断言了，比只对 selector 更强。
4. **`staticcall` 写在 `pure` 函数里编译报错**（0.8.24）：`Error (2527): Function declared as pure, but this expression … requires "view"`（自写 console.log 时踩到）。改 `view`。
5. **随机账户部署静默失败**：脚本只打印了模拟结果，`cast code` 拿到 `0x`。原因是随机 key 在本地 anvil 上没有 gas，broadcast 失败。部署前必须 `anvil_setBalance`（e2e 脚本里已做）。
6. **QDay 的 RPC 把 `eth_getLogs` 限死在 1000 块**：`{"code":-32000,"message":"block range too large, max range: 1000"}`，想扫 Transfer 找大户得循环分块（2,795,000 块要 2795 次）。改走「已知持有者直接 `balanceOf` 探测」：tUSD8 `owner()` = `0x94ef…9C05` 持有 1,098,812.003909 tUSD8，直接当大户用。
7. **tUSD8 是升级代理、没有 mint**：`code` 只有 1496 字节，含 `implementation()`/`upgradeTo()` 选择器，`mint(...)` 不存在 → fork 上无法凭空造币，e2e 只能 impersonate 真实持有者。
8. **tUSD8 的 EIP-712 domain 版本是 `"2"`**（不是常见 USDC 的 `"2"`），代币报错串是 `FiatTokenV2: …`（USDC 同源实现）。签成 `version="1"` 会报 `FiatTokenV2: invalid signature`；e2e 里有一步用真代币 `cast call` 预检，签错当场暴露。
9. **forge script 的地址要从 broadcast JSON 取**：`broadcast/Deploy.s.sol/44005/run-latest.json` 的 `transactions[].contractAddress`。scripts/cache 目录已进 `contracts/.gitignore`。
