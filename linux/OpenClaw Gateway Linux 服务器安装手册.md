# OpenClaw Gateway Linux 服务器安装手册

在 SmartX 超融合划出的 Linux 虚机上，用 Docker 跑起 xA Gateway（官方 OpenClaw + OA 桥接插件 + 企微通道）。装完之后的启停、巡检、备份、升级见 [OpenClaw Gateway Docker 运维手册.md](OpenClaw%20Gateway%20Docker%20运维手册.md)。

compose、Dockerfile、`.env` 模板、`openclaw.json` 都以仓库文件为准，本手册不再重贴。文中 `REPO` 指拷到服务器上的本仓库 `linux/` 目录。

## 0. 约定

| 项 | 值 |
| --- | --- |
| 系统 | Ubuntu 24.04 / 22.04，x86_64，systemd；≥ 4 核 8GB、系统盘留 ≥ 20GB |
| 宿主 | SmartX 划出的虚机。不要在 SmartX 控制台或宿主节点上装；规格不够找平台扩虚机 |
| 工作目录 | `~/xa`，放虚机本机盘（ext4 / xfs），不要 NFS / CIFS / 超融合共享盘 |
| 运行身份 | 容器以宿主机当前用户的 uid / gid 运行（`.env` 里的 `XA_UID` / `XA_GID`），`~/xa` 下的文件不用 chown |
| 凭据 | 全部写在 `~/xa/.env` 一个文件里，`openclaw.json` 只写 `${VAR}` |
| 镜像 | 自建 `xa-gateway-oa:2026.9.2` = `ghcr.io/openclaw/openclaw:2026.9.2` + OA 桥接插件与依赖 |
| 端口 | 宿主 `127.0.0.1:18789` → 容器 `18789`。不对公网开放，控制台走 SSH 隧道 |
| MySQL | 独立机器，Gateway 经局域网连 3306 |

路径对照（`openclaw.json` 里一律写容器路径）：

```text
~/xa/config                → /home/node/.openclaw
~/xa/workspace             → /home/node/.openclaw/workspace
~/xa/extensions            → /home/node/.openclaw/extensions
~/xa/.env                  → 由 docker compose 读取，注入为容器环境变量
```

**改了 `.env`、compose 或 `plugins.load.paths`，执行 `docker compose up -d`（compose 会自动重建容器）。`restart` 读不到新值。**

## 1. 服务器与 Docker

```bash
. /etc/os-release && echo "$PRETTY_NAME"; ps -p 1 -o comm=; uname -m; free -h; df -h /
```

```bash
sudo timedatectl set-timezone Asia/Shanghai
```

```bash
sudo ufw allow OpenSSH && sudo ufw enable
```

不要 `ufw allow 18789`。

