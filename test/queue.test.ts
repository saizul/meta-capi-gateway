import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapiClient } from "../src/capi.js";
import type { DeadLetterEntry } from "../src/deadletter.js";
import { EventQueue } from "../src/queue.js";
import { errResponse, makeEvent, makeEvents, okResponse } from "./helpers.js";

function setup(fetchFn: typeof fetch, over: Partial<ConstructorParameters<typeof EventQueue>[0]> = {}) {
  const dead: DeadLetterEntry[] = [];
  const client = new CapiClient({
    pixelId: "1",
    accessToken: "t",
    fetch: fetchFn,
    sleep: async () => {},
    maxRetries: 1,
  });
  const queue = new EventQueue({
    client,
    deadLetter: { write: async (e) => void dead.push(e) },
    batchSize: 3,
    flushIntervalMs: 1000,
    maxQueue: 10,
    ...over,
  });
  return { queue, dead };
}

const batches = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string).data.length);

describe("EventQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flushes when batch size is reached", async () => {
    const f = vi.fn(async () => okResponse());
    const { queue } = setup(f as unknown as typeof fetch);
    queue.add(makeEvents(3));
    await queue.shutdown();
    expect(batches(f)).toEqual([3]);
  });
  it("flushes on the interval", async () => {
    const f = vi.fn(async () => okResponse());
    const { queue } = setup(f as unknown as typeof fetch);
    queue.add([makeEvent(1)]);
    expect(f).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(batches(f)).toEqual([1]);
    expect(queue.size()).toBe(0);
  });
  it("accumulates across add calls into one batch", async () => {
    const f = vi.fn(async () => okResponse());
    const { queue } = setup(f as unknown as typeof fetch);
    queue.add([makeEvent(1)]);
    queue.add([makeEvent(2)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(batches(f)).toEqual([2]);
  });
  it("rejects adds beyond maxQueue", () => {
    const f = vi.fn(async () => okResponse());
    const { queue } = setup(f as unknown as typeof fetch, { batchSize: 100, maxQueue: 5 });
    expect(queue.add(makeEvents(5))).toBe(true);
    expect(queue.add(makeEvents(1))).toBe(false);
    expect(queue.size()).toBe(5);
  });
  it("rejects adds after shutdown", async () => {
    const { queue } = setup(vi.fn(async () => okResponse()) as unknown as typeof fetch);
    await queue.shutdown();
    expect(queue.add([makeEvent(1)])).toBe(false);
  });
  it("shutdown drains pending events", async () => {
    const f = vi.fn(async () => okResponse());
    const { queue } = setup(f as unknown as typeof fetch);
    queue.add([makeEvent(1)]);
    await queue.shutdown();
    expect(batches(f)).toEqual([1]);
    expect(queue.size()).toBe(0);
  });
  it("writes failed batches to the dead letter with the error", async () => {
    const f = vi.fn(async () => errResponse(400, { code: 100, message: "bad" }));
    const { queue, dead } = setup(f as unknown as typeof fetch);
    queue.add(makeEvents(2));
    await queue.shutdown();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.events.map((e) => e.event_id)).toEqual(["evt-0", "evt-1"]);
    expect(dead[0]?.error.code).toBe(100);
    expect(JSON.stringify(dead[0])).not.toContain("access_token");
  });
  it("dead-letters after retries are exhausted", async () => {
    const f = vi.fn(async () => errResponse(500, { code: 2 }));
    const { queue, dead } = setup(f as unknown as typeof fetch);
    queue.add([makeEvent(1)]);
    await queue.shutdown();
    expect(f).toHaveBeenCalledTimes(2);
    expect(dead[0]?.attempts).toBe(2);
  });
  it("survives a failing dead letter sink", async () => {
    const f = vi.fn(async () => errResponse(400));
    const { queue } = setup(f as unknown as typeof fetch, {
      deadLetter: { write: async () => Promise.reject(new Error("disk full")) },
    });
    queue.add([makeEvent(1)]);
    await expect(queue.shutdown()).resolves.toBeUndefined();
  });
  it("does not send when empty", async () => {
    const f = vi.fn();
    const { queue } = setup(f as unknown as typeof fetch);
    await queue.flush();
    expect(f).not.toHaveBeenCalled();
  });
});
