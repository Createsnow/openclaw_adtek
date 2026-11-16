# OpenClaw Gateway 部署与运维手册

在 SmartX 超融合划出的 Linux 虚机上，用 Docker 跑 xA Gateway（官方 OpenClaw + OA 桥接插件 + 企微通道）。第一次怎么装、装完怎么养，都在这一本：

- **第一部分 安装**：第 1～9 节，按顺序做一次。
- **第二部分 运维**：第 10～18 节，按需查。

compose、Dockerfile、`.env` 模板、`openclaw.json` 都以仓库文件为准，本手册不重贴。文中 `REPO` 指拷到服务器上的本仓库（默认 `~/handoff/xa`）。

## 0. 约定

| 项 | 值 |
| --- | --- |
| 系统 | Ubuntu 24.04 / 22.04，x86_64，systemd；≥ 4 核 8GB、系统盘留 ≥ 20GB |
| 宿主 | SmartX 划出的虚机。不要在 SmartX 控制台或宿主节点上装；规格不够找平台扩虚机 |
| 工作目录 | `~/xa`，放虚机本机盘（ext4 / xfs），不要 NFS / CIFS / 超融合共享盘。所有 compose 命令在这里执行 |
| 运行身份 | 容器以宿主机当前用户的 uid / gid 运行（`.env` 里的 `XA_UID` / `XA_GID`），`~/xa` 下的文件不用 chown |
| 凭据 | 全部写在 `~/xa/.env` 一个文件里，compose 注入成容器环境变量；`openclaw.json` 只写 `${VAR}` |
| 镜像 / 容器 | 自建 `xa-gateway-oa:2026.9.2` = `ghcr.io/openclaw/openclaw:2026.9.2` + OA 桥接插件与依赖（插件在镜像 `/opt/xa/oa-workflow-bridge`）；容器名 `xa-gateway` |
| 端口 | 宿主 `127.0.0.1:18789` → 容器 `18789`。不对公网开放，控制台走 SSH 隧道 |
| 健康检查 | `curl -sS http://127.0.0.1:18789/healthz`，含 `"ok":true` |
| MySQL | 独立机器上的 `xa_oa`，Gateway 经局域网连 3306，不在本机 compose 里 |

路径对照（`openclaw.json` 里一律写容器路径）：

```text
~/xa/config      → /home/node/.openclaw
~/xa/workspace   → /home/node/.openclaw/workspace
~/xa/extensions  → /home/node/.openclaw/extensions
~/xa/.env        → 由 docker compose 读取，注入为容器环境变量
```

容器内 CLI 用别名（凭据是容器自身的环境变量，`docker exec` 里也读得到，不用带 `-e`）：

```bash
alias oc='docker exec -it xa-gateway node dist/index.js'
```

**改了什么、怎么生效：**

| 改动 | 生效方式 |
| --- | --- |
| `openclaw.json` 业务字段（tools、allowFrom、bindings） | 多数热重载；不生效再 `docker compose restart xa-gateway` |
| `skills` / `bootstrapMaxChars` | `restart`，再在企微 `/new`（旧会话缓存截断结果） |
| 工作区规则 `AGENTS.md` 等 | 下一轮对话生效；建议 `/new` |
| `~/xa/.env`、compose、`plugins.load.paths`、端口 / bind | `docker compose up -d`（compose 发现变化会自动重建容器）。**`restart` 读不到新的 `.env`** |
| OA 插件代码、`systems.json` | 重建镜像（建议新 tag），改 compose `image:`，`up -d` |

改 json 前先 `oc config validate`。**禁止**在容器里跑 `onboard` / `setup` / `configure`（会覆盖 `itservicedeskagent`、工作区和插件路径）；**禁止**用 `config set` 把 `${VAR}` 覆盖成明文。

---

# 第一部分 安装

链路：服务器与 Docker → 建目录 → MySQL → `.env` → 建镜像 → 写配置 → 启动（网关 + 模型 + OA）→ 接企微 → 验收。企微必须最后接：`channels.wecom` 由插件注册，插件没装就写会 `unknown channel id: wecom`，容器反复重启。

