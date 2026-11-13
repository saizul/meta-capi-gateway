import { describe, expect, it } from "vitest";
import { sha256 } from "../src/hash.js";
import {
  computeShopifySignature,
  isShopDomain,
  shopifyEventId,
  shopifyOrderToPurchase,
  verifyShopifySignature,
} from "../src/shopify.js";
import type { ShopifyOrder } from "../src/shopify.js";

const NOW = Math.floor(Date.parse("2026-03-10T12:00:00Z") / 1000);
const order: ShopifyOrder = {
  id: 5_123_456_789_012,
  name: "#1001",
  currency: "bdt",
  total_price: "2450.00",
  financial_status: "paid",
  cancelled_at: null,
  test: false,
  created_at: "2026-03-10T15:30:00+06:00",
  processed_at: "2026-03-10T15:31:00+06:00",
  email: "Rahim@Example.com",
  phone: null,
  browser_ip: "203.0.113.7",
  client_details: { browser_ip: "198.51.100.1", user_agent: "Mozilla/5.0" },
  customer: { id: 7_001, email: "other@example.com", phone: "+8801999999999", first_name: "Karim", last_name: "Khan" },
  billing_address: {
    first_name: "Rahim",
    last_name: "Uddin",
    phone: "01712345678",
    city: "Dhaka",
    province: "Dhaka Division",
    province_code: null,
    zip: "1212",
    country: "Bangladesh",
    country_code: "BD",
  },
  line_items: [
    { product_id: 93, variant_id: 930, sku: "TSHIRT-BL", quantity: 2, price: "1000.00" },
    { product_id: 94, variant_id: 940, sku: "", quantity: 1, price: "450.00" },
    { product_id: null, variant_id: null, sku: null, quantity: 1, price: "0.00" },
  ],
  note_attributes: [
    { name: "_fbp", value: "fb.1.1700000000000.99" },
    { name: "fbc", value: "fb.1.1700000000000.AbCdEf" },
  ],
};

describe("shopify signature", () => {
  const secret = "shpss_placeholder";
  const body = JSON.stringify(order);
  it("matches a known HMAC-SHA256 base64 vector", () => {
    expect(computeShopifySignature("The quick brown fox jumps over the lazy dog", "key")).toBe(
      "97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=",
    );
  });
  it("verifies a valid signature (string and Buffer)", () => {
    const sig = computeShopifySignature(body, secret);
    expect(verifyShopifySignature(body, sig, secret)).toBe(true);
    expect(verifyShopifySignature(Buffer.from(body), ` ${sig} `, secret)).toBe(true);
  });
  it("rejects tampered bodies, wrong secrets and bad headers", () => {
    const sig = computeShopifySignature(body, secret);
    expect(verifyShopifySignature(body.replace("2450", "1"), sig, secret)).toBe(false);
    expect(verifyShopifySignature(body, computeShopifySignature(body, "other"), secret)).toBe(false);
    expect(verifyShopifySignature(body, undefined, secret)).toBe(false);
    expect(verifyShopifySignature(body, "", secret)).toBe(false);
    expect(verifyShopifySignature(body, "short", secret)).toBe(false);
    expect(verifyShopifySignature(body, sig, "")).toBe(false);
  });
});

describe("isShopDomain", () => {
  it.each(["my-store.myshopify.com", "Shop1.MyShopify.com"])("accepts %s", (d) => expect(isShopDomain(d)).toBe(true));
  it.each(["evil.com", "myshopify.com", "a.myshopify.com.evil.com", "a/b.myshopify.com", undefined])("rejects %s", (d) =>
    expect(isShopDomain(d)).toBe(false),
  );
});

