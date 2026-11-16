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
const PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA" + "A".repeat(300) + "IDAQAB";
const BASE_ENV = { ...MYSQL_ENV, OA_APP_ID: "2026-09-01-test", OA_PUBLIC_KEY: PUBLIC_KEY };

test("只填必需的环境变量时，其余用默认值：不建单、不自动流转、流程 602", async () => {
  const config = await loadBridgeConfig({ env: BASE_ENV });
  assert.equal(config.active, false);
  assert.equal(config.isnextflow, "0");
  assert.equal(config.baseUrl, "https://adtekoa.com");
  assert.equal(config.workflowId, 602);
  assert.equal(config.attachmentFieldName, "scfj");
  assert.equal(config.pendingTtlHours, 24);
  assert.equal(config.inboxTtlMinutes, 30);
  assert.equal(config.maxAttachmentBytes, 10485760);
  assert.equal(config.maxTotalAttachmentBytes, 26214400);
  assert.equal(config.identity.adapter, "on");
  assert.deepEqual(config.mysql, { host: "10.0.0.5", port: 3306, user: "xa_oa", database: "xa_oa" });
});

test("环境变量可以打开建单、自动流转，也能覆盖固定项", async () => {
  const config = await loadBridgeConfig({
    env: { ...BASE_ENV, OA_ACTIVE: "true", OA_ISNEXTFLOW: "1", OA_INBOX_TTL_MINUTES: "45", OA_IDENTITY_ADAPTER: "OFF" },
  });
  assert.equal(config.active, true);
  assert.equal(config.isnextflow, "1");
  assert.equal(config.inboxTtlMinutes, 45);
  assert.equal(config.identity.adapter, "off");
});

test("必填项缺失或取值非法时拒绝加载", async () => {
  await assert.rejects(loadBridgeConfig({ env: { ...BASE_ENV, OA_APP_ID: "" } }), /OA_APP_ID is missing/);
  await assert.rejects(loadBridgeConfig({ env: { ...BASE_ENV, OA_PUBLIC_KEY: "" } }), /OA_PUBLIC_KEY is missing/);
  await assert.rejects(loadBridgeConfig({ env: { ...BASE_ENV, OA_ACTIVE: "maybe" } }), /OA_ACTIVE must be true or false/);
  await assert.rejects(loadBridgeConfig({ env: { ...BASE_ENV, OA_ISNEXTFLOW: "2" } }), /isnextflow must be "0" or "1"/);
  await assert.rejects(loadBridgeConfig({ env: { ...BASE_ENV, OA_BASE_URL: "https://evil.example" } }), /adtekoa\.com/);
  await assert.rejects(loadBridgeConfig({ env: { ...BASE_ENV, OA_IDENTITY_ADAPTER: "auto" } }), /OA_IDENTITY_ADAPTER/);
});

test("MySQL 连接参数来自环境变量，端口默认 3306，前后空白会去掉", () => {
  assert.deepEqual(
    loadMysqlConfig({ ...MYSQL_ENV, OA_MYSQL_HOST: " db.internal " }),
    { host: "db.internal", port: 3306, user: "xa_oa", database: "xa_oa" },
  );
  assert.equal(loadMysqlConfig({ ...MYSQL_ENV, OA_MYSQL_PORT: "3307" }).port, 3307);
});

test("MySQL 连接参数缺失或非法时拒绝加载", () => {
  assert.throws(() => loadMysqlConfig({}), /OA_MYSQL_HOST is required/);
  assert.throws(() => loadMysqlConfig({ ...MYSQL_ENV, OA_MYSQL_USER: "" }), /OA_MYSQL_USER is required/);
  assert.throws(() => loadMysqlConfig({ ...MYSQL_ENV, OA_MYSQL_DATABASE: "xa-oa;drop" }), /OA_MYSQL_DATABASE is required/);
  assert.throws(() => loadMysqlConfig({ ...MYSQL_ENV, OA_MYSQL_PORT: "abc" }), /OA_MYSQL_PORT must be a positive integer/);
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
