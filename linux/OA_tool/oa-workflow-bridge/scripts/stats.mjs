#!/usr/bin/env node
/**
 * 只读使用统计：直接查 oa_ticket，不解析会话库。
 *   node scripts/stats.mjs [--days 30]
 * 数据库连接取自环境变量 OA_MYSQL_*（容器里已注入）。输出 JSON（不含任何员工身份）。
 */
import { loadBridgeConfig } from "../src/config.mjs";
import { createMysqlDb } from "../src/db.mjs";

const daysArg = process.argv.indexOf("--days");
const days = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 30;
const since = Date.now() - days * 24 * 60 * 60 * 1000;

const toCounts = (row) => ({ name: row.name, prepared: Number(row.prepared), submitted: Number(row.submitted || 0) });

const db = await createMysqlDb((await loadBridgeConfig()).mysql);
try {
  const byStatus = await db.query(
    "SELECT status, COUNT(*) AS n FROM oa_ticket WHERE created_at >= ? GROUP BY status ORDER BY n DESC",
    [since],
  );
  const people = await db.query(
    `SELECT COUNT(DISTINCT sender_code) AS users,
            COUNT(DISTINCT CASE WHEN status IN ('submitted', 'withdrawn') THEN sender_code END) AS submitters
       FROM oa_ticket WHERE created_at >= ?`,
    [since],
  );
  // 建单按 created_at 落日，提交按 submitted_at（OA 返回单号的时刻）落日。
  // 「提交」含之后被员工撤销（withdrawn，OA 已删除）的单：它们确实进过 OA；按状态的分布里 withdrawn 单独列出。
  const dayOf = (column) => `DATE_FORMAT(FROM_UNIXTIME(${column} / 1000), '%Y-%m-%d')`;
  const preparedPerDay = await db.query(
    `SELECT ${dayOf("created_at")} AS day, COUNT(*) AS n FROM oa_ticket WHERE created_at >= ? GROUP BY day`,
    [since],
  );
  const submittedPerDay = await db.query(
    `SELECT ${dayOf("submitted_at")} AS day, COUNT(*) AS n FROM oa_ticket
      WHERE status IN ('submitted', 'withdrawn') AND submitted_at >= ? GROUP BY day`,
    [since],
  );
  const perDay = new Map();
  for (const row of preparedPerDay) perDay.set(row.day, { day: row.day, prepared: Number(row.n), submitted: 0 });
  for (const row of submittedPerDay) {
    perDay.set(row.day, { day: row.day, prepared: perDay.get(row.day)?.prepared || 0, submitted: Number(row.n) });
  }
  // 类型 / 系统 / 地点是 prepare 时写入的列，终态后保留。地点得不出时为 NULL，显示为「未填」。
  const breakdown = (column) => db.query(
    `SELECT COALESCE(${column}, '未填') AS name, COUNT(*) AS prepared, SUM(status IN ('submitted', 'withdrawn')) AS submitted
       FROM oa_ticket WHERE created_at >= ? GROUP BY name ORDER BY prepared DESC`,
    [since],
  );
  const [byType, bySystem, byLocation] = await Promise.all([
    breakdown("ticket_type"),
    breakdown("system_name"),
    breakdown("location"),
  ]);
  const pendingReconcile = await db.query(
    "SELECT COUNT(*) AS n FROM oa_ticket WHERE status IN ('unknown', 'submitting')",
  );
  console.log(JSON.stringify({
    windowDays: days,
    tickets: Object.fromEntries(byStatus.map((row) => [row.status, Number(row.n)])),
    users: Number(people[0]?.users || 0),
    usersWithSubmitted: Number(people[0]?.submitters || 0),
    perDay: [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byTicketType: byType.map(toCounts),
    bySystem: bySystem.map(toCounts),
    byLocation: byLocation.map(toCounts),
    awaitingReconciliation: Number(pendingReconcile[0]?.n || 0),
  }, null, 2));
} finally {
  await db.close();
}