## 1. 服务器与 Docker

```bash
. /etc/os-release && echo "$PRETTY_NAME"; ps -p 1 -o comm=; uname -m; free -h; df -h /
sudo timedatectl set-timezone Asia/Shanghai
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
rsync -avz --exclude .git /path/to/openclaw_adtek/ YOUR_LINUX_USER@SERVER:~/handoff/xa/
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

部署要改的值都已在 `.env` 里，这里只剩 `~/xa/config/openclaw.json`：用仓库样例，先去掉 `channels` 和 `bindings`（企微插件还没装）：

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

不应有：`Invalid config`、`Unknown model`、`MySQL init failed`、`Cannot find package 'mysql2'`、`plugin path not found`、`suspicious ownership`、`Unable to create fallback OpenClaw temp dir`（对号入座见第 15 节）。第一次启动可能先打一行 `refusing to report the gateway ready. Restart OpenClaw…`，随后自己就绪，不用处理。

MySQL 上 `SHOW TABLES FROM xa_oa;` 应有 `oa_identity` / `oa_inbox` / `oa_ticket`。再跑 OA 只读预检（不建单）：

```bash
docker exec xa-gateway node /opt/xa/oa-workflow-bridge/scripts/readonly-preflight.mjs
```

通过时输出 `READ_ONLY_PREFLIGHT_PASSED` 且 `"db":"OK"`。

控制台：在自己电脑上 `ssh -N -L 18789:127.0.0.1:18789 YOUR_LINUX_USER@SERVER`，浏览器开 `http://127.0.0.1:18789/`，填 `.env` 里的 `OPENCLAW_GATEWAY_TOKEN`。

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

## 9. 收尾与验收

**inbound 原件回收（必须装）。** 插件提交后只删自己的 staging 副本，通道落盘的原件在 `~/xa/config/media/inbound` 和 `~/xa/workspace/media/inbound` 两处，人一多都会涨。用仓库脚本 `docker/prune-inbound.sh`：只删满 24 小时（`-mmin +1440`）的文件，日志写 `~/xa/logs/inbound-prune.log`（北京时间）。

```bash
mkdir -p ~/xa/scripts ~/xa/logs
cp ~/handoff/xa/docker/prune-inbound.sh ~/xa/scripts/ && chmod 700 ~/xa/scripts/prune-inbound.sh
find ~/xa/config/media/inbound ~/xa/workspace/media/inbound -type f -mmin +1440 -ls   # 先干跑
~/xa/scripts/prune-inbound.sh && tail -n 5 ~/xa/logs/inbound-prune.log
( crontab -l 2>/dev/null | grep -v prune-inbound.sh; echo "15 3 * * * $HOME/xa/scripts/prune-inbound.sh" ) | crontab -
crontab -l && systemctl is-active cron
```

用跑 Gateway 的同一用户，不要 root。脚本在、crontab 没有，不会自动删。

**功能验收：**

1. 企微 `/new` 后 `/context detail`：`AGENTS.md` 未截断，`Skills list` 为 0。
2. 测试机器人私聊「你是谁」：1～2 秒出「思考中」，几秒内回固定自我介绍。
3. 报一个问题，出确认卡；回 `2` 取消。
4. 发图：日志无 `apply_media_understanding`，回复不描述图片内容。
5. 要真正建单时把 `.env` 的 `OA_ACTIVE` 改成 `true`，`docker compose up -d`，确认后拿到数字 `requestId`。
6. 做一次第 12 节备份。

---

# 第二部分 运维

## 10. 健康检查与巡检

出问题先跑这个只读脚本（不改配置、不重启）：

```bash
bash <<'EOF'
cd ~/xa || exit 1
systemctl is-active docker
docker compose ps
docker inspect -f 'Status={{.State.Status}} Health={{.State.Health.Status}} RestartCount={{.RestartCount}}' xa-gateway
curl -sS -m 5 http://127.0.0.1:18789/healthz; echo
df -h ~/xa
test -f ~/xa/.env && echo ".env OK" || echo "FAIL: 缺 ~/xa/.env"
test -f ~/xa/workspace/MEMORY.md && echo "MEMORY.md OK" || echo "FAIL: 缺 MEMORY.md"
docker logs xa-gateway 2>&1 | grep -E 'agent model|Invalid config|breaker tripped|autostart suppressed|plugin path not found|MySQL init failed' | tail -n 20
docker stats --no-stream xa-gateway
EOF
```

