import { describe, expect, it } from "vitest";
import { extractEvents, validateEvent } from "../src/schema.js";

const NOW = 1_800_000_000;
const v = (raw: unknown) => validateEvent(raw, NOW);

describe("validateEvent names", () => {
  it.each(["PageView", "ViewContent", "AddToCart", "InitiateCheckout", "Lead", "CompleteRegistration"])(
    "accepts standard %s",
    (event_name) => {
      expect(v({ event_name }).ok).toBe(true);
    },
  );
  it.each(["QuizFinished", "Video_Played", "cta click", "a-b"])("accepts custom %j", (event_name) => {
    expect(v({ event_name }).ok).toBe(true);
  });
  it.each(["", "1abc", "bad<script>", "x".repeat(51), "a/b"])("rejects name %j", (event_name) => {
    expect(v({ event_name }).ok).toBe(false);
  });
  it("requires event_name", () => {
    const r = v({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("event_name is required");
  });
  it("rejects non-object", () => {
    expect(v("x").ok).toBe(false);
    expect(v(null).ok).toBe(false);
    expect(v([]).ok).toBe(false);
  });
});

describe("validateEvent ids, time and url", () => {
  it("generates an event_id when missing", () => {
    const a = v({ event_name: "Lead" });
    const b = v({ event_name: "Lead" });
    expect(a.ok && b.ok && a.value.event_id !== b.value.event_id).toBe(true);
  });
  it("keeps a provided event_id for dedup", () => {
    const r = v({ event_name: "Lead", event_id: "abc-123" });
    expect(r.ok && r.value.event_id).toBe("abc-123");
  });
  it("rejects too-long event_id", () => {
    expect(v({ event_name: "Lead", event_id: "x".repeat(129) }).ok).toBe(false);
  });
  it("defaults event_time to now", () => {
    const r = v({ event_name: "Lead" });
    expect(r.ok && r.value.event_time).toBe(NOW);
  });
  it("accepts recent event_time", () => {
    const r = v({ event_name: "Lead", event_time: NOW - 3600 });
    expect(r.ok && r.value.event_time).toBe(NOW - 3600);
  });
  it("converts millisecond timestamps", () => {
    const r = v({ event_name: "Lead", event_time: (NOW - 10) * 1000 });
    expect(r.ok && r.value.event_time).toBe(NOW - 10);
  });
  it("rejects events older than 7 days", () => {
    expect(v({ event_name: "Lead", event_time: NOW - 8 * 86400 }).ok).toBe(false);
  });
  it("rejects future events", () => {
    expect(v({ event_name: "Lead", event_time: NOW + 3600 }).ok).toBe(false);
  });
  it("rejects non-numeric event_time", () => {
    expect(v({ event_name: "Lead", event_time: "yesterday" }).ok).toBe(false);
  });
  it("normalizes event_source_url", () => {
    const r = v({ event_name: "Lead", event_source_url: "https://example.com/a?b=1" });
    expect(r.ok && r.value.event_source_url).toBe("https://example.com/a?b=1");
  });
  it.each(["javascript:alert(1)", "not a url", "ftp://x.com/a"])("rejects url %j", (event_source_url) => {
    expect(v({ event_name: "Lead", event_source_url }).ok).toBe(false);
  });
});

describe("validateEvent user", () => {
  it("keeps valid fbp/fbc and drops malformed ones", () => {
    const good = v({ event_name: "Lead", user: { fbp: "fb.1.1700000000000.12345", fbc: "fb.1.1700000000000.AbC_d-1" } });
    expect(good.ok && good.value.user.fbp).toBe("fb.1.1700000000000.12345");
    expect(good.ok && good.value.user.fbc).toBe("fb.1.1700000000000.AbC_d-1");
    const bad = v({ event_name: "Lead", user: { fbp: "garbage", fbc: "garbage" } });
    expect(bad.ok && bad.value.user.fbp).toBeUndefined();
    expect(bad.ok && bad.value.user.fbc).toBeUndefined();
  });
  it("rejects non-string user fields", () => {
    expect(v({ event_name: "Lead", user: { email: 5 } }).ok).toBe(false);
  });
  it("rejects non-object user", () => {
    expect(v({ event_name: "Lead", user: "x" }).ok).toBe(false);
  });
  it("ignores blank user fields", () => {
    const r = v({ event_name: "Lead", user: { email: "  " } });
    expect(r.ok && r.value.user.email).toBeUndefined();
  });
});

describe("validateEvent custom_data", () => {
  it("requires value and currency for Purchase", () => {
    const r = v({ event_name: "Purchase" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBe(2);
  });
  it("accepts a full Purchase and upper-cases currency", () => {
    const r = v({
      event_name: "Purchase",
      custom_data: {
        value: "1250.50",
        currency: "bdt",
        content_ids: ["sku-1", 22],
        contents: [{ id: "sku-1", quantity: 2, item_price: 625.25 }],
        num_items: 2,
        order_id: "A1",
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.custom_data.value).toBe(1250.5);
      expect(r.value.custom_data.currency).toBe("BDT");
      expect(r.value.custom_data.content_ids).toEqual(["sku-1", "22"]);
    }
  });
  it.each([[-1], ["abc"], [Infinity], [{}]])("rejects value %j", (value) => {
    expect(v({ event_name: "Lead", custom_data: { value } }).ok).toBe(false);
  });
  it.each(["US", "USDX", "12$"])("rejects currency %j", (currency) => {
    expect(v({ event_name: "Lead", custom_data: { currency } }).ok).toBe(false);
  });
  it("rejects bad contents", () => {
    expect(v({ event_name: "Lead", custom_data: { contents: "x" } }).ok).toBe(false);
    expect(v({ event_name: "Lead", custom_data: { contents: [{ quantity: 1 }] } }).ok).toBe(false);
    expect(v({ event_name: "Lead", custom_data: { contents: [5] } }).ok).toBe(false);
  });
  it("defaults content quantity to 1", () => {
    const r = v({ event_name: "Lead", custom_data: { contents: [{ id: "a" }] } });
    expect(r.ok && r.value.custom_data.contents).toEqual([{ id: "a", quantity: 1 }]);
  });
  it("rejects more than 100 content_ids", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id${i}`);
    expect(v({ event_name: "Lead", custom_data: { content_ids: ids } }).ok).toBe(false);
  });
});

describe("consent flag", () => {
  it("defaults to true", () => {
    const r = v({ event_name: "Lead" });
    expect(r.ok && r.value.consent).toBe(true);
  });
  it("keeps false", () => {
    const r = v({ event_name: "Lead", consent: false });
    expect(r.ok && r.value.consent).toBe(false);
  });
  it("rejects non-boolean", () => {
    expect(v({ event_name: "Lead", consent: "no" }).ok).toBe(false);
  });
});

describe("extractEvents", () => {
  it("wraps a single event", () => {
    const r = extractEvents({ event_name: "Lead" });
    expect(r.ok && r.value.length).toBe(1);
  });
  it("accepts { events }", () => {
    const r = extractEvents({ events: [{}, {}] });
    expect(r.ok && r.value.length).toBe(2);
  });
  it("rejects empty and oversized lists", () => {
    expect(extractEvents({ events: [] }).ok).toBe(false);
    expect(extractEvents({ events: Array.from({ length: 21 }, () => ({})) }).ok).toBe(false);
  });
  it("rejects non-objects", () => {
    expect(extractEvents([1]).ok).toBe(false);
    expect(extractEvents("x").ok).toBe(false);
  });
});