安装 Docker Engine 与 Compose（官方源）：

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
sudo systemctl enable --now docker
```

重新 SSH 登录后验证：`groups` 含 `docker`，`docker run --rm hello-world` 成功。宿主不装 Node / npm。

拉镜像慢时二选一：

- Docker Hub 加速：`/etc/docker/daemon.json` 写 `{"registry-mirrors": ["<可用的加速源>"]}`。加速源只管 docker.io，不管 ghcr.io。
- 公司代理：写 `/etc/systemd/system/docker.service.d/http-proxy.conf`，`[Service]` 下设 `Environment="HTTP_PROXY=…"`、`HTTPS_PROXY`、`NO_PROXY=localhost,127.0.0.1`，然后 `sudo systemctl daemon-reload && sudo systemctl restart docker`。

## 2. 拷仓库、建目录

在源机器上（只拷这一份仓库）：

```bash
rsync -avz /path/to/adt_openclaw/linux/ YOUR_LINUX_USER@SERVER:~/handoff/xa/
```

在服务器上：

```bash
REPO="$HOME/handoff/xa"
mkdir -p ~/xa/config ~/xa/workspace ~/xa/extensions
cp -r "$REPO/workspace-rules/workspace/." ~/xa/workspace/
cp "$REPO/docker/docker-compose.yml" ~/xa/
cp "$REPO/docker/.env.example" ~/xa/.env
```

`~/xa/workspace/MEMORY.md` 必须存在（缺了群聊寒暄会多跑一轮模型）。

## 3. 准备独立 MySQL（DBA 在 MySQL 机器上做）

要求：MySQL 5.7+ / 8.x 或 MariaDB 10.6+，`utf8mb4`，InnoDB。数据量很小（每张确认单一行），插件连接池最多 10 个连接。表由插件启动时自动建（建表语句的独立副本在 `OA_tool/oa-workflow-bridge/sql/schema.sql`，也可先手工执行）。不做迁移：表结构变了就起新库。

```sql
CREATE DATABASE IF NOT EXISTS xa_oa CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'xa_oa'@'<Gateway 虚机 IP>' IDENTIFIED BY '<强随机密码>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER ON xa_oa.* TO 'xa_oa'@'<Gateway 虚机 IP>';
FLUSH PRIVILEGES;
```

- 只授权这一个库，不用 root，不给 `ALL ON *.*`。
- `bind-address` 不能只有 `127.0.0.1`；防火墙只放 Gateway 虚机 → 3306。
- 裸装后跑 `mysql_secure_installation`。匿名账号 `''@'localhost'` 会抢先匹配，表现为 `Access denied for user 'xa_oa'@'localhost'`。
- 备份：开 binlog 或每日 `mysqldump --single-transaction --routines xa_oa > xa_oa_$(date +%F).sql`。`oa_ticket` 是台账要保留；`oa_inbox` / `oa_identity` 是缓存，丢了会重建。
- 两个 Gateway 不能连同一个库；测试库和生产库分开（集成测试会清表）。

Gateway 虚机上验证：`nc -vz <MySQL 主机> 3306`。

## 4. 填 `.env`

编辑 `~/xa/.env`（模板里每项都有说明）：

| 变量 | 内容 |
| --- | --- |
| `XA_UID` / `XA_GID` | `id -u` / `id -g` 的输出。容器以这个身份运行，所以不用改文件属主 |
| `OPENCLAW_GATEWAY_TOKEN` | `openssl rand -base64 32` 生成 |
| `XA_IT_WECOM_BOT_ID` / `XA_IT_WECOM_BOT_SECRET` | 企微机器人 |
| `XA_DOMESTIC_API_KEY` | 百炼 API Key |
| `XA_DOMESTIC_BASE_URL` | 已预填 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `XA_DOMESTIC_MODEL_ID` | 百炼模型 ID。完整引用 `bailian/<模型 ID>` 由 compose 自动拼 |
| `OA_MYSQL_HOST` | 第 3 节 MySQL 机器的内网 IP 或域名 |
| `OA_MYSQL_PORT` / `OA_MYSQL_USER` / `OA_MYSQL_DATABASE` | 已预填 `3306` / `xa_oa` / `xa_oa`，和 DBA 建的不一样时再改 |
| `OA_MYSQL_PASSWORD` | 第 3 节的密码 |
| `OA_APP_ID` / `OA_PUBLIC_KEY` | OA 管理员给的 appid 和 RSA 公钥（公钥写成一整行 base64） |
| `OA_APP_SECRET` / `OA_API_USER_ID` | OA AppSecret；接口账号人员 id（纯数字，只用于只读预检，不是申请人） |
| `OA_ACTIVE` | 初装保持 `false`：员工能走完确认，但不会真的往 OA 建单。联调完改 `true` |
| `OA_ISNEXTFLOW` | `0` 建单后停在申请人节点（现网生产测试），`1` 自动流转到处理人 |
| `WECOM_IDENTITY_CORPID` / `WECOM_IDENTITY_SECRET` | 企微**自建应用**凭据（身份转换用，不是机器人 BotSecret） |

- 值里有 `$`、`#`、空格、引号时，用单引号括起来：`OA_MYSQL_PASSWORD='p@ss$word#1'`。
- 必填项空着，`docker compose` 会直接报 `.env 缺 XXX`，不会带空值启动。
- OA 地址、流程 602、附件字段、时长、附件上限有插件默认值，不用填；需要改时变量名见 [OA 接入手册](OA_tool/OA%20Workflow%20Bridge%20接入手册.md) 第 4 节。
- `XA_DOMESTIC_*` 是历史命名，与 Provider 键无关。
- `.env` 不进 git、不发群。机器上除了运维还有别人能登录时，执行一次 `chmod 600 ~/xa/.env`。

## 5. 构建镜像

```bash
cd ~/handoff/xa
docker build -f docker/Dockerfile -t xa-gateway-oa:2026.9.2 .
docker run --rm --entrypoint ls xa-gateway-oa:2026.9.2 /opt/xa/oa-workflow-bridge/node_modules   # 要有 mysql2 / jpeg-js / pngjs
```

- 拉不到 GHCR：Docker Hub 有同版本，加 `--build-arg OPENCLAW_IMAGE=openclaw/openclaw:2026.9.2`。
- npm 慢：加 `--build-arg npm_config_registry=https://registry.npmmirror.com`。
- 生产机不能出网：在别的 Linux x64 上构建，`docker save … | gzip` 拷过来 `docker load`。
- 以后改了插件代码或 `systems.json` 都要重新构建（建议换新 tag，旧 tag 即回滚点）。

