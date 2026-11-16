-- oa-workflow-bridge 建表语句（MySQL 5.7+ / 8.x，MariaDB 10.6+）。
-- 与 src/db.mjs 的 MYSQL_SCHEMA 逐字一致（tests/schema-sql.test.mjs 校验），改表时两处一起改。
-- 插件启动时会自动执行同样的建表语句（IF NOT EXISTS）；DBA 也可以在新库上先手工执行本文件。
-- 不做迁移：已有的表不会被补列，表结构变了就起新库。

CREATE TABLE IF NOT EXISTS oa_ticket (
    confirmation_id    VARCHAR(64)  NOT NULL,
    external_ticket_id VARCHAR(32)  NOT NULL,
    sender_code        CHAR(24)     NOT NULL,
    session_code       CHAR(24)     NOT NULL,
    status             VARCHAR(24)  NOT NULL,
    active_sender      CHAR(24)     NULL,
    oa_requester_id    VARCHAR(18)  NULL,
    ticket_type        VARCHAR(16)  NULL,
    system_name        VARCHAR(80)  NULL,
    location           VARCHAR(8)   NULL,
    draft_json         MEDIUMTEXT   NULL,
    staged_json        TEXT         NULL,
    request_id         VARCHAR(32)  NULL,
    error_code         VARCHAR(64)  NULL,
    submitted_at       BIGINT       NULL,
    expires_at         BIGINT       NOT NULL,
    created_at         BIGINT       NOT NULL,
    updated_at         BIGINT       NOT NULL,
    PRIMARY KEY (confirmation_id),
    UNIQUE KEY uk_active_sender (active_sender),
    KEY idx_external_ticket (external_ticket_id, created_at),
    KEY idx_sender_updated (sender_code, updated_at),
    KEY idx_status_expires (status, expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS oa_inbox (
    sender_code   CHAR(24) NOT NULL,
    session_codes TEXT     NOT NULL,
    state_json    TEXT     NOT NULL,
    expires_at    BIGINT   NOT NULL,
    updated_at    BIGINT   NOT NULL,
    PRIMARY KEY (sender_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS oa_identity (
    mapping_code CHAR(24)    NOT NULL,
    oa_user_id   VARCHAR(18) NULL,
    miss_code    VARCHAR(64) NULL,
    expires_at   BIGINT      NOT NULL,
    PRIMARY KEY (mapping_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
