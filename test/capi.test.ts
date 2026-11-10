import { describe, expect, it, vi } from "vitest";
import { API_MAX_BATCH, CapiClient, toServerEvent } from "../src/capi.js";
import { sha256 } from "../src/hash.js";
import { errResponse, makeEvents, okResponse } from "./helpers.js";
import { validateEvent } from "../src/schema.js";

const NOW = 1_800_000_000;

function client(fetchFn: typeof fetch, extra: Record<string, unknown> = {}) {
  const sleep = vi.fn(async () => {});
  const c = new CapiClient({
    pixelId: "1234567890",
    accessToken: "SECRET_TOKEN",
    apiVersion: "v23.0",
    fetch: fetchFn,
    sleep,
    random: () => 1,
    baseDelayMs: 100,
    ...extra,
  });
  return { c, sleep };
}

describe("toServerEvent", () => {
  const parsed = validateEvent(
    {
      event_name: "Purchase",
      event_id: "dedup-1",
      event_source_url: "https://shop.example.com/thanks",
      user: { email: "A@B.com", phone: "01712345678", fbp: "fb.1.1700000000000.1" },
      custom_data: { value: 10, currency: "usd" },
    },
    NOW,
  );
  if (!parsed.ok) throw new Error("fixture invalid");
  const ev = toServerEvent(parsed.value, { ip: "203.0.113.5", userAgent: "UA/1", defaultCountryCode: "880" });

  it("sets action_source website", () => expect(ev.action_source).toBe("website"));
  it("preserves event_id for browser/server dedup", () => expect(ev.event_id).toBe("dedup-1"));
  it("hashes em and ph", () => {
    expect(ev.user_data.em).toEqual([sha256("a@b.com")]);
    expect(ev.user_data.ph).toEqual([sha256("8801712345678")]);
  });
  it("keeps ip and user agent unhashed", () => {
    expect(ev.user_data.client_ip_address).toBe("203.0.113.5");
    expect(ev.user_data.client_user_agent).toBe("UA/1");
  });
  it("carries fbp, source url and custom data", () => {
    expect(ev.user_data.fbp).toBe("fb.1.1700000000000.1");
    expect(ev.event_source_url).toBe("https://shop.example.com/thanks");
    expect(ev.custom_data).toEqual({ value: 10, currency: "USD" });
  });
  it("omits custom_data when empty", () => {
    const p = validateEvent({ event_name: "PageView" }, NOW);
    if (!p.ok) throw new Error();
    expect(toServerEvent(p.value, {}).custom_data).toBeUndefined();
  });
});