## 6. 写配置

部署要改的值都已在 `.env` 里，这里只剩 `~/xa/config/openclaw.json`：用仓库样例，先去掉 `channels` 和 `bindings`（企微插件还没装，写了会 `unknown channel id: wecom`，容器反复重启）：

```bash
python3 - <<'EOF'
import json, pathlib
home = pathlib.Path.home()
cfg = json.loads((home / "handoff/xa/workspace-rules/openclaw.json").read_text())
for key in ("channels", "bindings", "wizard"):
    cfg.pop(key, None)
(home / "xa/config/openclaw.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
EOF
```

## 7. 启动：网关 + 模型 + OA

```bash
cd ~/xa
docker compose up -d
docker compose ps                         # Up (healthy)
docker logs --tail 100 xa-gateway
curl -sS http://127.0.0.1:18789/healthz   # 含 "ok":true
```

日志应有：

- `agent model: bailian/<模型 ID> (thinking=off, …)`
- `[oa-workflow-bridge] loaded (MySQL state)`
- `[gateway] ready`

不应有：`Invalid config`、`Unknown model`、`MySQL init failed`、`Cannot find package 'mysql2'`、`plugin path not found`、`suspicious ownership`、`Unable to create fallback OpenClaw temp dir`。第一次启动可能先打一行 `refusing to report the gateway ready. Restart OpenClaw…`，随后自己就绪，不用处理。

MySQL 上 `SHOW TABLES FROM xa_oa;` 应有 `oa_identity` / `oa_inbox` / `oa_ticket`。再跑 OA 只读预检：

```bash
docker exec xa-gateway node /opt/xa/oa-workflow-bridge/scripts/readonly-preflight.mjs
```

通过时输出 `READ_ONLY_PREFLIGHT_PASSED` 且 `"db":"OK"`。

凭据是容器自身的环境变量，`docker exec` 里也能读到，CLI 不用再带 `-e`。下文用别名简写：

```bash
alias oc='docker exec -it xa-gateway node dist/index.js'
```

控制台：在自己电脑上 `ssh -N -L 18789:127.0.0.1:18789 YOUR_LINUX_USER@SERVER`，浏览器开 `http://127.0.0.1:18789/`，填 `.env` 里的 `OPENCLAW_GATEWAY_TOKEN`。

不要在容器里跑 `onboard` / `setup` / `configure`：会覆盖 `itservicedeskagent`、工作区和插件路径。

## 8. 接企业微信

先看插件是否已经在了。配置里已经启用了企微插件条目，Gateway 第一次启动时通常会自动装上 catalog 版本：

```bash
oc plugins list | grep -i wecom      # 期望：@wecom/wecom-openclaw-plugin … enabled … 2026.7.2 或更高
```

没有，或者版本低于 2026.7.2，再手动装：

```bash
oc plugins install npm:@wecom/wecom-openclaw-plugin@<版本> --force --accept-capabilities
```

`<版本>` 取 npm 包页当时的 Version（≥ 2026.7.2）。一定带 `npm:` 前缀：不带前缀或用 `plugins update` 只会装 catalog 钉死的版本。已经是目标版本时不要再 `--force` 重装同一版本，会报 `Plugin artifact has no valid plugin manifest`。不要用 `doctor --fix` 装。版本细节见 [WeCom 通道插件接入手册.md](WeCom%20通道插件接入手册.md) 第 5 节。

写通道与路由（`${…}` 两侧单引号保留，否则 shell 会吃掉变量）：

```bash
oc config set channels.wecom.enabled true
oc config set channels.wecom.botId '${XA_IT_WECOM_BOT_ID}'
oc config set channels.wecom.secret '${XA_IT_WECOM_BOT_SECRET}'
oc config set channels.wecom.dmPolicy open
oc config set channels.wecom.groupPolicy open
oc config set channels.wecom.allowFrom '["*"]'
oc config set channels.wecom.sendThinkingMessage true    # 插件 < 2026.7.2 必须 false
oc config set bindings '[{"type":"route","agentId":"itservicedeskagent","match":{"channel":"wecom","accountId":"default"}}]'
cd ~/xa && docker compose restart
```

`dmPolicy: open` 时 `allowFrom` 必须含 `"*"`，否则私聊全被丢弃。改完用 `diff` 对照仓库 `workspace-rules/openclaw.json`。

验证：