期望：`Up (healthy)`，RestartCount 不持续增加，`/healthz` 含 `"ok":true`，日志只有 `agent model: bailian/… (thinking=off …)`。

再看 OpenClaw 自身：

```bash
oc gateway status --deep
oc plugins list                              # oa-workflow-bridge、wecom-openclaw-plugin enabled
oc channels status --channel wecom --probe   # enabled, configured, running, works
oc agents list --bindings                    # wecom/default → itservicedeskagent
oc models status                             # 无 unresolved
```

**巡检：**

| 频率 | 检查 | 通过标准 |
| --- | --- | --- |
| 每日 | 上面的脚本 | 全部符合期望 |
| 每日 | 测试机器人发「你是谁」，同时 `docker logs -f` | 有 inbound、`Reply message sent`、`Reply ack received` |
| 每周 | `du -sh ~/xa/config/media/inbound ~/xa/workspace/media/inbound`；`tail -n 14 ~/xa/logs/inbound-prune.log` | 每天都有 `done total_deleted=` 记录 |
| 每周 | `docker system df`；`du -sh ~/xa` | 增长可解释 |
| 每周 | MySQL：`SELECT status, COUNT(*) FROM xa_oa.oa_ticket GROUP BY status;` | `unknown` / `submitting` 为 0，否则走第 16 节 |
| 每周 | `grep -nE 'sk-\|apiKey.: ."[^$]' ~/xa/config/openclaw.json` | 无明文 Key |
| 每月 | 第 12 节备份，`tar -tzf` 能列出 | 是 |
| 每月 | 记录镜像 digest、OpenClaw 版本、企微插件版本 | 已记 |
| 每月 | 百炼 Key、企微 Secret、OA AppSecret 是否临期 | 未过期 |

## 11. 日志

```bash
docker logs -f --timestamps xa-gateway
docker logs --since 30m --timestamps xa-gateway
```

按现象 grep：

| 想看 | 命令 |
| --- | --- |
| 模型与思考开关 | `docker logs xa-gateway 2>&1 \| grep 'agent model'` |
| 模型耗时 | `docker logs --since 1h xa-gateway 2>&1 \| grep -E 'model-fetch\|kind=final\|timeoutMs'` |
| 发图误走媒体理解 | `… \| grep apply_media_understanding`（应无） |
| 企微收发 | `… \| grep -Ei 'wecom\|Authentication successful\|Reply message sent\|Reply ack\|DM dropped'` |
| 配置非法 / 熔断 | `… \| grep -Ei 'Invalid config\|breaker tripped\|autostart suppressed'` |
| OA 插件 / 数据库 | `… \| grep -E 'Cannot find (package\|module)\|plugin path not found\|MySQL init failed\|DB_UNAVAILABLE\|sweep failed'` |

`oa_workflow` 的回执码（如 `OA_IDENTITY_*`）不在 `docker logs`，在会话 jsonl 里，抽取方法见 [企微到OA身份.md](OA_tool/企微到OA身份.md) 第 7 节。不要 `cat` 整份 jsonl。

日志里出现 Gateway Token、BotSecret、模型 Key、Authorization、附件 base64、原始 SenderId，按安全事件处理：停止外传，轮换对应密钥（第 13 节）。

容器日志已轮转（`json-file`，20m × 5）。轮转不管会话 jsonl 和 `media/inbound`。

## 12. 备份与恢复

| 必须备份 | 可重建 |
| --- | --- |
| `~/xa` 下 `docker-compose.yml`、`.env`、`config/`（含已装的企微插件）、`workspace/` | 镜像（按第 5 节重建） |
| MySQL `xa_oa`（`mysqldump`，见第 3 节） | 容器 |

