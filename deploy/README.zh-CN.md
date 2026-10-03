# MoneySwitch 自建部署

规格见仓库根目录的 [SPEC.md](../SPEC.md)（唯一有效的规格）。数据库、额度、审批和加密钱包都保存在你自己的服务器上；浏览器是管理界面；AI 只拿一把有额度的 MoneyKey，通过技能调用 `/v1/fetch`。管理员令牌和钱包私钥不交给 AI。

## 先决条件：服务和 AI 分开

**不要把服务和 AI 放在同一台机器、同一个系统用户下**：AI 能直接读写数据库和数据目录，绕过额度，甚至拿到解锁文件。AI 只应该通过网络拿 MoneyKey 远程调用。

## Docker + HTTPS

要求 Linux、Docker Compose、一个指向服务器的域名。仓库根目录执行：

```sh
cp deploy/.env.example .env
mkdir -p deploy/secrets
# 旧版本建的密码钱包才用得上；docker-compose 会挂载它，所以文件必须存在，留空即可（空 = 未配置）。已有文件不要覆盖。
test -e deploy/secrets/wallet_password || (umask 077; touch deploy/secrets/wallet_password)
docker compose build server
docker compose up -d server
docker compose ps
curl --fail http://127.0.0.1:4020/healthz
```

修改 `.env`：`MONEYSWITCH_PUBLIC_URL` 必须是大家实际访问的 HTTPS 地址（审批链接 `{MONEYSWITCH_PUBLIC_URL}/approvals?id=…` 和给 AI 的技能说明都用它），再设端口和允许付款的链。把 `deploy/moneyswitch.caddy` 的域名和端口替换为实际值，装进自己的 Caddy 配置：先 `caddy validate`，再 reload；80/443 对外，4020 只监听本机。反向代理必须保留 Authorization 头，付款请求不要自动重试。

首次启动会打印管理员令牌和一条 30 分钟有效的一次性登录链接。只在私有终端看 `docker compose logs server`，用 HTTPS 地址打开链接：自动登录，停在「钱包」页。日志里有首次管理员凭据，不要公开。以后登录输入管理员令牌。令牌丢了：在服务器上的源码目录（先 `pnpm build`）运行 `pnpm admin:reset-token -- --data-dir <数据目录>`，旧令牌立刻失效，新令牌只打印一次。Docker 镜像里不带这个脚本；Docker 部署要对数据卷在宿主机上的目录运行它（`docker volume inspect` 查路径，需要 root），这个用法没有在容器环境里验证过。

首次使用：登录 → 钱包页创建钱包 → Key 页发 key、复制技能给 AI。后台只有钱包、Key、审批、账单四页。

## 钱包

后台「创建钱包」不需要设密码：服务器在数据目录 `/data` 里保存一个随机解锁密钥（文件 `wallet-unlock-<钱包地址>.secret`，名字带地址，不会和别的钱包的密钥混淆），重启后自己解锁。**12 个恢复词只显示一次**，创建时抄在纸上，然后勾选「我已抄下」；MetaMask 等标准钱包用这 12 个词看到的地址和服务器上一样。没有抄下就点「更换钱包」重新拿 12 个词：钱包里还没有钱时没有任何损失。

必须诚实说明这个取舍：**谁能读 `/data`，谁就能动用这个钱包**（包括磁盘快照和数据目录的备份）。服务器把 `/data` 和解锁文件限制为只有自己的账户可读，并在每次启动时重新设置并检查：Windows 上是受保护的 ACL（只含当前用户和 SYSTEM），Linux 上目录 0700、文件 0600。设置不成功时服务照常运行，但钱包页会出现红色警告（`health.secret_protected=false`），这时只放极少的钱。这只防别的系统账户，防不了同一个系统用户。所以：

- 当作小额零钱包：超过 `MONEYSWITCH_WALLET_FLOAT_LIMIT`（默认 50 USDC）后台就警告，多的转到你自己掌控的钱包。
- 保护好 `/data` 及其备份，等同保护私钥；`/data/retired/` 里是旧钱包的凭据，同样敏感。
- **不支持导入**：导入等于把你主钱包的私钥放到服务器上。

启动时的解锁顺序：`MONEYSWITCH_WALLET_PASSWORD` / `MONEYSWITCH_WALLET_PASSWORD_FILE`（**非空**才算数，只给旧版本建的密码钱包用）→ 这个钱包自己的解锁文件 → 否则保持锁定。空变量、空文件都视为没有配置，所以上面那个空的占位文件是无害的。后台没有密码表单；密码钱包的密码丢了，就更换钱包。某个来源存在却打不开钱包时，日志分别写明原因（`env_wrong`、`secret_missing`、`secret_empty`、`secret_unreadable`、`secret_wrong`，不含密码），钱包页显示「钱包已锁定」和对应原因。

