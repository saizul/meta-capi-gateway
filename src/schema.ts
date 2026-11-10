import { randomUUID } from "node:crypto";
import type { ContentItem, CustomData, UserDataInput, ValidEvent } from "./types.js";

export const STANDARD_EVENTS = [
  "PageView",
  "ViewContent",
  "AddToCart",
  "InitiateCheckout",
  "Purchase",
  "Lead",
  "CompleteRegistration",
] as const;

export const MAX_EVENT_AGE_SECONDS = 7 * 24 * 3600;
export const MAX_EVENTS_PER_REQUEST = 20;

const CUSTOM_NAME = /^[A-Za-z][A-Za-z0-9_ -]{0,49}$/;
const FBC = /^fb\.[0-2]\.\d{10,13}\..{1,500}$/;
const FBP = /^fb\.[0-2]\.\d{10,13}\.\d{1,20}$/;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, path: string, errors: string[], max = 500): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    errors.push(`${path} must be a string`);
    return undefined;
  }
  if (v.length > max) {
    errors.push(`${path} must be at most ${max} characters`);
    return undefined;
  }
  return v;
}

function num(v: unknown, path: string, errors: string[]): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    errors.push(`${path} must be a non-negative number`);
    return undefined;
  }
  return n;
}

function parseUser(raw: unknown, errors: string[]): UserDataInput {
  if (raw === undefined || raw === null) return {};
  if (!isObj(raw)) {
    errors.push("user must be an object");
    return {};
  }
  const out: UserDataInput = {};
  const keys = [
    "email",
    "phone",
    "first_name",
    "last_name",
    "city",
    "state",
    "zip",
    "country",
    "external_id",
    "date_of_birth",
    "gender",
  ] as const;
  for (const k of keys) {
    const v = str(raw[k], `user.${k}`, errors, 256);
    if (v !== undefined && v.trim() !== "") out[k] = v;
  }
  const fbp = str(raw.fbp, "user.fbp", errors, 200);
  if (fbp && FBP.test(fbp)) out.fbp = fbp; // malformed values are dropped, not rejected
  const fbc = str(raw.fbc, "user.fbc", errors, 600);
  if (fbc && FBC.test(fbc)) out.fbc = fbc;
  return out;
}

function parseContents(raw: unknown, errors: string[]): ContentItem[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > 100) {
    errors.push("custom_data.contents must be an array of at most 100 items");
    return undefined;
  }
  const out: ContentItem[] = [];
  raw.forEach((item, i) => {
    if (!isObj(item)) {
      errors.push(`custom_data.contents[${i}] must be an object`);
      return;
    }
    const id = typeof item.id === "number" ? String(item.id) : item.id;
    const sid = str(id, `custom_data.contents[${i}].id`, errors, 100);
    if (!sid) {
      if (id === undefined) errors.push(`custom_data.contents[${i}].id is required`);
      return;
    }
    const quantity = item.quantity === undefined ? 1 : num(item.quantity, `custom_data.contents[${i}].quantity`, errors);
    const price = num(item.item_price, `custom_data.contents[${i}].item_price`, errors);
    if (quantity === undefined) return;
    const c: ContentItem = { id: sid, quantity: Math.max(1, Math.floor(quantity)) };
    if (price !== undefined) c.item_price = price;
    out.push(c);
  });
  return out;
}