```bash
STAMP="$(date +%Y%m%d-%H%M%S)"; mkdir -p ~/xa-backups
cd ~/xa && docker compose stop
tar --exclude='xa/extensions' -czf ~/xa-backups/xa-${STAMP}.tar.gz -C ~ \
  xa/docker-compose.yml xa/.env xa/config xa/workspace
docker compose start
```

只备配置不停机时去掉 `stop` / `start`。备份含 `.env` 里的全部凭据，只放本机或企业加密盘，不传公共网盘。

恢复：

```bash
cd ~/xa && docker compose down
mv ~/xa ~/xa.broken.$(date +%Y%m%d-%H%M%S) && mkdir ~/xa
tar -xzf ~/xa-backups/xa-<时间戳>.tar.gz -C ~
docker images | grep xa-gateway-oa      # 没有就按第 5 节重建
cd ~/xa && docker compose up -d
```

换了机器或换了登录用户时，先把 `.env` 里的 `XA_UID` / `XA_GID` 改成新用户的 `id -u` / `id -g`。`oc plugins list` 里没有企微插件就按第 8 节重装。验证后先用测试机器人，再切回生产 Bot。

## 13. 密钥轮换与升级

**密钥**：先 `cp -a ~/xa/.env ~/xa/.env.bak`，改 `.env` 里对应一行，`docker compose up -d`，验证后删 `.env.bak`。

| 变量 | 新值来源 | 轮完验证 |
| --- | --- | --- |
| `OPENCLAW_GATEWAY_TOKEN` | `openssl rand -base64 32` | 新 token 能开控制台 |
| `XA_IT_WECOM_BOT_*` | 企微后台重置机器人 | 收发正常 |
| `XA_DOMESTIC_API_KEY` | 百炼控制台新建 Key | 对话无 401 |
| `OA_MYSQL_PASSWORD` | DBA 先改 MySQL 密码 | 日志无 `MySQL init failed` |
| `OA_MYSQL_HOST` 等 | MySQL 换机器 / 换库 | 同上；`SHOW TABLES` 有三张表 |
| `OA_APP_SECRET` / `OA_API_USER_ID` | OA 管理端 | OA 只读预检通过 |
| `WECOM_IDENTITY_*` | 企微自建应用 | 新员工 `prepare` 能查到身份 |

注入检查（只看非空，不打印值）：

```bash
docker exec xa-gateway sh -c 'for v in OPENCLAW_GATEWAY_TOKEN XA_IT_WECOM_BOT_ID XA_DOMESTIC_API_KEY OA_MYSQL_PASSWORD WECOM_IDENTITY_SECRET; do eval "test -n \"\$$v\"" || echo MISSING:$v; done; echo CHECKED'
```

**升级 OpenClaw**：改 `docker/Dockerfile` 的 `OPENCLAW_IMAGE`（或 `--build-arg`），用新 tag 构建，改 compose `image:`，`up -d`，再 `oc config validate`、`oc doctor`（只看不改）。回滚 = 把 `image:` 改回旧 tag 再 `up -d`。`doctor --fix` 会改 `agents.entries`，先备份 json，不要在生产 Bot 上首次试。配置被改坏时连 `config/` 一起恢复。

**升级企微插件**：命令同第 8 节（带 `npm:` 前缀），细节见 [WeCom 通道插件接入手册.md](WeCom%20通道插件接入手册.md) 第 5 节。从低于 2026.7.2 升上来时，先保持 `sendThinkingMessage: false` 测收发，再打开。

升级后回归：第 10 节 + 测试机器人发「你是谁」，`model-fetch` 到 `kind=final` 约 2～5 秒。

## 14. 崩溃熔断（crash-loop breaker）

日志出现 `restart-loop breaker tripped` / `[wecom] channel autostart suppressed`：5 分钟内多次不洁启动后，控制面照常起来，但通道不自动拉。先修好根因（json / `.env` / 插件路径），然后二选一：

- 什么都不做，约 5 分钟后同一进程会自己拉起通道；
- 立即拉起：

```bash
oc gateway call channels.start --params '{"channel":"wecom","accountId":"default"}'
```

