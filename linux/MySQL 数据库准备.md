# MySQL 数据库准备

适用对象：给 OA 桥接插件 `oa-workflow-bridge` 准备数据库的运维 / DBA。

前提：MySQL 装在**独立机器**上（裸装，已有管理员账号），Gateway 虚机通过局域网连它。插件只需要一个库、一个账号；表由插件启动时自动创建（建表语句的独立副本在 `OA_tool/oa-workflow-bridge/sql/schema.sql`，也可先手工执行）。表结构、读写方式见 [OA_tool/OA Workflow Bridge 接入手册.md](OA_tool/OA%20Workflow%20Bridge%20接入手册.md) 第 2 节。

| 项 | 要求 |
| --- | --- |
| 版本 | MySQL 5.7+ / 8.x，或 MariaDB 10.6+ |
| 字符集 | `utf8mb4` |
| 引擎 | InnoDB |
| 数据量 | 每张确认单一行，月约百级；三张表合计远小于 1 GB |
| 连接 | 插件连接池最多 4 个连接 |

---

## 1. 建库与账号（管理员执行一次）

把 `<Gateway 虚机 IP>` 换成 Gateway 所在 Linux 虚机的内网 IP，密码用强随机串：

```sql
CREATE DATABASE IF NOT EXISTS xa_oa
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'xa_oa'@'<Gateway 虚机 IP>' IDENTIFIED BY '<强随机密码>';

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER
  ON xa_oa.* TO 'xa_oa'@'<Gateway 虚机 IP>';

FLUSH PRIVILEGES;
```

- 账号只授权这一个库，不要给 `ALL ON *.*`，不要用 root。
- `CREATE` / `INDEX` / `ALTER` 用于插件启动时 `CREATE TABLE IF NOT EXISTS`。
- 已经建好账号的，按实际账号名改 `bridge-config.json` 的 `mysql.user`，并补上面的 `GRANT`。
- 裸装后建议跑一次 `mysql_secure_installation`：删匿名账号、禁 root 远程。**匿名账号 `''@'localhost'` 会抢先匹配**，同机测试时表现为 `Access denied for user 'xa_oa'@'localhost'`。

## 2. 网络

1. MySQL 监听内网地址：`my.cnf` 的 `bind-address` 不能只有 `127.0.0.1`（改成本机内网 IP 或 `0.0.0.0`），改完重启 MySQL。
2. 防火墙只放通 Gateway 虚机 → MySQL 3306，不要对公网开放。
3. 在 Gateway 虚机上验证（只验连通，不留密码在历史里）：

```bash
nc -vz <MySQL 主机> 3306
```

## 3. 写进 xA 部署

非机密参数写 `~/xa/oa-bridge-config.json`：

```json
"mysql": { "host": "<MySQL 主机>", "port": 3306, "user": "xa_oa", "database": "xa_oa" }
```

密码只走 secret（凭据方式与其它 secret 相同）：

```bash
printf '%s' '<强随机密码>' > ~/xa/secrets/oa_mysql_password.txt
```

```bash
chmod 600 ~/xa/secrets/oa_mysql_password.txt
```

compose 的 `secrets` 与 `entrypoint.sh` 的 `export OA_MYSQL_PASSWORD=…` 仓库 `docker/` 里已写好。改完 `docker compose down && docker compose up -d`。

## 4. 验证

1. Gateway 日志出现 `[oa-workflow-bridge] loaded (MySQL state)`，没有 `MySQL init failed`。
2. MySQL 里能看到三张表：

```sql
SHOW TABLES FROM xa_oa;   -- oa_identity / oa_inbox / oa_ticket
```

3. 跑插件只读预检（接入手册 8.2），结果含 `"db":"OK"`。

## 5. 老库升级（加列）

插件启动只做 `CREATE TABLE IF NOT EXISTS`，**不会给已有的表补列**。每次改表在 `OA_tool/oa-workflow-bridge/sql/` 下加一份 `YYYYMMDD_*.sql`，升级镜像前由 DBA 按文件名日期顺序执行没执行过的脚本：

| 脚本 | 内容 |
| --- | --- |
| `20261116_oa_ticket_type_system_location.sql` | `oa_ticket` 加 `ticket_type` / `system_name` / `location`，并从未结束单的 `draft_json` 回填；已结束的历史单为 NULL |

```bash
mysql -h <MySQL 主机> -u <有 ALTER 权限的账号> -p xa_oa < 20261116_oa_ticket_type_system_location.sql
```

执行后跑插件只读预检（接入手册 8.2），不再报 `DB_SCHEMA_OUTDATED` 即可上新镜像。顺序反了（先上镜像）会导致建单失败，补执行脚本即恢复，无需重启。

## 6. 备份

- 开 binlog 或至少每日 `mysqldump`：

```bash
mysqldump --single-transaction --routines xa_oa > xa_oa_$(date +%F).sql
```

- `oa_ticket` 是工单台账（幂等与对账依据），按普通业务库保留；`oa_inbox` / `oa_identity` 是短期缓存，丢了会自动重建。
- 恢复后不用改插件配置；Gateway 下次调用会自动重连。

## 7. 不要做

- 不要把密码写进 `bridge-config.json`、`openclaw.json` 或 compose `environment:`。
- 不要让两个 Gateway 连同一个库。
- 不要手工删 `oa_ticket` 历史行；需要人工对账时只按接入手册 8.3 改状态。
- 不要把测试库和生产库混用；集成测试会清空表。
