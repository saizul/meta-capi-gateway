import { describe, expect, it } from "vitest";
import { sha256 } from "../src/hash.js";
import { SeenOrders, computeWooSignature, orderToPurchase, verifyWooSignature } from "../src/woocommerce.js";
import type { WooOrder } from "../src/woocommerce.js";

const NOW = Math.floor(Date.parse("2026-03-10T12:00:00Z") / 1000);
const order: WooOrder = {
  id: 727,
  status: "completed",
  currency: "bdt",
  total: "2450.00",
  date_paid_gmt: "2026-03-10T10:00:00",
  customer_id: 12,
  customer_ip_address: "203.0.113.7",
  customer_user_agent: "Mozilla/5.0",
  billing: {
    first_name: "Rahim",
    last_name: "Uddin",
    email: "Rahim@Example.com",
    phone: "01712345678",
    city: "Dhaka",
    state: "Dhaka",
    postcode: "1212",
    country: "BD",
  },
  line_items: [
    { product_id: 93, sku: "TSHIRT-BL", quantity: 2, price: 1000 },
    { product_id: 94, quantity: 1, price: "450" },
  ],
  meta_data: [{ key: "_fbp", value: "fb.1.1700000000000.99" }],
};

describe("signature", () => {
  const secret = "s3cret";
  const body = JSON.stringify(order);
  it("matches a known HMAC-SHA256 base64 vector", () => {
    // HMAC_SHA256(key="key", "The quick brown fox jumps over the lazy dog") base64
    expect(computeWooSignature("The quick brown fox jumps over the lazy dog", "key")).toBe(
      "97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=",
    );
  });
  it("verifies a valid signature (string and Buffer)", () => {
    const sig = computeWooSignature(body, secret);
    expect(verifyWooSignature(body, sig, secret)).toBe(true);
    expect(verifyWooSignature(Buffer.from(body), sig, secret)).toBe(true);
  });
  it("rejects a tampered body", () => {
    const sig = computeWooSignature(body, secret);
    expect(verifyWooSignature(body.replace("2450", "1"), sig, secret)).toBe(false);
  });
  it("rejects the wrong secret", () => {
    expect(verifyWooSignature(body, computeWooSignature(body, "other"), secret)).toBe(false);
  });
  it("rejects missing, empty and malformed headers", () => {
    expect(verifyWooSignature(body, undefined, secret)).toBe(false);
    expect(verifyWooSignature(body, "", secret)).toBe(false);
    expect(verifyWooSignature(body, "short", secret)).toBe(false);
    expect(verifyWooSignature(body, computeWooSignature(body, secret), "")).toBe(false);
  });
  it("tolerates surrounding whitespace in the header", () => {
    expect(verifyWooSignature(body, ` ${computeWooSignature(body, secret)} `, secret)).toBe(true);
  });
});

