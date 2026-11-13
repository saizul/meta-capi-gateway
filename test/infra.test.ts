import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { corsHeaders, isOriginAllowed } from "../src/cors.js";
import { createLogger, redact } from "../src/logger.js";
import { RateLimiter } from "../src/ratelimit.js";

describe("RateLimiter", () => {
  it("allows up to max then blocks", () => {
    const rl = new RateLimiter(3, 1000, () => 0);
    expect([1, 2, 3].map(() => rl.check("a").allowed)).toEqual([true, true, true]);
    expect(rl.check("a").allowed).toBe(false);
  });
  it("tracks keys independently", () => {
    const rl = new RateLimiter(1, 1000, () => 0);
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("b").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(false);
  });
  it("resets after the window", () => {
    let t = 0;
    const rl = new RateLimiter(1, 1000, () => t);
    rl.check("a");
    expect(rl.check("a").allowed).toBe(false);
    t = 1000;
    expect(rl.check("a").allowed).toBe(true);
  });
  it("reports remaining and retryAfter", () => {
    let t = 0;
    const rl = new RateLimiter(2, 10_000, () => t);
    expect(rl.check("a").remaining).toBe(1);
    t = 2500;
    rl.check("a");
    const r = rl.check("a");
    expect(r).toMatchObject({ allowed: false, remaining: 0, retryAfterSec: 8 });
  });
  it("bounds memory by pruning", () => {
    const rl = new RateLimiter(5, 1000, () => 0, 10);
    for (let i = 0; i < 100; i++) rl.check(`ip${i}`);
    expect(rl.size).toBeLessThanOrEqual(10);
  });
});

describe("isOriginAllowed", () => {
  const list = ["https://www.example.com", "https://*.shop.test", "http://localhost:3000/"];
  it.each([
    ["https://www.example.com", true],
    ["HTTPS://WWW.EXAMPLE.COM", true],
    ["http://localhost:3000", true],
    ["https://a.shop.test", true],
    ["https://a.b.shop.test", true],
    ["https://shop.test", false],
    ["http://www.example.com", false],
    ["https://evil.com", false],
    ["https://www.example.com.evil.com", false],
    ["https://evilshop.test", false],
    ["https://x@evil.com.shop.test", false],
    ["null", false],
  ])("%s -> %s", (origin, expected) => {
    expect(isOriginAllowed(origin, list)).toBe(expected);
  });
  it("empty list denies everything", () => expect(isOriginAllowed("https://a.com", [])).toBe(false));
  it("wildcard allows everything", () => expect(isOriginAllowed("https://a.com", ["*"])).toBe(true));
  it("corsHeaders echoes the origin and varies on it", () => {
    const h = corsHeaders("https://a.com");
    expect(h["access-control-allow-origin"]).toBe("https://a.com");
    expect(h.vary).toBe("Origin");
    expect(h["access-control-allow-methods"]).toContain("POST");
  });
});

describe("logger redaction", () => {
  it("redacts sensitive keys recursively", () => {
    const out = redact({ user_data: { em: ["abc"] }, nested: { email: "a@b.com", ok: 1 }, ip: "1.2.3.4", count: 2 }) as Record<string, unknown>;
    expect(out.user_data).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).email).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
    expect(out.ip).toBe("[redacted]");
    expect(out.count).toBe(2);
  });
  it("scrubs emails and tokens that appear inside strings", () => {
    const out = redact({ reason: `failed for bob@example.com with EAAB${"x".repeat(30)} and ${"a".repeat(64)}` }) as { reason: string };
    expect(out.reason).not.toContain("bob@example.com");
    expect(out.reason).not.toContain("EAAB");
    expect(out.reason).not.toMatch(/a{64}/);
  });
  it("emits JSON lines honoring the level", () => {
    const lines: string[] = [];
    const log = createLogger("warn", (l) => lines.push(l), () => new Date("2026-01-01T00:00:00Z"));
    log.info("skip");
    log.warn("kept", { phone: "01712345678", n: 1 });
    expect(lines).toHaveLength(1);
    const j = JSON.parse(lines[0]!);
    expect(j).toMatchObject({ ts: "2026-01-01T00:00:00.000Z", level: "warn", msg: "kept", phone: "[redacted]", n: 1 });
    expect(lines[0]).not.toContain("01712345678");
  });
  it("truncates deeply nested data", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 10; i++) deep = { a: deep };
    expect(JSON.stringify(redact(deep))).toContain("[truncated]");
  });
});

