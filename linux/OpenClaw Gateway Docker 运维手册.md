# OpenClaw Gateway Docker 运维手册

装完之后怎么养：启停、巡检、备份、升级、排障、OA 对账。第一次安装见 [OpenClaw Gateway Linux 服务器安装手册.md](OpenClaw%20Gateway%20Linux%20服务器安装手册.md)。

## 1. 约定与启停

| 项 | 值 |
| --- | --- |
| 目录 | `~/xa`（所有 compose 命令在这里执行） |
| 容器 / 镜像 | `xa-gateway` / `xa-gateway-oa:2026.9.2`（OA 插件在镜像 `/opt/xa/oa-workflow-bridge`） |
| 健康检查 | `http://127.0.0.1:18789/healthz` |
| 容器内 CLI | `alias oc='docker exec -it xa-gateway node dist/index.js'` |
| OA 状态库 | 独立 MySQL `xa_oa`，不在本机 compose 里 |

凭据都在 `~/xa/.env`，由 compose 注入成容器环境变量。`docker exec` 里同样读得到，CLI 不用带 `-e`。容器以 `.env` 里的 `XA_UID` / `XA_GID` 运行，`~/xa` 下的文件不用 chown。

改了什么、怎么生效：

| 改动 | 生效方式 |
| --- | --- |
| `openclaw.json` 业务字段（tools、allowFrom、bindings） | 多数热重载；不生效再 `docker compose restart xa-gateway` |
| `skills` / `bootstrapMaxChars` | `restart`，再在企微 `/new`（旧会话缓存截断结果） |
| 工作区规则 `AGENTS.md` 等 | 下一轮对话生效；建议 `/new` |
| `~/xa/.env`、compose、`plugins.load.paths`、端口 / bind | `docker compose up -d`（compose 发现变化会自动重建容器；`restart` 读不到新的 `.env`） |
| OA 插件代码、`systems.json` | 重建镜像（建议新 tag），改 compose `image:`，`up -d` |

改 json 前先 `config validate`。禁止在容器里 `onboard` / `setup`，禁止用 `config set` 把 `${VAR}` 覆盖成明文。Control UI 若写出 `~/xa/config/agents/itservicedeskagent/agent/models.json`（可能含明文 Key），删掉后 `restart`。

## 2. 健康检查（出问题先跑）

只读脚本，不改配置、不重启：

```bash
bash <<'EOF'
cd ~/xa || exit 1
systemctl is-active docker
docker compose ps
docker inspect -f 'Status={{.State.Status}} Health={{.State.Health.Status}} RestartCount={{.State.RestartCount}}' xa-gateway
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

## 3. 日志

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

日志里出现 Gateway Token、BotSecret、模型 Key、Authorization、附件 base64、原始 SenderId，按安全事件处理：停止外传，轮换对应密钥。

容器日志已轮转（`json-file`，20m × 5）。轮转不管会话 jsonl 和 `media/inbound`。

## 4. 巡检

| 频率 | 检查 | 通过标准 |
| --- | --- | --- |
| 每日 | 第 2 节脚本 | 全部符合期望 |
| 每日 | 测试机器人发「你是谁」，同时 `docker logs -f` | 有 inbound、`Reply message sent`、`Reply ack received` |
| 每周 | `du -sh ~/xa/config/media/inbound ~/xa/workspace/media/inbound`；`tail -n 14 ~/xa/logs/inbound-prune.log` | 每天都有 `done total_deleted=` 记录 |
| 每周 | `docker system df`；`du -sh ~/xa` | 增长可解释 |
| 每周 | MySQL：`SELECT status, COUNT(*) FROM xa_oa.oa_ticket GROUP BY status;` | `unknown` / `submitting` 为 0，否则走第 10 节 |
| 每周 | `grep -nE 'sk-\|apiKey.: ."[^$]' ~/xa/config/openclaw.json` | 无明文 Key |
| 每月 | 第 5 节备份，`tar -tzf` 能列出 | 是 |
| 每月 | 记录镜像 digest、OpenClaw 版本、企微插件版本 | 已记 |
| 每月 | 百炼 Key、企微 Secret、OA AppSecret 是否临期 | 未过期 |

## 5. 备份与恢复

| 必须备份 | 可重建 |
| --- | --- |
| `~/xa` 下 `docker-compose.yml`、`.env`、`config/`（含已装的企微插件）、`workspace/` | 镜像（按仓库重建） |
| MySQL `xa_oa`（`mysqldump`，见安装手册第 3 节） | 容器 |

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
docker images | grep xa-gateway-oa      # 没有就按安装手册第 5 节重建
cd ~/xa && docker compose up -d
```