不要再 `compose restart`（会重新计数），不要用 `channels start --channel`。之后 `oc channels status --channel wecom --probe` 应为 `works`，日志有 `Authentication successful`。

## 15. 排障速查

先跑第 10 节脚本。容器 `Restarting` 时别 `docker exec`：`docker logs --tail 200 xa-gateway` 看原因，`docker compose down`，按日志手改 `~/xa/config/openclaw.json` 再 `up -d`。

| 现象 | 处理 |
| --- | --- |
| `Cannot connect to the Docker daemon` | `sudo systemctl start docker`；`groups` 不含 `docker` 就重新登录 |
| 服务器重启后容器没起 | `systemctl is-active docker`；`cd ~/xa && docker compose up -d` |
| `docker compose` 报 `required variable … .env 缺 XXX` | `.env` 里这一项没填 |
| 改了 `.env` 不生效 | 用 `docker compose up -d`，不要用 `restart` |
| `Unable to create fallback OpenClaw temp dir` / Permission denied | 镜像不是按仓库 Dockerfile 构建的（它负责让任意 uid 可写 HOME），重新构建 |
| `blocked plugin candidate: suspicious ownership (/opt/xa/oa-workflow-bridge …)` | 镜像里插件目录被改了属主。按仓库 Dockerfile 重新构建（插件目录必须归 root） |
| 写 `~/xa` 下文件报 Permission denied | `XA_UID` / `XA_GID` 不是你的 `id -u` / `id -g`，改 `.env` 后 `up -d`；之前用别的 uid 生成的文件 `sudo chown -R $(id -u):$(id -g) ~/xa` 一次 |
| `/healthz` 不通但容器 Up | `gateway.bind` 必须是 `lan`；看启动日志 |
| `gateway.bind` 校验失败 | 只能写 `lan` / `loopback` / `auto` / `tailnet`，不能写 IP |
| `meta: Invalid input` | 删掉非法 `meta` 键（如旧模板的 `handoffTemplate`） |
| `Unknown model: bailian/…` / unresolved | `XA_DOMESTIC_MODEL_ID` 填错或账号没开通该模型；json 的 Provider 键必须是 `bailian` |
| `MySQL init failed` / `DB_UNAVAILABLE` | `ECONNREFUSED` / `ETIMEDOUT` 查网络与 `bind-address`；`ER_ACCESS_DENIED_ERROR` 查密码、账号 host、匿名账号（第 3 节）；`ER_BAD_DB_ERROR` 查库名 |
| `plugin path not found: /opt/xa/oa-workflow-bridge` / `Cannot find package 'mysql2'` | compose 用的不是 `xa-gateway-oa`；按第 5 节构建并核对 `image:` |
| `plugin path not found: …oa-workflow-bridge-redis` | json 还是旧 id，只留 `oa-workflow-bridge`，路径只留 `/opt/xa/oa-workflow-bridge` |
| `unknown channel id: wecom` | 插件没装就写了通道。去掉 `channels` 与 `bindings`，`up -d`，按第 8 节先装插件 |
| `blocked by allowlist` | `plugins.allow` 缺 `wecom-openclaw-plugin` |
| Gateway Up 但 `autostart suppressed` | 第 14 节；不要 `channels start --channel` |
| 企微突然不回 | 先看日志有无熔断（第 14 节）；没有就 `restart`；仍不行 `up -d --force-recreate`，并查有无第二套容器抢同一 Bot：`docker ps -a` |
| 回复很慢 | 时间线：inbound → `model-fetch` → `kind=final` → `Reply message sent`。见 [DashScope 手册](DashScope%20兼容%20Provider%20配置手册.md) 第 4 节 |
| 「思考中」一直转 | 插件 < 2026.7.2；`sendThinkingMessage` 改 `false` 并 `restart` |
| 员工「还不能提交到 OA」/ `OA_IDENTITY_*` | [企微到OA身份.md](OA_tool/企微到OA身份.md) 第 7 节 |
| 员工「OA 需要人工核对」/ `RECONCILIATION_REQUIRED` | 第 16 节对账；禁止让员工再点确认 |
| 日志出现 `smartsheet_get_records` | `alsoAllow` 混进了旧工具；两处只留 `oa_workflow` |
| Control UI 写出 `~/xa/config/agents/itservicedeskagent/agent/models.json` | 可能含明文 Key，删掉后 `restart` |
| 磁盘满 | `df -h`；`du -sh ~/xa/* \| sort -h`；先清 inbound（第 9 节）和悬空镜像（`docker image prune -f`）；不要 `docker system prune -a --volumes`；不要手删 `oa-workflow-bridge/staging/` 或 `oa_ticket` |
| OOM | `docker inspect -f '{{.State.OOMKilled}}' xa-gateway`；找平台扩虚机，不要只加 `mem_limit` |

