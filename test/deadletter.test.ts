import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapiClient } from "../src/capi.js";
import { FileDeadLetter, readDeadLetter, replayDeadLetter } from "../src/deadletter.js";
import { errResponse, makeEvents, okResponse } from "./helpers.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "capi-dl-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (n: number) => ({
  failed_at: "2026-01-01T00:00:00Z",
  attempts: 3,
  error: { status: 500, message: "x" },
  events: makeEvents(n),
});

describe("FileDeadLetter", () => {
  it("appends JSON lines and creates directories", async () => {
    const p = join(dir, "nested", "dl.jsonl");
    const dl = new FileDeadLetter(p);
    await dl.write(entry(1));
    await dl.write(entry(2));
    const lines = (await readFile(p, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).events).toHaveLength(2);
  });
  it("readDeadLetter returns [] for a missing file and skips corrupt lines", async () => {
    expect(await readDeadLetter(join(dir, "none.jsonl"))).toEqual([]);
    const p = join(dir, "dl.jsonl");
    await new FileDeadLetter(p).write(entry(1));
    const { appendFile } = await import("node:fs/promises");
    await appendFile(p, "{broken\n");
    expect(await readDeadLetter(p)).toHaveLength(1);
  });
});

describe("replayDeadLetter", () => {
  it("re-sends and clears successful entries", async () => {
    const p = join(dir, "dl.jsonl");
    await new FileDeadLetter(p).write(entry(2));
    const f = vi.fn(async () => okResponse());
    const client = new CapiClient({ pixelId: "1", accessToken: "t", fetch: f as unknown as typeof fetch });
    expect(await replayDeadLetter(p, client)).toEqual({ sent: 2, remaining: 0 });
    expect(await readDeadLetter(p)).toEqual([]);
  });
  it("keeps entries that fail again", async () => {
    const p = join(dir, "dl.jsonl");
    await new FileDeadLetter(p).write(entry(2));
    const f = vi.fn(async () => errResponse(400));
    const client = new CapiClient({ pixelId: "1", accessToken: "t", fetch: f as unknown as typeof fetch });
    expect(await replayDeadLetter(p, client)).toEqual({ sent: 0, remaining: 2 });
    expect(await readDeadLetter(p)).toHaveLength(1);
  });
});
