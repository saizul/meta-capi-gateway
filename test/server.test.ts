import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { RateLimiter } from "../src/ratelimit.js";
import { clientIp, createHandler } from "../src/server.js";
import { sha256 } from "../src/hash.js";
import type { ServerEvent } from "../src/types.js";
import { computeShopifySignature } from "../src/shopify.js";
import { computeWooSignature } from "../src/woocommerce.js";

const ORIGIN = "https://shop.example.com";
const NOW_MS = Date.parse("2026-03-10T12:00:00Z");

let server: Server;
let base: string;
let captured: ServerEvent[];
let accepting: boolean;
let cfg: Config;

async function start(env: Record<string, string> = {}, limit = 100) {
  cfg = loadConfig({
    PIXEL_ID: "123",
    ACCESS_TOKEN: "tok",
    ALLOWED_ORIGINS: `${ORIGIN},https://*.partner.test`,
    WOOCOMMERCE_WEBHOOK_SECRET: "whsec",
    SHOPIFY_WEBHOOK_SECRET: "shpsec",
    SITE_URL: "https://shop.example.com",
    ...env,
  });
  const queue = {
    add: (e: ServerEvent[]) => {
      if (!accepting) return false;
      captured.push(...e);
      return true;
    },
    size: () => captured.length,
  };
  server = createServer(
    createHandler({ config: cfg, queue, logger: silentLogger, rateLimiter: new RateLimiter(limit, 60_000), now: () => NOW_MS }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  captured = [];
  accepting = true;
  await start();
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const post = (body: unknown, headers: Record<string, string> = {}, path = "/events") =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("health and snippet", () => {
  it("GET /health", async () => {
    const r = await fetch(base + "/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "ok", queue_size: 0 });
  });
  it("serves the snippet as javascript", async () => {
    const r = await fetch(base + "/snippet.js");
    expect(r.headers.get("content-type")).toContain("javascript");
    expect(await r.text()).toContain("window.capi");
  });
  it("404 for unknown paths", async () => {
    expect((await fetch(base + "/nope")).status).toBe(404);
  });
});

describe("POST /events", () => {
  it("accepts a valid event and queues a server event", async () => {
    const r = await post({
      event_name: "Lead",
      event_id: "abc",
      user: { email: "A@b.com", phone: "01712345678" },
      event_source_url: "https://shop.example.com/x",
    }, { "user-agent": "TestUA/1" });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ accepted: 1, dropped: 0, event_ids: ["abc"] });
    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    expect(ev.action_source).toBe("website");
    expect(ev.user_data.em).toEqual([sha256("a@b.com")]);
    expect(ev.user_data.ph).toEqual([sha256("8801712345678")]);
    expect(ev.user_data.client_user_agent).toBe("TestUA/1");
    expect(ev.user_data.client_ip_address).toBe("127.0.0.1");
    expect(ev.event_time).toBe(Math.floor(NOW_MS / 1000));
  });
  it("accepts text/plain bodies (sendBeacon / no-preflight)", async () => {
    const r = await post({ event_name: "PageView" }, { "content-type": "text/plain;charset=UTF-8" });
    expect(r.status).toBe(202);
  });
  it("accepts batches via { events }", async () => {
    const r = await post({ events: [{ event_name: "PageView" }, { event_name: "Lead" }] });
    expect(((await r.json()) as { accepted: number }).accepted).toBe(2);
    expect(captured).toHaveLength(2);
  });
  it("generates event ids when absent", async () => {
    const r = await post({ event_name: "PageView" });
    const j = (await r.json()) as { error: string; event_ids: string[]; details: { index: number }[] };
    expect(j.event_ids[0]).toMatch(/[0-9a-f-]{36}/);
  });
  it("rejects invalid events with details and queues nothing", async () => {
    const r = await post({ events: [{ event_name: "Lead" }, { event_name: "Purchase" }] });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: string; event_ids: string[]; details: { index: number }[] };
    expect(j.error).toBe("validation_failed");
    expect(j.details[0]?.index).toBe(1);
    expect(captured).toHaveLength(0);
  });
  it("400 on malformed JSON", async () => {
    expect((await post("{nope")).status).toBe(400);
  });
  it("415 on wrong content type", async () => {
    expect((await post({ event_name: "Lead" }, { "content-type": "application/xml" })).status).toBe(415);
  });
  it("413 on oversized bodies", async () => {
    const r = await post({ event_name: "Lead", custom_data: { content_name: "x".repeat(70_000) } });
    expect(r.status).toBe(413);
  });
  it("drops events when consent is false", async () => {
    const r = await post({ event_name: "Lead", consent: false });
    expect(await r.json()).toMatchObject({ accepted: 0, dropped: 1 });
    expect(captured).toHaveLength(0);
  });
  it("503 when the queue is full", async () => {
    accepting = false;
    const r = await post({ event_name: "Lead" });
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
  });
  it("405 for GET", async () => {
    const r = await fetch(base + "/events", { headers: { origin: ORIGIN } });
    expect(r.status).toBe(405);
  });
});

describe("CORS", () => {
  it("echoes allowed origins", async () => {
    const r = await post({ event_name: "Lead" });
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(r.headers.get("vary")).toBe("Origin");
  });
  it("allows wildcard subdomains", async () => {
    const r = await post({ event_name: "Lead" }, { origin: "https://a.partner.test" });
    expect(r.status).toBe(202);
  });
  it("rejects other origins with 403 and no CORS header", async () => {
    const r = await post({ event_name: "Lead" }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(captured).toHaveLength(0);
  });
  it("answers preflight for allowed origins", async () => {
    const r = await fetch(base + "/events", { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-methods")).toContain("POST");
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
  it("rejects preflight for disallowed origins", async () => {
    const r = await fetch(base + "/events", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });
  it("requires an Origin header by default", async () => {
    const r = await fetch(base + "/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event_name: "Lead" }) });
    expect(r.status).toBe(403);
  });
  it("allows missing Origin when ALLOW_MISSING_ORIGIN is set", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await start({ ALLOW_MISSING_ORIGIN: "true" });
    const r = await fetch(base + "/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event_name: "Lead" }) });
    expect(r.status).toBe(202);
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After after the limit", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await start({}, 2);
    expect((await post({ event_name: "Lead" })).status).toBe(202);
    expect((await post({ event_name: "Lead" })).status).toBe(202);
    const r = await post({ event_name: "Lead" });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(captured).toHaveLength(2);
  });
  it("uses X-Forwarded-For when proxy hops are configured", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await start({ TRUST_PROXY_HOPS: "1" }, 1);
    expect((await post({ event_name: "Lead" }, { "x-forwarded-for": "198.51.100.1" })).status).toBe(202);
    expect((await post({ event_name: "Lead" }, { "x-forwarded-for": "198.51.100.2" })).status).toBe(202);
    expect((await post({ event_name: "Lead" }, { "x-forwarded-for": "198.51.100.1" })).status).toBe(429);
    expect(captured[0]?.user_data.client_ip_address).toBe("198.51.100.1");
  });
  it("ignores spoofed leftmost XFF entries", () => {
    const req = { headers: { "x-forwarded-for": "1.1.1.1, 198.51.100.9" }, socket: { remoteAddress: "10.0.0.1" } } as unknown as IncomingMessage;
    expect(clientIp(req, 1)).toBe("198.51.100.9");
    expect(clientIp(req, 2)).toBe("1.1.1.1");
    expect(clientIp(req, 0)).toBe("10.0.0.1");
    expect(clientIp({ headers: {}, socket: { remoteAddress: "10.0.0.1" } } as unknown as IncomingMessage, 1)).toBe("10.0.0.1");
  });
});

describe("POST /webhooks/woocommerce", () => {
  const order = {
    id: 900,
    status: "completed",
    currency: "BDT",
    total: "1500.00",
    date_paid_gmt: "2026-03-10T11:00:00",
    billing: { email: "buyer@example.com", phone: "01812345678" },
    line_items: [{ product_id: 5, quantity: 1, price: 1500 }],
  };
  const hook = (body: string, sig?: string, headers: Record<string, string> = {}) =>
    fetch(base + "/webhooks/woocommerce", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wc-webhook-topic": "order.completed",
        ...(sig === undefined ? {} : { "x-wc-webhook-signature": sig }),
        ...headers,
      },
      body,
    });

  it("accepts a correctly signed order and queues a Purchase", async () => {
    const body = JSON.stringify(order);
    const r = await hook(body, computeWooSignature(body, "whsec"));
    expect(r.status).toBe(202);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ event_name: "Purchase", event_id: "wc_order_900" });
    expect(captured[0]?.custom_data).toMatchObject({ value: 1500, currency: "BDT" });
  });
  it("401 on a bad signature", async () => {
    const body = JSON.stringify(order);
    expect((await hook(body, computeWooSignature(body, "wrong"))).status).toBe(401);
    expect(captured).toHaveLength(0);
  });
  it("401 when the signature header is missing", async () => {
    expect((await hook(JSON.stringify(order))).status).toBe(401);
  });
  it("200 ignored for non-completed orders", async () => {
    const body = JSON.stringify({ ...order, status: "pending" });
    const r = await hook(body, computeWooSignature(body, "whsec"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ignored: "not_completed" });
    expect(captured).toHaveLength(0);
  });
  it("de-duplicates repeated deliveries of the same order", async () => {
    const body = JSON.stringify(order);
    const sig = computeWooSignature(body, "whsec");
    await hook(body, sig);
    const r = await hook(body, sig);
    expect(await r.json()).toMatchObject({ ignored: "duplicate" });
    expect(captured).toHaveLength(1);
  });
  it("acknowledges the form-encoded ping when signed", async () => {
    const body = "webhook_id=7";
    const r = await hook(body, computeWooSignature(body, "whsec"), { "content-type": "application/x-www-form-urlencoded" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ignored: "ping" });
  });
  it("400 for an order missing required fields", async () => {
    const body = JSON.stringify({ status: "completed" });
    expect((await hook(body, computeWooSignature(body, "whsec"))).status).toBe(400);
  });
  it("503 and not marked seen when the queue is full", async () => {
    accepting = false;
    const body = JSON.stringify(order);
    const sig = computeWooSignature(body, "whsec");
    expect((await hook(body, sig)).status).toBe(503);
    accepting = true;
    expect((await hook(body, sig)).status).toBe(202);
  });
  it("is disabled (404) without a webhook secret", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await start({ WOOCOMMERCE_WEBHOOK_SECRET: "" });
    expect((await hook("{}", "x")).status).toBe(404);
  });
  it("405 for GET", async () => {
    expect((await fetch(base + "/webhooks/woocommerce")).status).toBe(405);
  });
});

describe("POST /webhooks/shopify", () => {
  const order = {
    id: 820982911946154500,
    currency: "BDT",
    total_price: "1500.00",
    financial_status: "paid",
    processed_at: "2026-03-10T11:00:00Z",
    email: "buyer@example.com",
    billing_address: { phone: "01812345678", country_code: "BD" },
    line_items: [{ product_id: 5, variant_id: 50, quantity: 1, price: "1500.00" }],
  };
  const hook = (body: string, sig?: string, headers: Record<string, string> = {}) =>
    fetch(base + "/webhooks/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "orders/paid",
        "x-shopify-shop-domain": "demo-store.myshopify.com",
        ...(sig === undefined ? {} : { "x-shopify-hmac-sha256": sig }),
        ...headers,
      },
      body,
    });
  const signed = (o: unknown, headers: Record<string, string> = {}) => {
    const body = JSON.stringify(o);
    return hook(body, computeShopifySignature(body, "shpsec"), headers);
  };

  it("accepts a correctly signed paid order and queues a Purchase", async () => {
    const r = await signed(order);
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ accepted: 1, event_id: "shopify_order_820982911946154500" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ event_name: "Purchase", event_source_url: "https://shop.example.com/checkout/" });
    expect(captured[0]?.custom_data).toMatchObject({ value: 1500, currency: "BDT", content_ids: ["50"] });
    expect(captured[0]?.user_data.em).toEqual([sha256("buyer@example.com")]);
  });
  it("401 on a bad or missing signature", async () => {
    const body = JSON.stringify(order);
    expect((await hook(body, computeShopifySignature(body, "wrong"))).status).toBe(401);
    expect((await hook(body)).status).toBe(401);
    expect((await hook(body, computeWooSignature(body, "whsec"))).status).toBe(401);
    expect(captured).toHaveLength(0);
  });
  it("acknowledges non-order topics without queuing", async () => {
    const r = await signed({ id: 1 }, { "x-shopify-topic": "products/update" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ignored: "topic" });
    expect(captured).toHaveLength(0);
  });
  it("200 ignored for unpaid, cancelled and test orders", async () => {
    for (const [o, reason] of [
      [{ ...order, financial_status: "pending" }, "not_paid"],
      [{ ...order, cancelled_at: "2026-03-10T11:30:00Z" }, "cancelled"],
      [{ ...order, test: true }, "test_order"],
    ] as const) {
      const r = await signed(o, { "x-shopify-topic": "orders/create" });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ignored: reason });
    }
    expect(captured).toHaveLength(0);
  });
  it("forwards each order once across orders/create, orders/paid and retries", async () => {
    expect((await signed(order, { "x-shopify-topic": "orders/create" })).status).toBe(202);
    const r = await signed(order, { "x-shopify-topic": "orders/paid" });
    expect(await r.json()).toMatchObject({ ignored: "duplicate" });
    expect(captured).toHaveLength(1);
  });
  it("does not collide with a WooCommerce order using the same id", async () => {
    const woo = { id: 77, status: "completed", currency: "BDT", total: "10", date_paid_gmt: "2026-03-10T11:00:00" };
    const wooBody = JSON.stringify(woo);
    await fetch(base + "/webhooks/woocommerce", {
      method: "POST",
      headers: { "content-type": "application/json", "x-wc-webhook-signature": computeWooSignature(wooBody, "whsec") },
      body: wooBody,
    });
    expect((await signed({ ...order, id: 77 })).status).toBe(202);
    expect(captured.map((e) => e.event_id)).toEqual(["wc_order_77", "shopify_order_77"]);
  });
  it("honours SHOPIFY_FINANCIAL_STATUSES for cash-on-delivery stores", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await start({ SHOPIFY_FINANCIAL_STATUSES: "paid,pending", SITE_URL: "" });
    const r = await signed({ ...order, financial_status: "pending" }, { "x-shopify-topic": "orders/create" });
    expect(r.status).toBe(202);
    expect(captured[0]?.event_source_url).toBe("https://demo-store.myshopify.com/checkout/");
  });
  it("400 for invalid JSON or an order missing required fields", async () => {
    const bad = "not json";
    expect((await hook(bad, computeShopifySignature(bad, "shpsec"))).status).toBe(400);
    expect((await signed([order])).status).toBe(400);
    expect((await signed({ financial_status: "paid" })).status).toBe(400);
  });
  it("503 and not marked seen when the queue is full", async () => {
    accepting = false;
    expect((await signed(order)).status).toBe(503);
    accepting = true;
    expect((await signed(order)).status).toBe(202);
  });
  it("is disabled (404) without a webhook secret", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await start({ SHOPIFY_WEBHOOK_SECRET: "" });
    expect((await hook("{}", "x")).status).toBe(404);
  });
  it("405 for GET", async () => {
    expect((await fetch(base + "/webhooks/shopify")).status).toBe(405);
  });
});