不得不用 `doctor --fix` 时，先备份 json，再在 `~/xa` 下执行 `docker compose run --rm xa-gateway node dist/index.js doctor --fix`（同一个镜像、同一套挂载和 `.env`），改完 `oc config validate` 再回归。

## 16. OA 结果不明（unknown）对账

员工看到「OA 需要人工核对」，或回执 `RECONCILIATION_REQUIRED`：超时 / 5xx / 返回里没有数字单号时，OA 里可能有单也可能没有。插件已锁住这个人，不能再确认、取消或开新单。**禁止**让员工再点确认，**禁止**自动重试。

OA 明确拒绝（`failed` / `OA_CREATE_REJECTED`）不走本节：那张单已结束，员工重新报即可。

SQL 在能写 `xa_oa` 的机器上执行。

**1. 查库**（确认号 `OA-…` 来自会话 jsonl 或失败回执）：

```sql
SELECT confirmation_id, external_ticket_id, status, request_id, error_code, oa_requester_id,
       FROM_UNIXTIME(created_at / 1000) AS created
  FROM xa_oa.oa_ticket WHERE status IN ('unknown', 'submitting');
```

`request_id` 有值说明 OA 已建单、只是本地没记上。Gateway 在提交中崩溃会停在 `submitting`，同样走本节。

**2. 对 Ecology**：按申请人 `oa_requester_id`、`created` 时间、流程 602、标题前缀 `[IT-…]`（`external_ticket_id`）找有没有数字 `requestId`。

**3a. OA 里有单 → 收成已提交**，并把数字单号告诉员工。`submitted_at` 填 OA 里这张单的建单时间，不要填对账当天：

```sql
UPDATE xa_oa.oa_ticket
   SET status = 'submitted', request_id = '<数字单号>', active_sender = NULL,
       submitted_at = UNIX_TIMESTAMP('<OA 建单时间，如 2026-11-16 10:05:00>') * 1000,
       draft_json = NULL, staged_json = NULL, updated_at = UNIX_TIMESTAMP() * 1000
 WHERE confirmation_id = 'OA-…' AND status IN ('unknown', 'submitting');
```

**3b. OA 里没单 → 放人重报**：

```sql
UPDATE xa_oa.oa_ticket
   SET status = 'failed', error_code = 'RECONCILED_NOT_IN_OA', active_sender = NULL,
       draft_json = NULL, staged_json = NULL, updated_at = UNIX_TIMESTAMP() * 1000
 WHERE confirmation_id = 'OA-…' AND status IN ('unknown', 'submitting');
```

禁止：删 `oa_ticket` 行；改 `external_ticket_id`；不带 `confirmation_id` 条件批量 UPDATE；不去 OA 核对就把 `unknown` 改 `failed`；改状态时漏了 `active_sender = NULL`（这个人会一直开不了新单）。

## 17. 多套环境与安全

