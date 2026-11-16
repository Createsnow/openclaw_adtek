import assert from "node:assert/strict";
import test from "node:test";
import { loadBridgeConfig, loadMysqlConfig, parseSystems, requireIsnextflow } from "../src/config.mjs";

test('isnextflow 只接受字符串 "0" 或 "1"', () => {
  assert.equal(requireIsnextflow("0"), "0");
  assert.equal(requireIsnextflow("1"), "1");
  assert.equal(requireIsnextflow(" 1 "), "1");
  assert.throws(() => requireIsnextflow(), /isnextflow must be "0" or "1"/);
  assert.throws(() => requireIsnextflow(""), /isnextflow must be "0" or "1"/);
  assert.throws(() => requireIsnextflow("2"), /isnextflow must be "0" or "1"/);
  assert.throws(() => requireIsnextflow(true), /isnextflow must be "0" or "1"/);
});

const MYSQL_ENV = { OA_MYSQL_HOST: "10.0.0.5", OA_MYSQL_USER: "xa_oa", OA_MYSQL_DATABASE: "xa_oa" };

test("仓库 bridge-config.json：isnextflow 为 0，MySQL 连接参数来自环境变量", async () => {
  const config = await loadBridgeConfig({ env: MYSQL_ENV });
  assert.equal(config.isnextflow, "0");
  assert.deepEqual(config.mysql, { host: "10.0.0.5", port: 3306, user: "xa_oa", database: "xa_oa" });
  assert.equal(config.inboxTtlMinutes, 30);
  assert.equal(config.identity.adapter, "on");
});

test("MySQL 连接参数：环境变量优先，逐项回退到旧 bridge-config.json 的 mysql 段", () => {
  const legacy = { mysql: { host: "old-host", port: 3307, user: "old_user", database: "old_db" } };
  assert.deepEqual(loadMysqlConfig(legacy, {}), { host: "old-host", port: 3307, user: "old_user", database: "old_db" });
  assert.deepEqual(
    loadMysqlConfig(legacy, { OA_MYSQL_HOST: " new-host ", OA_MYSQL_PORT: "3308" }),
    { host: "new-host", port: 3308, user: "old_user", database: "old_db" },
  );
  assert.equal(loadMysqlConfig({}, MYSQL_ENV).port, 3306);
});

test("MySQL 连接参数缺失或非法时拒绝加载", () => {
  assert.throws(() => loadMysqlConfig({}, {}), /OA_MYSQL_HOST is required/);
  assert.throws(() => loadMysqlConfig({}, { ...MYSQL_ENV, OA_MYSQL_USER: "" }), /OA_MYSQL_USER is required/);
  assert.throws(() => loadMysqlConfig({}, { ...MYSQL_ENV, OA_MYSQL_DATABASE: "xa-oa;drop" }), /OA_MYSQL_DATABASE is required/);
  assert.throws(() => loadMysqlConfig({}, { ...MYSQL_ENV, OA_MYSQL_PORT: "abc" }), /OA_MYSQL_PORT must be a positive integer/);
});

test("systems.json 校验：选项 ID 唯一、处理人是数字串、类型必须是三类之一", () => {
  const ok = parseSystems({ 其他: { optionId: 17, handlers: "4280", types: ["运维支持"] } });
  assert.equal(ok.options.get("其他"), 17);
  assert.equal(ok.handlers.get("其他"), "4280");
  assert.equal(ok.typeSystems.get("运维支持").has("其他"), true);
  assert.equal(ok.typeSystems.get("权限申请").has("其他"), false);
  assert.throws(() => parseSystems({
    A: { optionId: 1, handlers: "1", types: ["运维支持"] },
    B: { optionId: 1, handlers: "2", types: ["运维支持"] },
  }), /unique/);
  assert.throws(() => parseSystems({ A: { optionId: 1, handlers: "张三", types: ["运维支持"] } }), /handlers/);
  assert.throws(() => parseSystems({ A: { optionId: 1, handlers: "1", types: ["报销"] } }), /types/);
});
