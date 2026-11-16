import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OAClientError } from "../src/oa-client.mjs";
import { getTicket, insertTicket, updateTicket } from "../src/store.mjs";
import { identityCode } from "../src/trust.mjs";
import { createOAWorkflowToolFactory } from "../src/tool.mjs";
import { createTestStore } from "./helpers.mjs";

function parse(result) {
  return JSON.parse(result.content[0].text);
}

function context(sender = "wecom-user-1", session = "room-1") {
  return { messageChannel: "wecom", requesterSenderId: sender, sessionKey: session };
}

let seq = 0;
/** 直接在库里放一张已提交的单（模拟之前经小A提交成功）。 */
async function seedSubmitted(store, { sender = "wecom-user-1", requestId, oaRequesterId = "13437", status = "submitted" }) {
  seq += 1;
  const confirmationId = `OA-TESTWITHDRAW-${String(seq).padStart(4, "0")}`;
  await insertTicket(store, {
    confirmationId,
    identity: identityCode(sender),
    session: identityCode("room-1"),
    oaRequesterId,
    draft: { externalTicketId: `IT-20261116-1000${String(seq).padStart(2, "0")}-WD${seq}`, summary: "电脑死机" },
    staged: [],
    expiresAt: Date.now() + 3_600_000,
  });
  await updateTicket(store, confirmationId, { status, requestId });
  return confirmationId;
}

async function setup(t, { active = true, withdrawAsMonitor = false, deleteRequest } = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-withdraw-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = createTestStore();
  const calls = [];
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: store,
    dependencies: {
      loadConfig: async () => ({ active, withdrawAsMonitor, pendingTtlHours: 24, identity: { adapter: "on" } }),
      clientFactory: () => ({
        deleteRequest: async (requestId, options) => {
          calls.push({ requestId, options });
          if (deleteRequest) return deleteRequest(requestId, options);
          return { requestId };
        },
      }),
    },
  });
  const run = async (params, ctx = context()) => parse(await factory(ctx).execute("call", { action: "withdraw", ...params }));
  return { store, calls, run };
}

test("只有一张已提交的单：不报单号也直接撤销，以申请人身份删除并记 withdrawn", async (t) => {
  const { store, calls, run } = await setup(t);
  const id = await seedSubmitted(store, { requestId: "1600001" });
  const result = await run({});
  assert.equal(result.code, "WITHDRAWN");
  assert.equal(result.requestId, "1600001");
  assert.deepEqual(calls, [{ requestId: "1600001", options: { operatorUserId: "13437", asMonitor: false } }]);
  assert.equal(result.replyZh, "🗑️ **已撤销**\n🎫 工单号：1600001\n\n这张单已从 OA 删除，处理人那边不会再看到。\n还有问题直接发给我，重新建单。");
  assert.equal((await getTicket(store, id)).status, "withdrawn");

  const again = await run({ requestId: "1600001" });
  assert.equal(again.code, "ALREADY_WITHDRAWN");
  assert.equal(calls.length, 1);
  const none = await run({});
  assert.equal(none.code, "NOTHING_TO_WITHDRAW");
});

test("多张已提交且没报单号：列出最近的单号请员工选，不调 OA", async (t) => {
  const { store, calls, run } = await setup(t);
  await seedSubmitted(store, { requestId: "1600001" });
  await seedSubmitted(store, { requestId: "1600002" });
  const result = await run({});
  assert.equal(result.code, "WITHDRAW_CHOOSE");
  assert.equal(calls.length, 0);
  assert.match(result.replyZh, /🎫 工单号：1600001/);
  assert.match(result.replyZh, /🎫 工单号：1600002/);
  assert.match(result.replyZh, /请回复要撤销的工单号/);

  const picked = await run({ requestId: " 1600002 " });
  assert.equal(picked.code, "WITHDRAWN");
  assert.equal(calls[0].requestId, "1600002");
});

test("只能撤销自己的单：别人的单号、没经小A提交的单号都当查不到", async (t) => {
  const { store, calls, run } = await setup(t);
  await seedSubmitted(store, { sender: "wecom-user-2", requestId: "1600009" });
  assert.equal((await run({ requestId: "1600009" })).code, "WITHDRAW_NOT_FOUND");
  assert.equal((await run({ requestId: "1234567" })).code, "WITHDRAW_NOT_FOUND");
  assert.equal((await run({})).code, "NOTHING_TO_WITHDRAW");
  assert.equal((await run({ requestId: "abc" })).code, "INVALID_REQUEST_ID");
  assert.equal(calls.length, 0);
});

test("OA 拒绝删除：NO_PERMISSION 提示联系处理人，结果不明提示再试，本地仍是 submitted", async (t) => {
  let next = new OAClientError("denied", { code: "NO_PERMISSION" });
  const { store, run } = await setup(t, { deleteRequest: async () => { throw next; } });
  const id = await seedSubmitted(store, { requestId: "1600003" });

  const denied = await run({});
  assert.equal(denied.code, "WITHDRAW_DENIED");
  assert.match(denied.replyZh, /撤销不了[\s\S]*1600003[\s\S]*联系处理人/);
  assert.equal((await getTicket(store, id)).status, "submitted");

  next = new OAClientError("unknown", { code: "NETWORK_OUTCOME_UNKNOWN", ambiguous: true });
  const unknown = await run({});
  assert.equal(unknown.code, "WITHDRAW_OUTCOME_UNKNOWN");
  assert.match(unknown.replyZh, /结果不确定/);

  next = new OAClientError("bad", { code: "PARAM_ERROR" });
  const rejected = await run({});
  assert.equal(rejected.code, "WITHDRAW_REJECTED");
  assert.equal((await getTicket(store, id)).status, "submitted");
});

test("withdrawAsMonitor 打开时用监控权限删除；桥接未激活时不调 OA", async (t) => {
  const monitor = await setup(t, { withdrawAsMonitor: true });
  await seedSubmitted(monitor.store, { requestId: "1600004" });
  assert.equal((await monitor.run({})).code, "WITHDRAWN");
  assert.equal(monitor.calls[0].options.asMonitor, true);

  const inactive = await setup(t, { active: false });
  await seedSubmitted(inactive.store, { requestId: "1600005" });
  const result = await inactive.run({});
  assert.equal(result.code, "OA_BRIDGE_INACTIVE");
  assert.match(result.replyZh, /暂时不能撤销/);
  assert.equal(inactive.calls.length, 0);
});

test("同一张单并发撤销只打一次 OA", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { store, calls, run } = await setup(t, { deleteRequest: async (requestId) => { await gate; return { requestId }; } });
  await seedSubmitted(store, { requestId: "1600006" });
  const first = run({});
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await run({});
  assert.equal(second.code, "WITHDRAWING");
  release();
  assert.equal((await first).code, "WITHDRAWN");
  assert.equal(calls.length, 1);
});

test("撤销后查进度：已提交列表不再含这张单", async (t) => {
  const { store, run } = await setup(t);
  await seedSubmitted(store, { requestId: "1600007" });
  await seedSubmitted(store, { requestId: "1600008" });
  await run({ requestId: "1600007" });
  const factoryStatus = await run({ action: "status" });
  assert.equal(factoryStatus.code, "PERSON_STATUS");
  assert.deepEqual(factoryStatus.submitted, [{ requestId: "1600008" }]);
});