- 同一企微 Bot 同一时刻只能被一个 Gateway 持有，不要同时 `up` 两套 `.env` 里是同一个 Bot 的目录。切流：先停旧实例，再起新实例。
- 另一套业务用独立目录、容器名、端口、`.env`、Bot：`~/xa-hr` / `xa-hr-gateway` / `18790`，测试 `~/xa-staging` / `18791`。可以共用 MySQL 服务器，但必须不同库、不同账号。测试环境只用测试机器人，不放生产 BotSecret。
- `.env` 和含 `.env` 的备份不进 git、不进镜像、不传公共网盘；仓库只放 `docker/.env.example`。机器上除了运维还有别人能登录时 `chmod 600 ~/xa/.env`。
- 能跑 docker 就能 `docker inspect` 看到环境变量（等同宿主 root），docker 组只给运维。
- `docker port xa-gateway` 应只绑 `127.0.0.1`。公网扫到 18789：确认 compose 是 `127.0.0.1:18789:18789`，`up -d`，换掉 `OPENCLAW_GATEWAY_TOKEN`。
- 日志里不得出现 token、Authorization、附件 base64、原始 SenderId。

## 18. 换成新部署方式：全新起一套再切换

2026-11 之前装的环境用 `secrets/*.txt` + `entrypoint.sh` + `oa-bridge-config.json`。不在原目录上改，也不搬旧数据：在新目录、新库上全新装一套，**只从旧部署拿凭据**。验收通过后在停机窗口切过去，旧目录和旧库原样留着做历史和回滚。

| 事项 | 新的一套 |
| --- | --- |
| 目录 | 新目录 `~/xa-new`，切换时改名成 `~/xa` |
| 数据库 | DBA 新建一个空库（如 `xa_oa2`）和账号，从验收开始就连它。旧库 `xa_oa` 不动、不再连 |
| 配置、会话、附件暂存、企微插件 | 全部新生成，不拷旧 `config/`（企微插件首次启动会自动装） |
| 凭据 | 用下面的脚本从旧目录取，或找管理员重新要 |
| 企微机器人 | 同一个机器人不能两套同时连：验收用**测试机器人**，切换时才换成生产机器人 |

代价：旧库里还没确认的单不会带过来，员工要重新报；会话上下文从零开始。工单台账以 OA 为准，旧库留着可查。

### 18.1 装新的一套并验收（不停机）

1. 给旧镜像留一个回滚标签，再按第 5 节构建新镜像：

   ```bash
   docker tag xa-gateway-oa:2026.9.2 xa-gateway-oa:before-env
   ```

2. 按第 3 节让 DBA 建新库和账号（库名换成 `xa_oa2`）。
3. 在 `~/xa-new` 按第 2 节建目录、拷文件（命令里的 `~/xa` 换成 `~/xa-new`），然后从旧部署取凭据写进 `.env`（旧 secret 文件属主是 1000，所以用 sudo 读）：

   ```bash
   sudo env OLD="$HOME/xa" NEW="$HOME/xa-new" XA_UID=$(id -u) XA_GID=$(id -g) python3 - <<'EOF'
   import json, os, pathlib, re
   old, new = pathlib.Path(os.environ["OLD"]), pathlib.Path(os.environ["NEW"])
   names = {
       "gateway_token": "OPENCLAW_GATEWAY_TOKEN",
       "wecom_bot_id": "XA_IT_WECOM_BOT_ID", "wecom_bot_secret": "XA_IT_WECOM_BOT_SECRET",
       "model_api_key": "XA_DOMESTIC_API_KEY", "model_base_url": "XA_DOMESTIC_BASE_URL", "model_id": "XA_DOMESTIC_MODEL_ID",
       "oa_api_user_id": "OA_API_USER_ID", "oa_app_secret": "OA_APP_SECRET",
       "wecom_identity_corpid": "WECOM_IDENTITY_CORPID", "wecom_identity_secret": "WECOM_IDENTITY_SECRET",
   }
   values = {var: (old / "secrets" / f"{file}.txt").read_text().strip() for file, var in names.items()}
   cfg = json.loads((old / "oa-bridge-config.json").read_text())
   values["OA_APP_ID"] = cfg.get("appId", "")
   values["OA_PUBLIC_KEY"] = cfg.get("publicKeySpkiBase64", "")
   values["XA_UID"], values["XA_GID"] = os.environ["XA_UID"], os.environ["XA_GID"]
   env = new / ".env"
   text = env.read_text()
   for var, value in values.items():
       if "'" in value:
           raise SystemExit(f"{var} 的值含单引号，请手工写进 .env")
       text = re.sub(rf"^{var}=.*$", lambda _: f"{var}='{value}'", text, flags=re.M)
   env.write_text(text)
   os.chown(env, int(os.environ["XA_UID"]), int(os.environ["XA_GID"]))
   os.chmod(env, 0o600)
   print("凭据已写入", env, "。还要手填：OA_MYSQL_*（新库）、机器人改成测试机器人")
   EOF
   ```

   然后手工改 `.env`：`OA_MYSQL_HOST` / `OA_MYSQL_DATABASE`（`xa_oa2`）/ `OA_MYSQL_USER` / `OA_MYSQL_PASSWORD` 填新库；`XA_IT_WECOM_BOT_ID` / `XA_IT_WECOM_BOT_SECRET` 先换成**测试机器人**；`OA_ACTIVE=false`。
