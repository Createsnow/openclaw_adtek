-- 迁移：oa_ticket 增加工单类型 / 所属系统 / 故障地点三列（2026-11-16）。
-- 适用：本日期之前建好的库。新库直接用 schema.sql，不用跑本文件。
-- 执行：DBA 在 xa_oa 库上执行一次，然后再上新版插件镜像（新插件 prepare 会写这三列，老库没列会建单失败；只读预检报 DB_SCHEMA_OUTDATED）。
-- 不可重复执行：第二次 ADD COLUMN 会报 Duplicate column，可忽略。

ALTER TABLE oa_ticket
  ADD COLUMN ticket_type VARCHAR(16) NULL AFTER oa_requester_id,
  ADD COLUMN system_name VARCHAR(80) NULL AFTER ticket_type,
  ADD COLUMN location    VARCHAR(8)  NULL AFTER system_name;

-- 回填：只有还没结束的单（draft_json 未清空）能补上；已提交 / 取消 / 过期 / 被拒的历史单 draft 已清，三列保持 NULL。
UPDATE oa_ticket
   SET ticket_type = JSON_UNQUOTE(JSON_EXTRACT(draft_json, '$.ticketType')),
       system_name = JSON_UNQUOTE(JSON_EXTRACT(draft_json, '$.systemName')),
       location    = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(draft_json, '$.location')), '')
 WHERE draft_json IS NOT NULL AND ticket_type IS NULL;

-- 核对：
-- SELECT status, ticket_type, system_name, location, COUNT(*) FROM oa_ticket GROUP BY 1, 2, 3, 4;
