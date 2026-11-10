import { createHmac, timingSafeEqual } from "node:crypto";
import { MAX_EVENT_AGE_SECONDS } from "./schema.js";
import { buildUserData } from "./normalize.js";
import type { ContentItem, ServerEvent, UserDataInput } from "./types.js";

/** WooCommerce signs the raw body: base64(HMAC-SHA256(secret, body)) in X-WC-Webhook-Signature. */
export function computeWooSignature(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

export function verifyWooSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header || !secret) return false;
  const expected = Buffer.from(computeWooSignature(rawBody, secret));
  const given = Buffer.from(header.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

interface WooLineItem {
  product_id?: number;
  variation_id?: number;
  sku?: string;
  quantity?: number;
  price?: number | string;
}

export interface WooOrder {
  id?: number | string;
  status?: string;
  currency?: string;
  total?: string | number;
  date_paid_gmt?: string | null;
  date_completed_gmt?: string | null;
  date_created_gmt?: string | null;
  customer_id?: number | string;
  customer_ip_address?: string;
  customer_user_agent?: string;
  billing?: Record<string, string | undefined>;
  line_items?: WooLineItem[];
  meta_data?: { key?: string; value?: unknown }[];
}

export type WooResult =
  | { ok: true; event: ServerEvent }
  | { ok: false; reason: "not_completed" | "invalid_order" | "too_old" };

function gmt(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + "Z");
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

function meta(order: WooOrder, key: string): string | undefined {
  const m = order.meta_data?.find((x) => x.key === key);
  return typeof m?.value === "string" && m.value ? m.value : undefined;
}

export function orderToPurchase(
  order: WooOrder,
  opts: {
    siteUrl?: string;
    defaultCountryCode?: string;
    acceptedStatuses?: string[];
    nowSec?: number;
  } = {},
): WooResult {
  const accepted = opts.acceptedStatuses ?? ["completed"];
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (order.id === undefined || order.id === null || order.currency === undefined || order.total === undefined) {
    return { ok: false, reason: "invalid_order" };
  }
  const value = Number(order.total);
  if (!Number.isFinite(value) || value < 0 || !/^[A-Za-z]{3}$/.test(order.currency)) {
    return { ok: false, reason: "invalid_order" };
  }
  if (!order.status || !accepted.includes(order.status)) return { ok: false, reason: "not_completed" };

  const time = gmt(order.date_paid_gmt) ?? gmt(order.date_completed_gmt) ?? gmt(order.date_created_gmt) ?? now;
  const eventTime = Math.min(time, now);
  if (eventTime < now - MAX_EVENT_AGE_SECONDS) return { ok: false, reason: "too_old" };

  const b = order.billing ?? {};
  const user: UserDataInput = {};
  const map: [keyof UserDataInput, string | undefined][] = [
    ["email", b.email],
    ["phone", b.phone],
    ["first_name", b.first_name],
    ["last_name", b.last_name],
    ["city", b.city],
    ["state", b.state],
    ["zip", b.postcode],
    ["country", b.country],
    ["fbp", meta(order, "_fbp")],
    ["fbc", meta(order, "_fbc")],
  ];
  for (const [k, v] of map) if (v && v.trim()) user[k] = v;
  if (order.customer_id && String(order.customer_id) !== "0") user.external_id = String(order.customer_id);

  const ctx: { ip?: string; userAgent?: string; defaultCountryCode?: string } = {};
  if (order.customer_ip_address) ctx.ip = order.customer_ip_address;
  if (order.customer_user_agent) ctx.userAgent = order.customer_user_agent;
  if (opts.defaultCountryCode) ctx.defaultCountryCode = opts.defaultCountryCode;

  const contents: ContentItem[] = [];
  let numItems = 0;
  for (const li of order.line_items ?? []) {
    const id = li.sku || (li.product_id !== undefined ? String(li.product_id) : undefined);
    if (!id) continue;
    const quantity = Math.max(1, Math.floor(Number(li.quantity ?? 1)) || 1);
    const c: ContentItem = { id, quantity };
    const price = Number(li.price);
    if (li.price !== undefined && Number.isFinite(price)) c.item_price = price;
    contents.push(c);
    numItems += quantity;
  }

  const event: ServerEvent = {
    event_name: "Purchase",
    event_time: eventTime,
    // Stable id so webhook retries and a browser-side Purchase with the same id deduplicate.
    event_id: `wc_order_${order.id}`,
    action_source: "website",
    user_data: buildUserData(user, ctx),
    custom_data: {
      value,
      currency: order.currency.toUpperCase(),
      order_id: String(order.id),
      content_type: "product",
    },
  };
  if (opts.siteUrl) event.event_source_url = opts.siteUrl + "/checkout/";
  if (contents.length) {
    event.custom_data!.contents = contents;
    event.custom_data!.content_ids = contents.map((c) => c.id);
    event.custom_data!.num_items = numItems;
  }
  return { ok: true, event };
}

/** Small bounded set remembering order ids already forwarded. */
export class SeenOrders {
  private readonly ids = new Set<string>();
  constructor(private readonly max = 5000) {}
  has(id: string): boolean {
    return this.ids.has(id);
  }
  add(id: string): void {
    this.ids.add(id);
    if (this.ids.size > this.max) {
      const first = this.ids.values().next();
      if (!first.done) this.ids.delete(first.value);
    }
  }
  delete(id: string): void {
    this.ids.delete(id);
  }
}