describe("shopifyOrderToPurchase", () => {
  const r = shopifyOrderToPurchase(order, { siteUrl: "https://shop.example.com", nowSec: NOW });
  if (!r.ok) throw new Error("expected ok");
  const ev = r.event;

  it("builds a Purchase with value, currency and order id", () => {
    expect(ev.event_name).toBe("Purchase");
    expect(ev.action_source).toBe("website");
    expect(ev.custom_data).toMatchObject({ value: 2450, currency: "BDT", order_id: "5123456789012", content_type: "product" });
  });
  it("uses a stable event_id derived from the order id", () => {
    expect(ev.event_id).toBe("shopify_order_5123456789012");
    expect(shopifyEventId(42)).toBe("shopify_order_42");
  });
  it("maps line items to contents: sku, then variant_id, then product_id", () => {
    expect(ev.custom_data?.contents).toEqual([
      { id: "TSHIRT-BL", quantity: 2, item_price: 1000 },
      { id: "940", quantity: 1, item_price: 450 },
    ]);
    expect(ev.custom_data?.content_ids).toEqual(["TSHIRT-BL", "940"]);
    expect(ev.custom_data?.num_items).toBe(3);
  });
  it("hashes order email, billing phone and billing names", () => {
    expect(ev.user_data.em).toEqual([sha256("rahim@example.com")]);
    expect(ev.user_data.ph).toEqual([sha256("8801712345678")]);
    expect(ev.user_data.fn).toEqual([sha256("rahim")]);
    expect(ev.user_data.ln).toEqual([sha256("uddin")]);
    expect(ev.user_data.ct).toEqual([sha256("dhaka")]);
    expect(ev.user_data.zp).toEqual([sha256("1212")]);
    expect(ev.user_data.country).toEqual([sha256("bd")]);
    expect(ev.user_data.external_id).toEqual([sha256("7001")]);
  });
  it("falls back to province when province_code is missing", () => {
    expect(ev.user_data.st).toBeDefined();
  });
  it("passes browser_ip, user agent, fbp and fbc unhashed", () => {
    expect(ev.user_data.client_ip_address).toBe("203.0.113.7");
    expect(ev.user_data.client_user_agent).toBe("Mozilla/5.0");
    expect(ev.user_data.fbp).toBe("fb.1.1700000000000.99");
    expect(ev.user_data.fbc).toBe("fb.1.1700000000000.AbCdEf");
  });
  it("uses processed_at (with offset) as event_time", () => {
    expect(ev.event_time).toBe(Math.floor(Date.parse("2026-03-10T09:31:00Z") / 1000));
  });
  it("uses SITE_URL, then the shop domain, for event_source_url", () => {
    expect(ev.event_source_url).toBe("https://shop.example.com/checkout/");
    const a = shopifyOrderToPurchase(order, { shopDomain: "My-Store.myshopify.com", nowSec: NOW });
    expect(a.ok && a.event.event_source_url).toBe("https://my-store.myshopify.com/checkout/");
    const b = shopifyOrderToPurchase(order, { shopDomain: "evil.example", nowSec: NOW });
    expect(b.ok && b.event.event_source_url).toBeUndefined();
  });
  it("falls back to customer and client_details fields", () => {
    const x = shopifyOrderToPurchase(
      { ...order, email: null, browser_ip: null, billing_address: null, shipping_address: null },
      { nowSec: NOW },
    );
    if (!x.ok) throw new Error("expected ok");
    expect(x.event.user_data.em).toEqual([sha256("other@example.com")]);
    expect(x.event.user_data.ph).toEqual([sha256("8801999999999")]);
    expect(x.event.user_data.fn).toEqual([sha256("karim")]);
    expect(x.event.user_data.client_ip_address).toBe("198.51.100.1");
    expect(x.event.user_data.ct).toBeUndefined();
  });
  it("uses the shipping address when there is no billing address", () => {
    const x = shopifyOrderToPurchase(
      { ...order, billing_address: null, shipping_address: { city: "Chattogram", country_code: "BD" } },
      { nowSec: NOW },
    );
    expect(x.ok && x.event.user_data.ct).toEqual([sha256("chattogram")]);
  });
  it("ignores unpaid orders unless the status is accepted", () => {
    const pending = { ...order, financial_status: "pending" };
    expect(shopifyOrderToPurchase(pending, { nowSec: NOW })).toEqual({ ok: false, reason: "not_paid" });
    expect(shopifyOrderToPurchase({ ...order, financial_status: null }, { nowSec: NOW })).toEqual({ ok: false, reason: "not_paid" });
    expect(shopifyOrderToPurchase(pending, { nowSec: NOW, acceptedStatuses: ["paid", "pending"] }).ok).toBe(true);
  });
  it("ignores cancelled orders", () => {
    expect(shopifyOrderToPurchase({ ...order, cancelled_at: "2026-03-10T11:00:00Z" }, { nowSec: NOW })).toEqual({
      ok: false,
      reason: "cancelled",
    });
  });
  it("ignores test orders unless enabled", () => {
    const t = { ...order, test: true };
    expect(shopifyOrderToPurchase(t, { nowSec: NOW })).toEqual({ ok: false, reason: "test_order" });
    expect(shopifyOrderToPurchase(t, { nowSec: NOW, includeTestOrders: true }).ok).toBe(true);
  });
  it("rejects orders missing id, total or currency", () => {
    expect(shopifyOrderToPurchase({ ...order, id: undefined }, { nowSec: NOW }).ok).toBe(false);
    expect(shopifyOrderToPurchase({ ...order, id: "" }, { nowSec: NOW }).ok).toBe(false);
    expect(shopifyOrderToPurchase({ ...order, total_price: undefined }, { nowSec: NOW }).ok).toBe(false);
    expect(shopifyOrderToPurchase({ ...order, total_price: "abc" }, { nowSec: NOW }).ok).toBe(false);
    expect(shopifyOrderToPurchase({ ...order, total_price: "-1" }, { nowSec: NOW }).ok).toBe(false);
    expect(shopifyOrderToPurchase({ ...order, currency: "TAKA" }, { nowSec: NOW })).toEqual({ ok: false, reason: "invalid_order" });
  });
  it("rejects orders older than 7 days", () => {
    expect(shopifyOrderToPurchase({ ...order, processed_at: "2026-02-01T00:00:00Z" }, { nowSec: NOW })).toEqual({
      ok: false,
      reason: "too_old",
    });
  });
  it("clamps future timestamps and falls back to created_at, then now", () => {
    const a = shopifyOrderToPurchase({ ...order, processed_at: "2026-03-11T00:00:00Z" }, { nowSec: NOW });
    expect(a.ok && a.event.event_time).toBe(NOW);
    const b = shopifyOrderToPurchase({ ...order, processed_at: null }, { nowSec: NOW });
    expect(b.ok && b.event.event_time).toBe(Math.floor(Date.parse("2026-03-10T09:30:00Z") / 1000));
    const c = shopifyOrderToPurchase({ ...order, processed_at: null, created_at: "garbage" }, { nowSec: NOW });
    expect(c.ok && c.event.event_time).toBe(NOW);
  });
  it("omits external_id and contents when absent", () => {
    const x = shopifyOrderToPurchase({ ...order, customer: null, line_items: [] }, { nowSec: NOW });
    expect(x.ok && x.event.user_data.external_id).toBeUndefined();
    expect(x.ok && x.event.custom_data?.contents).toBeUndefined();
  });
  it("applies the default phone country code", () => {
    const x = shopifyOrderToPurchase({ ...order, billing_address: { phone: "07911123456" } }, { nowSec: NOW, defaultCountryCode: "44" });
    expect(x.ok && x.event.user_data.ph).toEqual([sha256("447911123456")]);
  });
});