更换钱包（钱包页的危险区，需要输入当前地址）：旧的钱包文件和解锁文件先被**复制**到 `/data/retired/` 并核对无误，再用新文件改名覆盖，所以 `wallet.json` 任何时刻都在、中途崩溃也总有一对能打开的文件；旧文件**不删除**。有付款正在签名时最多等 60 秒，期间新的付款会被拒绝（`WALLET_BUSY`，`charged: no`，稍后重试即可）；60 秒后仍有付款在途，更换返回 409 且什么都不改。换完后，旧钥匙拒绝签名。Key、额度、审批和账单都保留。旧钱包里的钱还在旧地址（钱包页会列出旧钱包的余额），取回办法见 [docs/wallet-setup.md](../docs/wallet-setup.md)。

服务重启时，上次卡住的付款会在对外服务之前处理：已签名的转为待对账（`unknown`，到链上查），没签过的标为失败并退回额度。这一步依赖「签过名的付款一定记录了授权」，所以 MoneySwitch **只签 EIP-3009**；卖方要求 Permit2 时，在预留和签名之前就以 `UNSUPPORTED_PAYMENT`、`charged: no` 拒绝。

`wallet.json` 丢失但凭据文件还在（最常见的原因是挂载错了目录）时，钱包页会明确提示并要求你确认，而不是悄悄让你建一个空钱包；服务器自己不会覆盖或删除那些文件。

## 链和资金

默认只启用 Monad 测试网 `eip155:10143` 和 Base Sepolia `eip155:84532`。主网要明确改成 `eip155:143,eip155:8453`，默认链必须在允许列表内。每条链只认它自己的 USDC，不换币、不跨链；同一地址在各链的余额独立，账单记录实际链，对账按该链查询。先在测试网走通，再按自己的资金策略启用主网。

## 备份、升级和回滚

同一 SQLite 数据卷只运行一个服务实例，不做多副本写入。停机备份整个 `/data`：加密钱包、解锁文件 `wallet-unlock-<地址>.secret`、`retired/`、SQLite 和管理员凭据；**这份备份等同于私钥，也是秘密**，谁拿到谁就能动用钱包。它不能代替 12 个恢复词：服务器和磁盘一起丢了，靠的是抄在纸上的词。若还在用旧版本的密码文件，宿主机上的密码文件另行备份。

```sh
docker compose stop server
mkdir -p backups
f=backups/data-$(date +%Y%m%d-%H%M%S).tgz
docker compose run --rm --no-deps --user node --entrypoint tar server -C /data -czf - . > "$f"
sh deploy/check-backup.sh "$f"
docker compose start server
```

**必须用 `--user node`，不要用 `--user root`。** `/data` 的权限是 0700、文件是 0600，属主是服务运行的 `node` 账户；`docker-compose.yml` 里有 `cap_drop: ALL`，容器里的 root 没有绕过文件权限的能力。用 root 跑 tar 只会打印 `Permission denied`，照样生成压缩包，里面**没有 `wallet.json` 和解锁文件**，不细看发现不了。也可以像 `deploy/upgrade-us.sh` 那样，在宿主机上以 root 直接打包数据卷（`tar -C /var/lib/docker/volumes/moneyswitch_moneyswitch-data/_data -czf backups/data-<时间>.tgz .`，卷名以 `docker volume ls` 为准）。

`deploy/check-backup.sh` 只列出压缩包的内容（不解压到磁盘，不显示任何秘密），并断言：里面有 `wallet.json`；如果是自动解锁的钱包，还要有**同一个地址**的 `wallet-unlock-<地址>.secret`（旧版本的密码钱包没有解锁文件，不要求，但要记住密码）。输出 `OK` 才算备份有效；输出 `FAIL`（退出码 1）就说明这份备份不能用：先重做，再继续升级或清理。服务器仍是停止状态，别忘了 `docker compose start server`。

备份目录设为仅管理员可读。升级前记录旧镜像 ID、Git commit 和备份；从同一个代码源重新构建新镜像后切换；回滚用旧镜像。数据库迁移只增不删，旧镜像打开已迁移的数据库不会出错（`deploy/upgrade-us.sh` 升级失败时的自动回滚就是这样做的，并有测试覆盖）；想要最保守，或者在新版本上已经更换过钱包之后，请用升级前的数据备份恢复。不要执行 `docker compose down -v`，它会删除持久数据。

数据库里旧版本留下的表（卖方收费亭、推送渠道、模型渠道）保留，v0.7 不读也不写。

## 验收

检查 `/healthz`；首次登录链接能登录并停在钱包页；创建钱包后 12 个词只显示一次；**重启服务后钱包仍是解锁状态且不需要任何密码**；`/data` 里的解锁文件以地址命名且只有服务账户可读（钱包页没有红色警告）；Key 的创建和重置密钥、给 AI 的技能段落；超额度被拦截；超过审批线时 `/v1/fetch` 返回的 `approve_url` 能打开（未登录会先跳登录，登录后回到该审批）、批准后重发只付一次；扣款状态 yes / no / maybe；重启后数据库保留。可以运行 `node scripts/deploy-smoke.mjs` 对已构建的包做独立沙箱验收，它不会使用已有的钱包。发布记录要写明是否实际验证过 HTTPS、容器重启和真实链上付款，不能把离线模拟当成真钱交易。
