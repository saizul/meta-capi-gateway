import { createHmac, timingSafeEqual } from "node:crypto";
import { MAX_EVENT_AGE_SECONDS } from "./schema.js";
import { buildUserData } from "./normalize.js";
import type { ContentItem, ServerEvent, UserDataInput } from "./types.js";

/** Order topics that can carry a purchase; any other topic is acknowledged and ignored. */
export const SHOPIFY_ORDER_TOPICS = ["orders/create", "orders/paid", "orders/updated"];

/** Shopify signs the raw body: base64(HMAC-SHA256(secret, body)) in X-Shopify-Hmac-Sha256. */
export function computeShopifySignature(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

export function verifyShopifySignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header || !secret) return false;
  const expected = Buffer.from(computeShopifySignature(rawBody, secret));
  const given = Buffer.from(header.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A shop domain as sent in X-Shopify-Shop-Domain, e.g. "my-store.myshopify.com". */
export function isShopDomain(v: string | undefined): v is string {
  return typeof v === "string" && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(v);
}

type Id = number | string;

interface ShopifyAddress {
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  city?: string | null;
  province?: string | null;
  province_code?: string | null;
  zip?: string | null;
  country?: string | null;
  country_code?: string | null;
}

interface ShopifyLineItem {
  product_id?: Id | null;
  variant_id?: Id | null;
  sku?: string | null;
  quantity?: number;
  price?: string | number;
}

export interface ShopifyOrder {
  id?: Id;
  name?: string;
  currency?: string;
  total_price?: string | number;
  financial_status?: string | null;
  cancelled_at?: string | null;
  test?: boolean;
  created_at?: string | null;
  processed_at?: string | null;
  email?: string | null;
  contact_email?: string | null;
  phone?: string | null;
  browser_ip?: string | null;
  client_details?: { browser_ip?: string | null; user_agent?: string | null } | null;
  customer?: ({ id?: Id | null; email?: string | null; phone?: string | null } & ShopifyAddress) | null;
  billing_address?: ShopifyAddress | null;
  shipping_address?: ShopifyAddress | null;
  line_items?: ShopifyLineItem[];
  note_attributes?: { name?: string; value?: unknown }[];
}

export type ShopifyResult =
  | { ok: true; event: ServerEvent }
  | { ok: false; reason: "not_paid" | "cancelled" | "test_order" | "invalid_order" | "too_old" };

export interface ShopifyOptions {
  siteUrl?: string;
  shopDomain?: string;
  defaultCountryCode?: string;
  /** financial_status values that count as a purchase. Default ["paid"]. */
  acceptedStatuses?: string[];
  /** Forward orders flagged `test: true` (Shopify's bogus gateway). Default false. */
  includeTestOrders?: boolean;
  nowSec?: number;
}

function iso(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

function str(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v.trim() ? v : undefined;
}

function attribute(order: ShopifyOrder, ...names: string[]): string | undefined {
  for (const n of names) {
    const a = order.note_attributes?.find((x) => x.name === n);
    const v = str(a?.value);
    if (v) return v;
  }
  return undefined;
}

export function shopifyEventId(orderId: Id): string {
  return `shopify_order_${orderId}`;
}

export function shopifyOrderToPurchase(order: ShopifyOrder, opts: ShopifyOptions = {}): ShopifyResult {
  const accepted = (opts.acceptedStatuses ?? ["paid"]).map((s) => s.toLowerCase());
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const id = str(order.id);
  if (!id || order.currency === undefined || order.total_price === undefined) {
    return { ok: false, reason: "invalid_order" };
  }
  const value = Number(order.total_price);
  if (!Number.isFinite(value) || value < 0 || typeof order.currency !== "string" || !/^[A-Za-z]{3}$/.test(order.currency)) {
    return { ok: false, reason: "invalid_order" };
  }
  if (order.cancelled_at) return { ok: false, reason: "cancelled" };
  if (order.test === true && !opts.includeTestOrders) return { ok: false, reason: "test_order" };
  if (!order.financial_status || !accepted.includes(order.financial_status.toLowerCase())) {
    return { ok: false, reason: "not_paid" };
  }

  const time = iso(order.processed_at) ?? iso(order.created_at) ?? now;
  const eventTime = Math.min(time, now);
  if (eventTime < now - MAX_EVENT_AGE_SECONDS) return { ok: false, reason: "too_old" };

  const b: ShopifyAddress = order.billing_address ?? order.shipping_address ?? {};
  const c: NonNullable<ShopifyOrder["customer"]> = order.customer ?? {};
  const user: UserDataInput = {};
  const map: [keyof UserDataInput, string | undefined][] = [
    ["email", str(order.email) ?? str(order.contact_email) ?? str(c.email)],
    ["phone", str(order.phone) ?? str(b.phone) ?? str(c.phone)],
    ["first_name", str(b.first_name) ?? str(c.first_name)],
    ["last_name", str(b.last_name) ?? str(c.last_name)],
    ["city", str(b.city)],
    ["state", str(b.province_code) ?? str(b.province)],
    ["zip", str(b.zip)],
    ["country", str(b.country_code) ?? str(b.country)],
    ["fbp", attribute(order, "_fbp", "fbp")],
    ["fbc", attribute(order, "_fbc", "fbc")],
  ];
  for (const [k, v] of map) if (v) user[k] = v;
  const customerId = str(c.id);
  if (customerId) user.external_id = customerId;

  const ctx: { ip?: string; userAgent?: string; defaultCountryCode?: string } = {};
  const ip = str(order.browser_ip) ?? str(order.client_details?.browser_ip);
  const ua = str(order.client_details?.user_agent);
  if (ip) ctx.ip = ip;
  if (ua) ctx.userAgent = ua;
  if (opts.defaultCountryCode) ctx.defaultCountryCode = opts.defaultCountryCode;

  const contents: ContentItem[] = [];
  let numItems = 0;
  for (const li of order.line_items ?? []) {
    const cid = str(li.sku) ?? str(li.variant_id) ?? str(li.product_id);
    if (!cid) continue;
    const quantity = Math.max(1, Math.floor(Number(li.quantity ?? 1)) || 1);
    const item: ContentItem = { id: cid, quantity };
    const price = Number(li.price);
    if (li.price !== undefined && Number.isFinite(price)) item.item_price = price;
    contents.push(item);
    numItems += quantity;
  }

  const event: ServerEvent = {
    event_name: "Purchase",
    event_time: eventTime,
    // Stable id so webhook retries, orders/create + orders/paid, and a browser Purchase deduplicate.
    event_id: shopifyEventId(id),
    action_source: "website",
    user_data: buildUserData(user, ctx),
    custom_data: {
      value,
      currency: order.currency.toUpperCase(),
      order_id: id,
      content_type: "product",
    },
  };
  if (opts.siteUrl) event.event_source_url = opts.siteUrl + "/checkout/";
  else if (isShopDomain(opts.shopDomain)) event.event_source_url = `https://${opts.shopDomain.toLowerCase()}/checkout/`;
  if (contents.length) {
    event.custom_data!.contents = contents;
    event.custom_data!.content_ids = contents.map((x) => x.id);
    event.custom_data!.num_items = numItems;
  }
  return { ok: true, event };
}