describe("CapiClient request shape", () => {
  it("posts to /{version}/{pixel}/events with token in body", async () => {
    const f = vi.fn(async () => okResponse());
    const { c } = client(f as unknown as typeof fetch);
    await c.send(makeEvents(2));
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v23.0/1234567890/events");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.access_token).toBe("SECRET_TOKEN");
    expect(body.data).toHaveLength(2);
    expect(body.test_event_code).toBeUndefined();
    expect(url).not.toContain("SECRET_TOKEN");
  });
  it("includes test_event_code when configured", async () => {
    const f = vi.fn(async () => okResponse());
    const { c } = client(f as unknown as typeof fetch, { testEventCode: "TEST123" });
    await c.send(makeEvents(1));
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.test_event_code).toBe("TEST123");
  });
  it("uses configurable API version and base url", () => {
    const { c } = client(vi.fn() as unknown as typeof fetch, { apiVersion: "v99.0", baseUrl: "http://localhost:9/" });
    expect(c.endpoint).toBe("http://localhost:9/v99.0/1234567890/events");
  });
  it("returns success details", async () => {
    const { c } = client((async () => okResponse({ events_received: 3 })) as unknown as typeof fetch);
    const [r] = await c.send(makeEvents(3));
    expect(r).toMatchObject({ ok: true, eventsReceived: 3, fbtraceId: "TRACE", attempts: 1 });
  });
  it("sends nothing for an empty list", async () => {
    const f = vi.fn();
    const { c } = client(f as unknown as typeof fetch);
    expect(await c.send([])).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("CapiClient batching", () => {
  it("never exceeds the API limit of 1000", () => {
    expect(API_MAX_BATCH).toBe(1000);
    const { c } = client(vi.fn() as unknown as typeof fetch, { maxBatchSize: 5000 });
    expect(c).toBeDefined();
  });
  it("splits 2500 events into 1000/1000/500", async () => {
    const f = vi.fn(async () => okResponse());
    const { c } = client(f as unknown as typeof fetch, { maxBatchSize: 5000 });
    const results = await c.send(makeEvents(2500));
    const sizes = f.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).data.length);
    expect(sizes).toEqual([1000, 1000, 500]);
    expect(results).toHaveLength(3);
  });
  it("honours a smaller configured batch size", async () => {
    const f = vi.fn(async () => okResponse());
    const { c } = client(f as unknown as typeof fetch, { maxBatchSize: 10 });
    await c.send(makeEvents(25));
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("reports per-chunk failures independently", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValue(errResponse(400, { code: 100 }));
    const { c } = client(f as unknown as typeof fetch, { maxBatchSize: 2 });
    const r = await c.send(makeEvents(4));
    expect(r.map((x) => x.ok)).toEqual([true, false]);
  });
});

describe("CapiClient retries", () => {
  it("retries 500 then succeeds with exponential backoff", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(errResponse(500, { code: 2 }))
      .mockResolvedValueOnce(errResponse(503, { code: 2 }))
      .mockResolvedValueOnce(okResponse());
    const { c, sleep } = client(f as unknown as typeof fetch);
    const [r] = await c.send(makeEvents(1));
    expect(r?.ok).toBe(true);
    expect(r?.attempts).toBe(3);
    expect(sleep.mock.calls.map((x) => (x as unknown as number[])[0])).toEqual([100, 200]);
  });
  it("retries network errors", async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(okResponse());
    const { c } = client(f as unknown as typeof fetch);
    const [r] = await c.send(makeEvents(1));
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });
  it("retries 429 and honours Retry-After", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(errResponse(429, { code: 4 }, { "retry-after": "3" }))
      .mockResolvedValueOnce(okResponse());
    const { c, sleep } = client(f as unknown as typeof fetch);
    await c.send(makeEvents(1));
    expect((sleep.mock.calls[0] as unknown as number[])[0]).toBe(3000);
  });
  it("retries transient Graph error codes even on HTTP 400", async () => {
    const f = vi.fn().mockResolvedValueOnce(errResponse(400, { code: 17 })).mockResolvedValueOnce(okResponse());
    const { c } = client(f as unknown as typeof fetch);
    const [r] = await c.send(makeEvents(1));
    expect(r?.ok).toBe(true);
  });
  it("retries when is_transient is true", async () => {
    const f = vi.fn().mockResolvedValueOnce(errResponse(400, { code: 999, is_transient: true })).mockResolvedValueOnce(okResponse());
    const { c } = client(f as unknown as typeof fetch);
    expect((await c.send(makeEvents(1)))[0]?.ok).toBe(true);
  });
  it("does not retry permanent 4xx errors", async () => {
    const f = vi.fn(async () => errResponse(400, { code: 100, message: "Invalid parameter", fbtrace_id: "T9" }));
    const { c, sleep } = client(f as unknown as typeof fetch);
    const [r] = await c.send(makeEvents(1));
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatchObject({ status: 400, code: 100, fbtrace_id: "T9" });
  });
  it("does not retry auth errors (190)", async () => {
    const f = vi.fn(async () => errResponse(401, { code: 190 }));
    const { c } = client(f as unknown as typeof fetch);
    await c.send(makeEvents(1));
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("gives up after maxRetries", async () => {
    const f = vi.fn(async () => errResponse(500, { code: 2 }));
    const { c, sleep } = client(f as unknown as typeof fetch, { maxRetries: 3 });
    const [r] = await c.send(makeEvents(1));
    expect(f).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ ok: false, attempts: 4 });
  });
  it("maxRetries 0 means a single attempt", async () => {
    const f = vi.fn(async () => errResponse(500));
    const { c } = client(f as unknown as typeof fetch, { maxRetries: 0 });
    await c.send(makeEvents(1));
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("caps backoff at maxDelayMs", () => {
    const { c } = client(vi.fn() as unknown as typeof fetch, { baseDelayMs: 1000, maxDelayMs: 5000 });
    expect(c.backoffMs(10)).toBe(5000);
  });
  it("applies jitter between 50% and 100%", () => {
    const lo = client(vi.fn() as unknown as typeof fetch, { random: () => 0 }).c.backoffMs(1);
    const hi = client(vi.fn() as unknown as typeof fetch, { random: () => 1 }).c.backoffMs(1);
    expect(lo).toBe(100);
    expect(hi).toBe(200);
  });
  it("handles non-JSON error bodies", async () => {
    const f = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    const { c } = client(f as unknown as typeof fetch, { maxRetries: 1 });
    const [r] = await c.send(makeEvents(1));
    expect(r?.ok).toBe(false);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("never logs the access token or raw event contents", async () => {
    const lines: string[] = [];
    const { createLogger } = await import("../src/logger.js");
    const logger = createLogger("debug", (l) => lines.push(l));
    const f = vi.fn(async () => errResponse(400, { message: "bad token SECRET_TOKEN" }));
    const { c } = client(f as unknown as typeof fetch, { logger });
    await c.send(makeEvents(1));
    expect(lines.join("\n")).not.toContain("SECRET_TOKEN");
  });
});
