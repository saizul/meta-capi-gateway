import type { IncomingMessage, ServerResponse } from "node:http";
import { toServerEvent } from "./capi.js";
import type { Config } from "./config.js";
import { corsHeaders, isOriginAllowed } from "./cors.js";
import type { Logger } from "./logger.js";
import type { EventSink } from "./queue.js";
import type { RateLimiter } from "./ratelimit.js";
import { extractEvents, validateEvent } from "./schema.js";
import { SHOPIFY_ORDER_TOPICS, shopifyOrderToPurchase, verifyShopifySignature } from "./shopify.js";
import type { ShopifyOptions, ShopifyOrder } from "./shopify.js";
import { SNIPPET } from "./snippet.js";
import type { ServerEvent, ValidEvent } from "./types.js";
import { SeenOrders, orderToPurchase, verifyWooSignature } from "./woocommerce.js";
import type { WooOrder } from "./woocommerce.js";

export const VERSION = "0.1.0";

export interface AppDeps {
  config: Config;
  queue: EventSink;
  logger: Logger;
  rateLimiter: RateLimiter;
  seenOrders?: SeenOrders;
  now?: () => number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function clientIp(req: Pick<IncomingMessage, "headers" | "socket">, hops: number): string {
  const socketIp = req.socket.remoteAddress ?? "unknown";
  if (hops <= 0) return socketIp;
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : xff;
  if (!raw) return socketIp;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // The last `hops` entries were appended by our own proxies; the client is just before them.
  const idx = parts.length - hops;
  return parts[Math.max(0, idx)] ?? socketIp;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, "payload too large"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

export function createHandler(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { config, queue, logger, rateLimiter } = deps;
  const seen = deps.seenOrders ?? new SeenOrders();
  const startedAt = (deps.now ?? Date.now)();

  async function events(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    let cors: Record<string, string> = {};
    if (origin) {
      if (!isOriginAllowed(origin, config.allowedOrigins)) {
        send(res, 403, { error: "origin_not_allowed" });
        return;
      }
      cors = corsHeaders(origin);
    } else if (!config.allowMissingOrigin) {
      send(res, 403, { error: "origin_required" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "method_not_allowed" }, { allow: "POST, OPTIONS", ...cors });
      return;
    }
    const ip = clientIp(req, config.trustProxyHops);
    const rl = rateLimiter.check(ip);
    if (!rl.allowed) {
      send(res, 429, { error: "rate_limited" }, { "retry-after": String(rl.retryAfterSec), ...cors });
      return;
    }
    const ctype = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (ctype !== "application/json" && ctype !== "text/plain") {
      send(res, 415, { error: "unsupported_media_type" }, cors);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req, config.maxBodyBytes)).toString("utf8"));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      send(res, 400, { error: "invalid_json" }, cors);
      return;
    }
    const list = extractEvents(body);
    if (!list.ok) {
      send(res, 400, { error: "validation_failed", details: [{ index: 0, errors: list.errors }] }, cors);
      return;
    }
    const valid: ValidEvent[] = [];
    const details: { index: number; errors: string[] }[] = [];
    list.value.forEach((raw, index) => {
      const r = validateEvent(raw, Math.floor((deps.now ?? Date.now)() / 1000));
      if (r.ok) valid.push(r.value);
      else details.push({ index, errors: r.errors });
    });
    if (details.length > 0) {
      send(res, 400, { error: "validation_failed", details }, cors);
      return;
    }
    const accepted: ServerEvent[] = [];
    let dropped = 0;
    const ua = req.headers["user-agent"];
    for (const ev of valid) {
      if (!ev.consent) {
        dropped++;
        continue;
      }
      const ctx: { ip?: string; userAgent?: string; defaultCountryCode?: string } = {
        ip,
        defaultCountryCode: config.defaultPhoneCountryCode,
      };
      if (ua) ctx.userAgent = ua;
      accepted.push(toServerEvent(ev, ctx));
    }
    if (accepted.length > 0 && !queue.add(accepted)) {
      logger.warn("queue full, rejecting events", { count: accepted.length });
      send(res, 503, { error: "queue_full" }, { "retry-after": "5", ...cors });
      return;
    }
    send(res, 202, { accepted: accepted.length, dropped, event_ids: accepted.map((e) => e.event_id) }, cors);
  }

  async function woo(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!config.wooSecret) {
      send(res, 404, { error: "not_found" });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
      return;
    }
    const raw = await readBody(req, Math.max(config.maxBodyBytes, 1_048_576));
    const sig = req.headers["x-wc-webhook-signature"];
    if (!verifyWooSignature(raw, Array.isArray(sig) ? sig[0] : sig, config.wooSecret)) {
      logger.warn("woocommerce signature rejected");
      send(res, 401, { error: "invalid_signature" });
      return;
    }
    let order: WooOrder;
    try {
      order = JSON.parse(raw.toString("utf8")) as WooOrder;
      if (typeof order !== "object" || order === null) throw new Error("not an object");
    } catch {
      // WooCommerce sends a form-encoded "webhook_id=N" ping when a webhook is saved.
      send(res, 200, { ok: true, ignored: "ping" });
      return;
    }
    const opts: Parameters<typeof orderToPurchase>[1] = {
      defaultCountryCode: config.defaultPhoneCountryCode,
    };
    if (config.siteUrl) opts.siteUrl = config.siteUrl;
    if (deps.now) opts.nowSec = Math.floor(deps.now() / 1000);
    const result = orderToPurchase(order, opts);
    if (!result.ok) {
      send(res, result.reason === "invalid_order" ? 400 : 200, { ok: result.reason !== "invalid_order", ignored: result.reason });
      return;
    }
    const key = String(order.id);
    if (seen.has(key)) {
      send(res, 200, { ok: true, ignored: "duplicate", event_id: result.event.event_id });
      return;
    }
    if (!queue.add([result.event])) {
      send(res, 503, { error: "queue_full" }, { "retry-after": "5" });
      return;
    }
    seen.add(key);
    send(res, 202, { accepted: 1, event_id: result.event.event_id });
  }

  async function shopify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!config.shopifySecret) {
      send(res, 404, { error: "not_found" });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
      return;
    }
    const raw = await readBody(req, Math.max(config.maxBodyBytes, 1_048_576));
    if (!verifyShopifySignature(raw, header(req, "x-shopify-hmac-sha256"), config.shopifySecret)) {
      logger.warn("shopify signature rejected");
      send(res, 401, { error: "invalid_signature" });
      return;
    }
    // Shopify retries anything that is not 2xx, so unsupported topics are acknowledged, not rejected.
    const topic = header(req, "x-shopify-topic")?.trim().toLowerCase();
    if (topic && !SHOPIFY_ORDER_TOPICS.includes(topic)) {
      send(res, 200, { ok: true, ignored: "topic" });
      return;
    }
    let order: ShopifyOrder;
    try {
      order = JSON.parse(raw.toString("utf8")) as ShopifyOrder;
      if (typeof order !== "object" || order === null || Array.isArray(order)) throw new Error("not an object");
    } catch {
      send(res, 400, { error: "invalid_json" });
      return;
    }
    const opts: ShopifyOptions = {
      defaultCountryCode: config.defaultPhoneCountryCode,
      acceptedStatuses: config.shopifyFinancialStatuses,
      includeTestOrders: config.shopifyIncludeTestOrders,
    };
    if (config.siteUrl) opts.siteUrl = config.siteUrl;
    const shop = header(req, "x-shopify-shop-domain");
    if (shop) opts.shopDomain = shop.trim();
    if (deps.now) opts.nowSec = Math.floor(deps.now() / 1000);
    const result = shopifyOrderToPurchase(order, opts);
    if (!result.ok) {
      send(res, result.reason === "invalid_order" ? 400 : 200, { ok: result.reason !== "invalid_order", ignored: result.reason });
      return;
    }
    // orders/create, orders/paid and orders/updated all describe the same order: forward it once.
    const key = "shopify:" + result.event.custom_data!.order_id!;
    if (seen.has(key)) {
      send(res, 200, { ok: true, ignored: "duplicate", event_id: result.event.event_id });
      return;
    }
    if (!queue.add([result.event])) {
      send(res, 503, { error: "queue_full" }, { "retry-after": "5" });
      return;
    }
    seen.add(key);
    send(res, 202, { accepted: 1, event_id: result.event.event_id });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/health" && (req.method === "GET" || req.method === "HEAD")) {
      send(res, 200, {
        status: "ok",
        version: VERSION,
        uptime_seconds: Math.floor(((deps.now ?? Date.now)() - startedAt) / 1000),
        queue_size: queue.size(),
      });
      return;
    }
    if (path === "/snippet.js" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
      });
      res.end(SNIPPET);
      return;
    }
    if (path === "/events") return events(req, res);
    if (path === "/webhooks/woocommerce") return woo(req, res);
    if (path === "/webhooks/shopify") return shopify(req, res);
    send(res, 404, { error: "not_found" });
  }

  return (req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message });
        return;
      }
      logger.error("unhandled request error", { reason: err instanceof Error ? err.message : "unknown" });
      send(res, 500, { error: "internal_error" });
    });
  };
}