describe("orderToPurchase", () => {
  const r = orderToPurchase(order, { siteUrl: "https://shop.example.com", nowSec: NOW });
  if (!r.ok) throw new Error("expected ok");
  const ev = r.event;

  it("builds a Purchase with value, currency and order id", () => {
    expect(ev.event_name).toBe("Purchase");
    expect(ev.custom_data).toMatchObject({ value: 2450, currency: "BDT", order_id: "727", content_type: "product" });
  });
  it("uses a stable event_id derived from the order id", () => expect(ev.event_id).toBe("wc_order_727"));
  it("maps line items to contents, falling back to product_id", () => {
    expect(ev.custom_data?.contents).toEqual([
      { id: "TSHIRT-BL", quantity: 2, item_price: 1000 },
      { id: "94", quantity: 1, item_price: 450 },
    ]);
    expect(ev.custom_data?.content_ids).toEqual(["TSHIRT-BL", "94"]);
    expect(ev.custom_data?.num_items).toBe(3);
  });
  it("hashes billing data and normalizes the BD phone", () => {
    expect(ev.user_data.em).toEqual([sha256("rahim@example.com")]);
    expect(ev.user_data.ph).toEqual([sha256("8801712345678")]);
    expect(ev.user_data.fn).toEqual([sha256("rahim")]);
    expect(ev.user_data.external_id).toEqual([sha256("12")]);
  });
  it("passes ip, UA and fbp unhashed", () => {
    expect(ev.user_data.client_ip_address).toBe("203.0.113.7");
    expect(ev.user_data.client_user_agent).toBe("Mozilla/5.0");
    expect(ev.user_data.fbp).toBe("fb.1.1700000000000.99");
  });
  it("uses the GMT paid date as event_time", () => {
    expect(ev.event_time).toBe(Math.floor(Date.parse("2026-03-10T10:00:00Z") / 1000));
  });
  it("sets website source and site url", () => {
    expect(ev.action_source).toBe("website");
    expect(ev.event_source_url).toBe("https://shop.example.com/checkout/");
  });
  it("ignores non-completed orders", () => {
    expect(orderToPurchase({ ...order, status: "processing" }, { nowSec: NOW })).toEqual({ ok: false, reason: "not_completed" });
  });
  it("accepts configured statuses", () => {
    expect(orderToPurchase({ ...order, status: "processing" }, { nowSec: NOW, acceptedStatuses: ["processing"] }).ok).toBe(true);
  });
  it("rejects orders missing id, total or currency", () => {
    expect(orderToPurchase({ ...order, id: undefined }, { nowSec: NOW }).ok).toBe(false);
    expect(orderToPurchase({ ...order, total: undefined }, { nowSec: NOW }).ok).toBe(false);
    expect(orderToPurchase({ ...order, currency: "TAKA" }, { nowSec: NOW }).ok).toBe(false);
    expect(orderToPurchase({ ...order, total: "abc" }, { nowSec: NOW }).ok).toBe(false);
  });
  it("rejects orders older than 7 days", () => {
    expect(orderToPurchase({ ...order, date_paid_gmt: "2026-02-01T00:00:00" }, { nowSec: NOW })).toEqual({ ok: false, reason: "too_old" });
  });
  it("clamps future timestamps to now", () => {
    const x = orderToPurchase({ ...order, date_paid_gmt: "2026-03-11T00:00:00" }, { nowSec: NOW });
    expect(x.ok && x.event.event_time).toBe(NOW);
  });
  it("falls back to completed then created date, then now", () => {
    const a = orderToPurchase({ ...order, date_paid_gmt: null, date_completed_gmt: "2026-03-10T11:00:00" }, { nowSec: NOW });
    expect(a.ok && a.event.event_time).toBe(Math.floor(Date.parse("2026-03-10T11:00:00Z") / 1000));
    const b = orderToPurchase({ ...order, date_paid_gmt: null }, { nowSec: NOW });
    expect(b.ok && b.event.event_time).toBe(NOW);
  });
  it("skips guest customer_id 0 and omits empty contents", () => {
    const x = orderToPurchase({ ...order, customer_id: 0, line_items: [] }, { nowSec: NOW });
    expect(x.ok && x.event.user_data.external_id).toBeUndefined();
    expect(x.ok && x.event.custom_data?.contents).toBeUndefined();
  });
  it("applies default phone country code", () => {
    const x = orderToPurchase({ ...order, billing: { phone: "07911123456" } }, { nowSec: NOW, defaultCountryCode: "44" });
    expect(x.ok && x.event.user_data.ph).toEqual([sha256("447911123456")]);
  });
});

describe("SeenOrders", () => {
  it("remembers and evicts oldest", () => {
    const s = new SeenOrders(2);
    s.add("1");
    s.add("2");
    s.add("3");
    expect(s.has("1")).toBe(false);
    expect(s.has("3")).toBe(true);
    s.delete("3");
    expect(s.has("3")).toBe(false);
  });
});
