# Windows 本地人工操作入口

MoneySwitch 可以由人直接在本地网页操作。AI、CLI 和网页共用同一个服务、钱包和权限系统。

## 一次安装，之后双击

源码安装先完成 `pnpm install`、`pnpm build`，本机需要 Node.js 22 或以上版本。在仓库根目录运行：

```powershell
# 示例：独立的 Monad 测试网实例；不会自动创建钱包或充值。
.\scripts\install-local-shortcut.ps1 -Name 'MoneySwitch - 测试钱包' `
  -DataDir "$env:USERPROFILE\.moneyswitch-testnet" -Port 4040 -Network 'eip155:10143'
```

桌面会出现指定名称的快捷方式。双击后：

1. 启动只监听 `127.0.0.1` 的后台服务；首次使用时保存管理员凭据。
2. 用本地管理员凭据申请有效期 60 秒、只能使用一次的登录链接。
3. 在默认浏览器打开钱包页。链接使用后会从地址栏移除，不需要手动复制管理员 Token。
4. 在页面里创建、导入、备份或解锁钱包。管理员登录不会绕过钱包密码，也不会自动付款。

重复双击会复用同一个实例。端口被其他程序占用、实例路径或网络不匹配时，启动器报错，不会替换其他服务。服务日志在所选数据目录的 `local-launcher.stdout.log` 和 `local-launcher.stderr.log`。

如需按已有密码文件自动解锁，安装快捷方式时增加 `-PasswordFile '你的私有密码文件路径'`。快捷方式只保存路径，不包含密码值。主网钱包和测试网钱包应使用不同的数据目录、端口和快捷方式名称。

停止指定实例（不影响其他实例）：

```powershell
.\scripts\start-local.ps1 -DataDir "$env:USERPROFILE\.moneyswitch-testnet" `
  -Port 4040 -Network 'eip155:10143' -Stop -NoBrowser
```

关闭浏览器不等于停止后台服务。不要移动源码目录，否则需要为新路径重新安装快捷方式；安装器不会覆盖已有同名快捷方式。

## 本机已安装的入口（2026-10-03）

| 桌面名称 | 本地地址 | 数据目录 |
| --- | --- | --- |
| MoneySwitch - 原主网钱包 | http://127.0.0.1:4020/wallet | `C:/1mineyswitch/.data/mainnet` |
| MoneySwitch - 测试钱包 | http://127.0.0.1:4040/wallet | `C:/1mineyswitch/.data/testnet-new-20261003` |

原主网入口不配置自动解锁密码。启动后实测余额 0.52 USDC、钱包锁定；原加密钱包文件校验值未变，没有转账。

## 验证

- Windows 自带 PowerShell 5.1：后台启动、健康检查、重复启动复用相同 PID 均通过。
- 临时无资金实例 + Playwright：一次性登录进入钱包页、清除 URL fragment、重复使用链接被拒绝。
- 本机入口与原首次设置接口相关 10 项测试通过，前后端生产构建通过。
- 已实际创建两个桌面快捷方式，并从原主网入口打开默认浏览器。
- 登录链接签发需要有效管理员认证；监听公网接口的服务不签发本机登录链接。本机地址本身不是免登录凭证。