4. 按第 6 节生成 `openclaw.json`（目标路径换成 `xa-new/config/openclaw.json`）。
5. 现网还占着容器名 `xa-gateway` 和端口 18789，新的一套先错开。在 `~/xa-new` 下建 `docker-compose.override.yml`（compose 会自动叠加）：

   ```yaml
   # 并行验收期间用，切换时删掉
   services:
     xa-gateway:
       container_name: xa-gateway-new
       ports: !override ["127.0.0.1:18799:18789"]
   ```

6. `cd ~/xa-new && docker compose up -d`，按第 7～9 节验收（第 8 节写企微通道时用的就是 `.env` 里的测试机器人）。CLI 用 `docker exec -it xa-gateway-new node dist/index.js …`，控制台走 18799。

### 18.2 切换（停机约 5 分钟，挑没人用的时间）

1. 先在**旧库**查未结的单：

   ```sql
   SELECT status, COUNT(*) FROM xa_oa.oa_ticket
    WHERE status IN ('awaiting_confirmation', 'submitting', 'unknown') GROUP BY status;
   ```

   `submitting` / `unknown` 必须先按第 16 节对账完再切（否则 OA 里有没有这张单就没人知道了）。`awaiting_confirmation` 切换后作废，员工重新报即可。
2. 清掉验收留下的测试单（只动新库）：

   ```sql
   TRUNCATE TABLE xa_oa2.oa_ticket; TRUNCATE TABLE xa_oa2.oa_inbox; TRUNCATE TABLE xa_oa2.oa_identity;
   ```

3. 两套都停，目录对调：

   ```bash
   cd ~/xa-new && docker compose down
   ```

   ```bash
   cd ~/xa && docker compose down
   ```

   ```bash
   mv ~/xa ~/xa-old && mv ~/xa-new ~/xa && rm ~/xa/docker-compose.override.yml
   ```

4. 把 `~/xa/.env` 的 `XA_IT_WECOM_BOT_ID` / `XA_IT_WECOM_BOT_SECRET` 换成**生产机器人**（旧目录 `~/xa-old/secrets/wecom_bot_*.txt` 里的值），`OA_ACTIVE` / `OA_ISNEXTFLOW` 设成现网要的值（旧 `~/xa-old/oa-bridge-config.json` 里的 `active` / `isnextflow`）。
5. 启动并验证：`cd ~/xa && docker compose up -d`，跑第 10 节健康检查和 OA 只读预检，用测试号私聊生产机器人报一次修再取消。

inbound 清理 cron 写的是 `$HOME/xa/...`，目录对调后不用改。

### 18.3 回滚与收尾

回滚（切换后发现问题）：

```bash
cd ~/xa && docker compose down
```

```bash
mv ~/xa ~/xa-new && mv ~/xa-old ~/xa
```

```bash
cd ~/xa && sed -i 's/^\(\s*image:\).*/\1 xa-gateway-oa:before-env/' docker-compose.yml && docker compose up -d
```

回滚后旧部署连的还是旧库；切换后在新部署里提交的单只在新库，OA 里照常存在。

观察一两周没问题，删掉回滚镜像。旧目录和旧库作为历史留档（使用统计 `docs/小A使用情况.md` 的数据就在旧目录里），确认不再需要后再删：

```bash
docker rmi xa-gateway-oa:before-env
```