describe("loadConfig", () => {
  const base = { PIXEL_ID: "123", ACCESS_TOKEN: "tok" };
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      port: 8080,
      graphApiVersion: "v23.0",
      batchSize: 50,
      maxRetries: 4,
      defaultPhoneCountryCode: "880",
      allowMissingOrigin: false,
      rateLimitMax: 60,
    });
    expect(c.testEventCode).toBeUndefined();
    expect(c.wooSecret).toBeUndefined();
    expect(c.shopifySecret).toBeUndefined();
    expect(c.shopifyFinancialStatuses).toEqual(["paid"]);
    expect(c.shopifyIncludeTestOrders).toBe(false);
  });
  it("parses Shopify settings", () => {
    const c = loadConfig({
      ...base,
      SHOPIFY_WEBHOOK_SECRET: " shpss_placeholder ",
      SHOPIFY_FINANCIAL_STATUSES: " Paid, pending ,paid,",
      SHOPIFY_INCLUDE_TEST_ORDERS: "true",
    });
    expect(c.shopifySecret).toBe("shpss_placeholder");
    expect(c.shopifyFinancialStatuses).toEqual(["paid", "pending"]);
    expect(c.shopifyIncludeTestOrders).toBe(true);
  });
  it("requires numeric PIXEL_ID and ACCESS_TOKEN", () => {
    expect(() => loadConfig({ ACCESS_TOKEN: "t" })).toThrow(ConfigError);
    expect(() => loadConfig({ PIXEL_ID: "abc", ACCESS_TOKEN: "t" })).toThrow(ConfigError);
    expect(() => loadConfig({ PIXEL_ID: "1" })).toThrow(ConfigError);
  });
  it("parses origins, test code, woo secret and site url", () => {
    const c = loadConfig({
      ...base,
      ALLOWED_ORIGINS: " https://a.com , https://*.b.com ,",
      TEST_EVENT_CODE: "TEST1",
      WOOCOMMERCE_WEBHOOK_SECRET: "s",
      SITE_URL: "https://shop.com/",
    });
    expect(c.allowedOrigins).toEqual(["https://a.com", "https://*.b.com"]);
    expect(c.testEventCode).toBe("TEST1");
    expect(c.wooSecret).toBe("s");
    expect(c.siteUrl).toBe("https://shop.com");
  });
  it.each([
    ["GRAPH_API_VERSION", "23"],
    ["PORT", "70000"],
    ["BATCH_SIZE", "1001"],
    ["BATCH_SIZE", "0"],
    ["MAX_RETRIES", "x"],
    ["LOG_LEVEL", "loud"],
    ["DEFAULT_PHONE_COUNTRY_CODE", "+880"],
    ["ALLOW_MISSING_ORIGIN", "maybe"],
    ["SHOPIFY_FINANCIAL_STATUSES", "paid,shipped"],
    ["SHOPIFY_INCLUDE_TEST_ORDERS", "sometimes"],
  ])("rejects %s=%s", (k, v) => {
    expect(() => loadConfig({ ...base, [k]: v })).toThrow(ConfigError);
  });
  it("accepts boolean spellings and overrides", () => {
    const c = loadConfig({ ...base, ALLOW_MISSING_ORIGIN: "yes", BATCH_SIZE: "1000", GRAPH_API_VERSION: "v24.0" });
    expect(c.allowMissingOrigin).toBe(true);
    expect(c.batchSize).toBe(1000);
    expect(c.graphApiVersion).toBe("v24.0");
  });
});
