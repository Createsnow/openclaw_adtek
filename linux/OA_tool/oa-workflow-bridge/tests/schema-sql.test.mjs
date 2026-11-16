import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { checkSchema, MYSQL_SCHEMA, REQUIRED_COLUMNS } from "../src/db.mjs";
import { createSqliteDb, toSqliteDdl } from "./helpers.mjs";

const SQL_DIR = new URL("../sql/", import.meta.url);

/** 去掉 `--` 注释，按 `;` 切成语句，压掉多余空白。 */
function statements(text) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((sql) => sql.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

test("sql/schema.sql 与 db.mjs 的 MYSQL_SCHEMA 一致", async () => {
  const fromFile = statements(await readFile(new URL("schema.sql", SQL_DIR), "utf8"));
  assert.deepEqual(fromFile, MYSQL_SCHEMA.map((sql) => sql.replace(/\s+/g, " ").trim()));
});

test("迁移脚本加的列就是预检要求的列", async () => {
  const migration = await readFile(new URL("20261116_oa_ticket_type_system_location.sql", SQL_DIR), "utf8");
  const added = [...migration.matchAll(/ADD COLUMN (\w+)/g)].map((match) => match[1]);
  assert.deepEqual(added, REQUIRED_COLUMNS.oa_ticket);
});

test("新库预检通过；缺新列的老库预检报 DB_SCHEMA_OUTDATED", async () => {
  await checkSchema(createSqliteDb());

  const sqlite = new DatabaseSync(":memory:");
  for (const ddl of MYSQL_SCHEMA) {
    sqlite.exec(toSqliteDdl(ddl).replace(/\n\s*(ticket_type|system_name|location)\s+VARCHAR\(\d+\)\s+NULL,/g, ""));
  }
  const legacy = {
    async query(sql, params = []) {
      return sqlite.prepare(sql).all(...params);
    },
  };
  await assert.rejects(checkSchema(legacy), { code: "DB_SCHEMA_OUTDATED" });
});