换了机器或换了登录用户时，先把 `.env` 里的 `XA_UID` / `XA_GID` 改成新用户的 `id -u` / `id -g`。`oc plugins list` 里没有企微插件就按安装手册第 8 节重装。验证后先用测试机器人，再切回生产 Bot。

## 6. 密钥轮换与升级

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

**升级 OpenClaw**：改 `docker/Dockerfile` 的 `OPENCLAW_IMAGE`（或 `--build-arg`），用新 tag 构建，改 compose `image:`，`up -d`，再 `config validate`、`doctor`（只看不改）。回滚 = 把 `image:` 改回旧 tag 再 `up -d`。`doctor --fix` 会改 `agents.entries`，先备份 json，不要在生产 Bot 上首次试。配置被改坏时连 `config/` 一起恢复。

**升级企微插件**：见 [WeCom 通道插件接入手册.md](WeCom%20通道插件接入手册.md) 第 5 节。

升级后回归：第 2 节 + 测试机器人发「你是谁」，`model-fetch` 到 `kind=final` 约 2～5 秒。

## 7. inbound 原件回收（cron）

插件提交后只删自己的 staging 副本，通道落盘的原件在两处，都会涨：

| 宿主机 | 说明 |
| --- | --- |
| `~/xa/config/media/inbound` | OpenClaw state 目录下的原件 |
| `~/xa/workspace/media/inbound` | 工作区下的原件 |

用仓库脚本 `docker/prune-inbound.sh`：只删满 24 小时（`-mmin +1440`）的文件，日志写 `~/xa/logs/inbound-prune.log`（北京时间）。

```bash
mkdir -p ~/xa/scripts ~/xa/logs
cp ~/handoff/xa/docker/prune-inbound.sh ~/xa/scripts/ && chmod 700 ~/xa/scripts/prune-inbound.sh
find ~/xa/config/media/inbound ~/xa/workspace/media/inbound -type f -mmin +1440 -ls   # 先干跑
~/xa/scripts/prune-inbound.sh && tail -n 5 ~/xa/logs/inbound-prune.log
( crontab -l 2>/dev/null; echo "15 3 * * * $HOME/xa/scripts/prune-inbound.sh" ) | crontab -
crontab -l && systemctl is-active cron
```

用跑 Gateway 的同一用户，不要 root。脚本在、crontab 没有，不会自动删。

不要：`rm -rf ~/xa/workspace`；对工作区根目录 `find -delete`；手删 `oa-workflow-bridge/staging/`（插件自己回收）；为腾盘删 `oa_ticket`。

## 8. 崩溃熔断（crash-loop breaker）

日志出现 `restart-loop breaker tripped` / `[wecom] channel autostart suppressed`：5 分钟内多次不洁启动后，控制面照常起来，但通道不自动拉。先修好根因（json / `.env` / 插件路径），然后二选一：

- 什么都不做，约 5 分钟后同一进程会自己拉起通道；
- 立即拉起：

```bash
docker exec -it xa-gateway node dist/index.js gateway call channels.start --params '{"channel":"wecom","accountId":"default"}'
```

不要再 `compose restart`（会重新计数），不要用 `channels start --channel`。之后 `channels status --channel wecom --probe` 应为 `works`，日志有 `Authentication successful`。

## 9. 排障速查

| 现象 | 处理 |
| --- | --- |
| `Cannot connect to the Docker daemon` | `sudo systemctl start docker`；`groups` 含 `docker` |
| 容器 `Restarting` | `docker logs --tail 200 xa-gateway`；`down`，按日志改 json，`up`。Restarting 时别 `exec` |
| `/healthz` 不通但容器 Up | `gateway.bind` 必须是 `lan`；看启动日志 |
| 企微突然不回 | 先看日志有无熔断（第 8 节）；没有就 `restart`；仍不行 `up -d --force-recreate`，并查有无第二套容器抢同一 Bot：`docker ps -a` |
| 回复很慢 | 时间线：inbound → `model-fetch` → `kind=final` → `Reply message sent`。见 [DashScope 手册](DashScope%20兼容%20Provider%20配置手册.md) 第 4 节 |
| `Unknown model` / unresolved | `.env` 的 `XA_DOMESTIC_MODEL_ID` 填错，或 json 的 Provider 键不是 `bailian` |
| `MySQL init failed` / `DB_UNAVAILABLE` | 见安装手册第 10 节 |
| `Cannot find package 'mysql2'` / `plugin path not found: /opt/xa/…` | 不是自建镜像；重建并核对 compose `image:` |
| 员工「还不能提交到 OA」/ `OA_IDENTITY_*` | [企微到OA身份.md](OA_tool/企微到OA身份.md) 第 7 节 |
| 员工「OA 需要人工核对」/ `RECONCILIATION_REQUIRED` | 第 10 节对账；禁止让员工再点确认 |
| 日志出现 `smartsheet_get_records` | `alsoAllow` 混进了旧工具；两处只留 `oa_workflow` |
| 磁盘满 | `df -h`；`du -sh ~/xa/* \| sort -h`；先清 inbound（第 7 节）和悬空镜像（`docker image prune -f`）；不要 `docker system prune -a --volumes` |
| OOM | `docker inspect -f '{{.State.OOMKilled}}' xa-gateway`；找平台扩虚机，不要只加 `mem_limit` |

