import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStore } from "./store.js";

test("reserve, release, deliver and complete are durable and idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chengletter-"));
  try {
    const store = new JsonStore(dir);
    const event = { id: "tg:1", kind: "telegram_message" as const, source: "telegram" as const, createdAt: new Date().toISOString(), visibleText: "hello", modelContext: "eventId=tg:1", telegramChatId: "7", telegramMessageId: 8, status: "pending" as const, retryCount: 0 };
    assert.equal(await store.enqueue(event), true);
    assert.equal(await store.enqueue(event), false);
    assert.equal((await store.reserveNext(120))?.id, "tg:1");
    assert.equal(await store.reserveNext(120), null);
    await store.release("tg:1");
    assert.equal((await store.reserveNext(120))?.retryCount, 1);
    await store.markHostSent("tg:1");
    assert.deepEqual(await store.getReplyTarget("tg:1"), { chatId: "7", messageId: 8, completed: false });
    await store.markCompleted("tg:1");
    assert.equal((await store.getReplyTarget("tg:1")).completed, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
