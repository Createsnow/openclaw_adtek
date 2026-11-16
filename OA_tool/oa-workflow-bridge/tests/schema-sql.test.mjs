import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MYSQL_SCHEMA } from "../src/db.mjs";

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
