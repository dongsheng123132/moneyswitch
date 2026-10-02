# MoneySwitch 自建部署

个人、团队和企业运行同一个服务。数据库、预算、审批、通知设置和加密钱包都保存在自己的服务器。浏览器是管理界面；AI 拿受限 MoneyKey，通过 skill 调用 `/v1/fetch`。管理员令牌和钱包密码不交给 AI。

## Docker + HTTPS

要求 Linux、Docker Compose、一个指向服务器的域名。官网可以保持静态托管，后台使用独立子域名。仓库根目录执行：

```sh
cp deploy/.env.example .env
mkdir -p deploy/secrets
# 新安装先用空文件，服务保持钱包锁定。已有文件不要覆盖。
test -e deploy/secrets/wallet_password || (umask 077; touch deploy/secrets/wallet_password)
docker compose build server
docker compose up -d server
docker compose ps
curl --fail http://127.0.0.1:4020/healthz
```

修改 `.env` 的域名、端口和允许付款的链。将 `deploy/moneyswitch.caddy` 的域名和端口替换为实际值，安装在自己的 Caddy 配置中。先 `caddy validate`，再 reload；80/443 用于 HTTPS，4020 只监听本机。反向代理必须保留 Authorization 头和 SSE，不做付费请求自动重试。

首次启动会生成管理员令牌和 30 分钟一次性初始化链接。仅在私有终端查看 `docker compose logs server`，用 HTTPS 后台打开初始化链接，创建加密钱包并给 AI 创建预算 Key。日志含首次管理员凭据，勿公开分享。后续登录也可在后台输入管理员令牌。

空密码文件不会自动解锁钱包。若需要重启后自动解锁，用受控本地编辑器把后台创建钱包时的密码写入 `deploy/secrets/wallet_password`，让容器 UID 1000 可读，并确保其他用户不可读。不要把密码放入命令行、Git 或聊天。服务重启后核对钱包状态；也可以始终手动解锁。

## 链和资金

默认只启用 Monad 测试网 `eip155:10143` 和 Base Sepolia `eip155:84532`。主网须明确改为 `eip155:143,eip155:8453`，默认链也必须在允许列表内。每条链只允许其指定 USDC；不换币、不跨链。一个地址在不同链的余额独立，付款账本记录实际链，对账按该链查询。

个人使用可只建一把 Key。团队管理员给每名成员创建独立 Key，设总额、每日限额、单笔限额、允许域名和审批阈值；成员只能查看自己的预算和历史。子 Key 不能绕过父 Key 的限制。先在测试网走通真实服务，再按自己的资金策略启用主网。

## 备份、升级和回滚

同一 SQLite 数据卷只运行一个服务实例，不做多副本写入。停机备份包含整个 `/data`，包括加密钱包、SQLite 和管理员凭据；备份也属于秘密。宿主机钱包密码文件另行备份。

```sh
docker compose stop server
mkdir -p backups
docker compose run --rm --no-deps --user root --entrypoint tar server -C /data -czf - . > backups/data-$(date +%Y%m%d-%H%M%S).tgz
docker compose start server
```

备份目录设为仅管理员可读。升级前记录旧镜像 ID、Git commit 和备份；从同一个代码源重新构建新镜像后切换。回滚使用旧镜像和升级前数据备份，不把新数据库强行交给旧代码。不要执行 `docker compose down -v`，它会删除持久数据。

历史收费亭表仍保留在数据库中；v0.6 不提供卖方收费亭接口。存档标签 `archive/tollbooth-v0.5` 供历史代码查询。

## 验收

检查 `/healthz`、后台初始化、钱包锁定/解锁、Key 创建和重置、个性化 skill、超预算拦截、审批通过后只付一次、通知测试、扣款状态 yes/no/maybe、数据库重启后保留。可运行 `node scripts/deploy-smoke.mjs` 对已构建包做独立沙箱验收；它不会使用已有钱包。通知测试先用自有沙箱接收端，生产渠道由管理员配置。发布记录应注明是否实际验证 HTTPS、容器重启、真实链付款，不能把离线模拟当成真钱交易。