function parseCustom(raw: unknown, errors: string[]): CustomData {
  if (raw === undefined || raw === null) return {};
  if (!isObj(raw)) {
    errors.push("custom_data must be an object");
    return {};
  }
  const out: CustomData = {};
  const value = num(raw.value, "custom_data.value", errors);
  if (value !== undefined) out.value = value;
  const cur = str(raw.currency, "custom_data.currency", errors, 3);
  if (cur !== undefined) {
    if (/^[A-Za-z]{3}$/.test(cur)) out.currency = cur.toUpperCase();
    else errors.push("custom_data.currency must be a 3-letter ISO 4217 code");
  }
  if (raw.content_ids !== undefined && raw.content_ids !== null) {
    if (!Array.isArray(raw.content_ids) || raw.content_ids.length > 100) {
      errors.push("custom_data.content_ids must be an array of at most 100 strings");
    } else {
      const ids = raw.content_ids.map((x) => (typeof x === "number" ? String(x) : x));
      if (ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 100)) out.content_ids = ids as string[];
      else errors.push("custom_data.content_ids must contain non-empty strings");
    }
  }
  for (const k of ["content_type", "content_name", "content_category", "order_id", "search_string", "status"] as const) {
    const v = str(raw[k], `custom_data.${k}`, errors, 250);
    if (v !== undefined) out[k] = v;
  }
  const contents = parseContents(raw.contents, errors);
  if (contents) out.contents = contents;
  const n = num(raw.num_items, "custom_data.num_items", errors);
  if (n !== undefined) out.num_items = Math.floor(n);
  return out;
}

export function validateEvent(raw: unknown, nowSec = Math.floor(Date.now() / 1000)): ValidationResult<ValidEvent> {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["event must be an object"] };

  const name = str(raw.event_name, "event_name", errors, 50);
  if (raw.event_name === undefined) errors.push("event_name is required");
  else if (name !== undefined && !(STANDARD_EVENTS as readonly string[]).includes(name) && !CUSTOM_NAME.test(name)) {
    errors.push("event_name must be a standard event or a custom name (letters, digits, space, _ or -)");
  }

  let eventId = str(raw.event_id, "event_id", errors, 128);
  if (eventId !== undefined && eventId.trim() === "") eventId = undefined;

  let eventTime = nowSec;
  if (raw.event_time !== undefined && raw.event_time !== null) {
    let t = raw.event_time;
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) errors.push("event_time must be a unix timestamp");
    else {
      if (t > 1e11) t = Math.floor(t / 1000); // tolerate milliseconds
      t = Math.floor(t as number);
      if ((t as number) > nowSec + 60) errors.push("event_time is in the future");
      else if ((t as number) < nowSec - MAX_EVENT_AGE_SECONDS) errors.push("event_time is older than 7 days");
      else eventTime = t as number;
    }
  }

  let url: string | undefined;
  const rawUrl = str(raw.event_source_url, "event_source_url", errors, 2048);
  if (rawUrl) {
    try {
      const u = new URL(rawUrl);
      if (u.protocol === "http:" || u.protocol === "https:") url = u.toString();
      else errors.push("event_source_url must be http(s)");
    } catch {
      errors.push("event_source_url must be a valid URL");
    }
  }

  const user = parseUser(raw.user, errors);
  const custom = parseCustom(raw.custom_data, errors);

  if (name === "Purchase") {
    if (custom.value === undefined) errors.push("custom_data.value is required for Purchase");
    if (custom.currency === undefined) errors.push("custom_data.currency is required for Purchase");
  }

  let consent = true;
  if (raw.consent !== undefined) {
    if (typeof raw.consent !== "boolean") errors.push("consent must be a boolean");
    else consent = raw.consent;
  }

  if (errors.length > 0 || name === undefined) return { ok: false, errors };
  const value: ValidEvent = {
    event_name: name,
    event_id: eventId ?? randomUUID(),
    event_time: eventTime,
    user,
    custom_data: custom,
    consent,
  };
  if (url) value.event_source_url = url;
  return { ok: true, value };
}

/** Accepts a single event object or { events: [...] }. */
export function extractEvents(body: unknown): ValidationResult<unknown[]> {
  if (isObj(body) && Array.isArray(body.events)) {
    if (body.events.length === 0) return { ok: false, errors: ["events must not be empty"] };
    if (body.events.length > MAX_EVENTS_PER_REQUEST) {
      return { ok: false, errors: [`at most ${MAX_EVENTS_PER_REQUEST} events per request`] };
    }
    return { ok: true, value: body.events };
  }
  if (isObj(body)) return { ok: true, value: [body] };
  return { ok: false, errors: ["body must be a JSON object"] };
}
