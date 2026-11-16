import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SYSTEMS_URL = new URL("../systems.json", import.meta.url);

export const TICKET_TYPE_NAMES = Object.freeze(["运维支持", "权限申请", "IT需求"]);
export const DEFAULT_INBOX_TTL_MINUTES = 30;

const jsonCache = new Map();

async function readJsonFile(url) {
  const filePath = fileURLToPath(url);
  const info = await stat(filePath);
  const hit = jsonCache.get(filePath);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.value;
  const value = JSON.parse(await readFile(filePath, "utf8"));
  jsonCache.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, value });
  return value;
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

/** Ecology otherParams.isnextflow：只允许字符串 "0" / "1"，缺字段或乱填拒绝加载。 */
export function requireIsnextflow(value) {
  const text = String(value ?? "").trim();
  if (text !== "0" && text !== "1") {
    throw new Error('isnextflow must be "0" or "1"');
  }
  return text;
}

function validateBaseUrl(value) {
  const parsed = new URL(String(value));
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "adtekoa.com" ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("OA base URL must be exactly https://adtekoa.com");
  }
  return "https://adtekoa.com";
}

function envText(env, name) {
  return String(env?.[name] ?? "").trim();
}

/** 环境变量有值就用它，否则用默认值。 */
function setting(env, name, fallback) {
  return envText(env, name) || fallback;
}

function parseBoolean(value, label) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off", ""].includes(text)) return false;
  throw new Error(`${label} must be true or false`);
}

/**
 * MySQL 连接参数：OA_MYSQL_HOST / OA_MYSQL_PORT（默认 3306）/ OA_MYSQL_USER / OA_MYSQL_DATABASE。
 * 部署时都写在 .env。密码只从 OA_MYSQL_PASSWORD 读（见 db.mjs）。
 */
export function loadMysqlConfig(env = process.env) {
  const config = {
    host: envText(env, "OA_MYSQL_HOST"),
    port: requirePositiveInteger(setting(env, "OA_MYSQL_PORT", 3306), "OA_MYSQL_PORT"),
    user: envText(env, "OA_MYSQL_USER"),
    database: envText(env, "OA_MYSQL_DATABASE"),
  };
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(config.host)) throw new Error("OA_MYSQL_HOST is required");
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(config.user)) throw new Error("OA_MYSQL_USER is required");
  if (!/^[A-Za-z0-9_]{1,64}$/.test(config.database)) throw new Error("OA_MYSQL_DATABASE is required");
  return config;
}

/**
 * 插件配置，全部来自环境变量（部署时写在 .env）：
 * - 每套环境都要填：OA_APP_ID、OA_PUBLIC_KEY；按需改：OA_ACTIVE（默认 false）、OA_ISNEXTFLOW（默认 "0"）
 * - 全公司固定、一般不改：OA_BASE_URL、OA_WORKFLOW_ID、OA_ATTACHMENT_FIELD、OA_PENDING_TTL_HOURS、
 *   OA_INBOX_TTL_MINUTES、OA_MAX_ATTACHMENT_BYTES、OA_MAX_TOTAL_ATTACHMENT_BYTES、OA_IDENTITY_ADAPTER
 * - 可选：OA_WITHDRAW_AS_MONITOR（默认 false，撤回已提交工单时是否用接口账号的监控权限）
 */
