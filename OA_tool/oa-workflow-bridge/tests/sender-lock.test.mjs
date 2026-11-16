import assert from "node:assert/strict";
import test from "node:test";
import { withSenderLock } from "../src/store.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("同一个人的操作串行，按进入顺序执行", async () => {
  const order = [];
  const task = (name, ms) => withSenderLock("a".repeat(24), async () => {
    order.push(`${name}-start`);
    await sleep(ms);
    order.push(`${name}-end`);
  });
  await Promise.all([task("first", 30), task("second", 5), task("third", 1)]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end", "third-start", "third-end"]);
});

test("不同的人互不等待", async () => {
  const order = [];
  let releaseSlow;
  const slow = withSenderLock("b".repeat(24), async () => {
    order.push("slow-start");
    await new Promise((resolve) => { releaseSlow = resolve; });
    order.push("slow-end");
  });
  await sleep(5);
  await withSenderLock("c".repeat(24), async () => { order.push("other-done"); });
  releaseSlow();
  await slow;
  assert.deepEqual(order, ["slow-start", "other-done", "slow-end"]);
});

test("同一个人的锁可重入，嵌套不会死锁", async () => {
  const key = "d".repeat(24);
  const result = await withSenderLock(key, () => withSenderLock(key, async () => "nested-ok"));
  assert.equal(result, "nested-ok");
});

test("回调抛错后锁照常释放", async () => {
  const key = "e".repeat(24);
  await assert.rejects(withSenderLock(key, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await withSenderLock(key, async () => "after-error"), "after-error");
});

test("没有发送人码时拒绝加锁", async () => {
  await assert.rejects(withSenderLock("", async () => {}), /sender code/);
});