```bash
oc channels status --channel wecom --probe   # enabled, configured, running, works
oc agents list --bindings                    # wecom/default → itservicedeskagent
```

## 9. 验收

1. 企微 `/new` 后 `/context detail`：`AGENTS.md` 未截断，`Skills list` 为 0。
2. 测试机器人私聊「你是谁」：1～2 秒出「思考中」，几秒内回固定自我介绍。
3. 报一个问题，出确认卡；回 `2` 取消。
4. 发图：日志无 `apply_media_understanding`，回复不描述图片内容。
5. 要真正建单时把 `.env` 的 `OA_ACTIVE` 改成 `true`，`docker compose up -d`，确认后拿到数字 `requestId`。

装完后放好 inbound 清理 cron（运维手册第 7 节），否则 `media/inbound` 会一直涨。

## 10. 常见问题

| 现象 | 处理 |
| --- | --- |
| `docker compose` 报 `required variable … .env 缺 XXX` | `.env` 里这一项没填 |
| 改了 `.env` 不生效 | 用 `docker compose up -d`，不要用 `restart` |
| `Unable to create fallback OpenClaw temp dir` / Permission denied | 镜像不是按仓库 Dockerfile 构建的（它负责让任意 uid 可写 HOME），重新构建 |
| `blocked plugin candidate: suspicious ownership (/opt/xa/oa-workflow-bridge …)` | 镜像里插件目录被改了属主。按仓库 Dockerfile 重新构建（插件目录必须归 root） |
| 写 `~/xa` 下文件报 Permission denied | `XA_UID` / `XA_GID` 不是你的 `id -u` / `id -g`，改 `.env` 后 `up -d`；之前用别的 uid 生成的文件 `sudo chown -R $(id -u):$(id -g) ~/xa` 一次 |
| `gateway.bind` 校验失败 | 只能写 `lan` / `loopback` / `auto` / `tailnet`，不能写 IP |
| `Unknown model: bailian/…` / unresolved | `XA_DOMESTIC_MODEL_ID` 填错或账号没开通该模型 |
| `MySQL init failed: …` | `ECONNREFUSED` / `ETIMEDOUT` 查网络与 `bind-address`；`ER_ACCESS_DENIED_ERROR` 查密码与账号 host；`ER_BAD_DB_ERROR` 查库名 |
| `plugin path not found: /opt/xa/oa-workflow-bridge` / `Cannot find package 'mysql2'` | compose 用的不是 `xa-gateway-oa`；按第 5 节构建 |
| `plugin path not found: …oa-workflow-bridge-redis` | json 还是旧 id，只留 `oa-workflow-bridge`，路径只留 `/opt/xa/oa-workflow-bridge` |
| `unknown channel id: wecom` | 插件没装就写了通道。去掉 `channels` 与 `bindings`，`up -d`，按第 8 节先装插件 |
| `blocked by allowlist` | `plugins.allow` 缺 `wecom-openclaw-plugin` |
| `meta: Invalid input` | 删掉非法 `meta` 键（如旧模板的 `handoffTemplate`） |
| Gateway Up 但 `autostart suppressed` | 崩溃熔断，见运维手册第 8 节；不要 `channels start --channel` |
| 回复要十几秒 | 见 [DashScope 手册](DashScope%20兼容%20Provider%20配置手册.md) 第 4 节 |
| 「思考中」一直转 | 插件 < 2026.7.2；`sendThinkingMessage` 改 `false` 并 `restart` |
| 服务器重启后容器没起 | `systemctl is-active docker`；`cd ~/xa && docker compose up -d` |

容器 Restarting、`docker exec` 进不去时：`docker compose down`，按日志手改 `~/xa/config/openclaw.json` 再 `up -d`。不得不用 `doctor --fix` 时，先备份 json，再在 `~/xa` 下执行 `docker compose run --rm xa-gateway node dist/index.js doctor --fix`（这样用的是同一个镜像、同一套挂载和 `.env`），改完 `config validate` 再回归。

## 11. 安全

- `~/xa/.env` 和含 `.env` 的备份不进 git、不进镜像、不传公共网盘。仓库只放 `docker/.env.example`。
- `docker inspect` 能看到环境变量。能执行 `docker` 的人本来就等同于宿主 root，所以 docker 组只给运维。
- 日志里不得出现 token、Authorization、附件 base64、原始 SenderId。
- 测试用测试机器人；同一个 Bot 同一时刻只能被一个 Gateway 持有。切流：先停旧实例，再起新实例。
- 公网扫到 18789：确认 compose 是 `127.0.0.1:18789:18789`，`up -d`，换掉 `OPENCLAW_GATEWAY_TOKEN`。
