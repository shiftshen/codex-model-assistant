import test from "node:test";
import assert from "node:assert/strict";
import { LocalQueue } from "../src/local-queue.mjs";

test("cancelled queued requests never acquire a slot and releases are idempotent", async () => {
  const queue = new LocalQueue();
  const signal = new AbortController().signal;
  const first = await queue.acquire("gpu", signal);
  const controller = new AbortController();
  const cancelled = queue.acquire("gpu", controller.signal);
  const third = queue.acquire("gpu", signal);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  first();
  first();
  const release = await third;
  assert.equal(queue.queues.get("gpu").length, 1);
  release();
  assert.equal(queue.queues.size, 0);
});