export async function loadBridgeConfig({ env = process.env } = {}) {
  const get = (name, fallback) => setting(env, name, fallback);
  const adapter = String(get("OA_IDENTITY_ADAPTER", "on")).toLowerCase();
  if (adapter !== "on" && adapter !== "off") throw new Error("OA_IDENTITY_ADAPTER must be on or off");
  const config = {
    active: parseBoolean(get("OA_ACTIVE", false), "OA_ACTIVE"),
    baseUrl: validateBaseUrl(get("OA_BASE_URL", "https://adtekoa.com")),
    appId: String(get("OA_APP_ID", "")).trim(),
    workflowId: requirePositiveInteger(get("OA_WORKFLOW_ID", 602), "OA_WORKFLOW_ID"),
    isnextflow: requireIsnextflow(get("OA_ISNEXTFLOW", "0")),
    publicKeySpkiBase64: String(get("OA_PUBLIC_KEY", "")).replace(/\s+/g, ""),
    attachmentFieldName: String(get("OA_ATTACHMENT_FIELD", "scfj")).trim(),
    pendingTtlHours: requirePositiveInteger(get("OA_PENDING_TTL_HOURS", 24), "OA_PENDING_TTL_HOURS"),
    // 建单前附件缓冲，对齐 OpenClaw 空闲 30 分钟开新会话；`/new` / session_end 会立刻清掉。
    inboxTtlMinutes: requirePositiveInteger(
      get("OA_INBOX_TTL_MINUTES", DEFAULT_INBOX_TTL_MINUTES),
      "OA_INBOX_TTL_MINUTES",
    ),
    maxAttachmentBytes: requirePositiveInteger(
      get("OA_MAX_ATTACHMENT_BYTES", 10 * 1024 * 1024),
      "OA_MAX_ATTACHMENT_BYTES",
    ),
    maxTotalAttachmentBytes: requirePositiveInteger(
      get("OA_MAX_TOTAL_ATTACHMENT_BYTES", 25 * 1024 * 1024),
      "OA_MAX_TOTAL_ATTACHMENT_BYTES",
    ),
    mysql: loadMysqlConfig(env),
    identity: { adapter },
    // 撤回已提交工单：默认以申请人身份收回；true 时以接口账号 + 监控权限收回（接口账号须有该流程的监控权限）。
    withdrawAsMonitor: parseBoolean(get("OA_WITHDRAW_AS_MONITOR", false), "OA_WITHDRAW_AS_MONITOR"),
  };
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(config.appId)) {
    throw new Error("OA_APP_ID is missing or invalid");
  }
  if (!/^[A-Za-z0-9+/=]{300,800}$/.test(config.publicKeySpkiBase64)) {
    throw new Error("OA_PUBLIC_KEY is missing or invalid");
  }
  if (config.attachmentFieldName && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(config.attachmentFieldName)) {
    throw new Error("Invalid OA_ATTACHMENT_FIELD");
  }
  return config;
}

export function resolveInboxTtlMs(config) {
  const minutes = Number(config?.inboxTtlMinutes);
  return (Number.isInteger(minutes) && minutes > 0 ? minutes : DEFAULT_INBOX_TTL_MINUTES) * 60 * 1000;
}

/**
 * systems.json：所属系统 → OA 下拉选项 ID、处理人 id（clry）、处理人姓名（员工可见）、允许的工单类型。
 * 返回查找表：options（名→ID）、handlers（名→处理人 ID 串）、names（名→姓名）、typeSystems（类型→允许系统集合）。
 */
export function parseSystems(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid systems.json");
  }
  const options = new Map();
  const handlers = new Map();
  const names = new Map();
  const typeSystems = new Map(TICKET_TYPE_NAMES.map((type) => [type, new Set()]));
  const optionIds = new Set();
  for (const [rawName, entry] of Object.entries(raw)) {
    const name = String(rawName).trim();
    const optionId = requirePositiveInteger(entry?.optionId, `systems.${name}.optionId`);
    const handlerIds = String(entry?.handlers ?? "").trim();
    if (!name || options.has(name) || optionIds.has(optionId)) {
      throw new Error("System names and option IDs must be unique");
    }
    if (!/^[1-9]\d{0,17}(,[1-9]\d{0,17})*$/.test(handlerIds)) {
      throw new Error(`systems.${name}.handlers must be comma-separated OA person IDs`);
    }
    const types = Array.isArray(entry?.types) ? entry.types : [];
    if (!types.length || types.some((type) => !typeSystems.has(type))) {
      throw new Error(`systems.${name}.types must list 运维支持 / 权限申请 / IT需求`);
    }
    options.set(name, optionId);
    optionIds.add(optionId);
    handlers.set(name, handlerIds);
    names.set(name, String(entry?.names ?? "").trim());
    for (const type of types) typeSystems.get(type).add(name);
  }
  return { options, handlers, names, typeSystems };
}

export async function loadSystems() {
  return parseSystems(await readJsonFile(SYSTEMS_URL));
}