OA 只读预检（不建单）：

```bash
docker exec xa-gateway node /opt/xa/oa-workflow-bridge/scripts/readonly-preflight.mjs
```

## 10. OA 结果不明（unknown）对账

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

## 11. 多套环境与安全

- 同一企微 Bot 只能被一个 Gateway 持有，不要同时 `up` 两套 `.env` 里是同一个 Bot 的目录。
- 另一套业务用独立目录、容器名、端口、`.env`、Bot：`~/xa-hr` / `xa-hr-gateway` / `18790`，测试 `~/xa-staging` / `18791`。可以共用 MySQL 服务器，但必须不同库、不同账号。
- `.env` 不进 git；机器上除了运维还有别人能登录时 `chmod 600 ~/xa/.env`。docker 组只给运维（能跑 docker 就能 `docker inspect` 看到环境变量）。`docker port xa-gateway` 应只绑 `127.0.0.1`。
- 测试环境只用测试机器人，不放生产 BotSecret。

## 12. 换成新部署方式：全新起一套再切换

2026-11 之前装的环境用 `secrets/*.txt` + `entrypoint.sh` + `oa-bridge-config.json`。不在原目录上改，也不搬旧数据：在新目录、新库上全新装一套，**只从旧部署拿凭据**。验收通过后在停机窗口切过去，旧目录和旧库原样留着做历史和回滚。

| 事项 | 新的一套 |
| --- | --- |
| 目录 | 新目录 `~/xa-new`，切换时改名成 `~/xa` |
| 数据库 | DBA 新建一个空库（如 `xa_oa2`）和账号，从验收开始就连它。旧库 `xa_oa` 不动、不再连 |
| 配置、会话、附件暂存、企微插件 | 全部新生成，不拷旧 `config/`（企微插件首次启动会自动装） |
| 凭据 | 用下面的脚本从旧目录取，或找管理员重新要 |
| 企微机器人 | 同一个机器人不能两套同时连：验收用**测试机器人**，切换时才换成生产机器人 |

代价：旧库里还没确认的单不会带过来，员工要重新报；会话上下文从零开始。工单台账以 OA 为准，旧库留着可查。

### 12.1 装新的一套并验收（不停机）

1. 给旧镜像留一个回滚标签，再按安装手册第 5 节构建新镜像：

   ```bash
   docker tag xa-gateway-oa:2026.9.2 xa-gateway-oa:before-env
   ```

2. 按安装手册第 3 节让 DBA 建新库和账号（库名换成 `xa_oa2`）。
3. 在 `~/xa-new` 按安装手册第 2 节建目录、拷文件（命令里的 `~/xa` 换成 `~/xa-new`），然后从旧部署取凭据写进 `.env`（旧 secret 文件属主是 1000，所以用 sudo 读）：

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
4. 按安装手册第 6 节生成 `openclaw.json`。
5. 现网还占着容器名 `xa-gateway` 和端口 18789，新的一套先错开。在 `~/xa-new` 下建 `docker-compose.override.yml`（compose 会自动叠加）：

   ```yaml
   # 并行验收期间用，切换时删掉
   services:
     xa-gateway:
       container_name: xa-gateway-new
       ports: !override ["127.0.0.1:18799:18789"]
   ```

6. `cd ~/xa-new && docker compose up -d`，按安装手册第 7～9 节验收（第 8 节写企微通道时用的就是 `.env` 里的测试机器人）。CLI 用 `docker exec -it xa-gateway-new node dist/index.js …`，控制台走 18799。

### 12.2 切换（停机约 5 分钟，挑没人用的时间）

1. 先在**旧库**查未结的单：

   ```sql
   SELECT status, COUNT(*) FROM xa_oa.oa_ticket
    WHERE status IN ('awaiting_confirmation', 'submitting', 'unknown') GROUP BY status;
   ```

   `submitting` / `unknown` 必须先按第 10 节对账完再切（否则 OA 里有没有这张单就没人知道了）。`awaiting_confirmation` 切换后作废，员工重新报即可。
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
5. 启动并验证：`cd ~/xa && docker compose up -d`，跑第 2 节健康检查和 OA 只读预检，用测试号私聊生产机器人报一次修再取消。

inbound 清理 cron 写的是 `$HOME/xa/...`，目录对调后不用改。

### 12.3 回滚与收尾

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
