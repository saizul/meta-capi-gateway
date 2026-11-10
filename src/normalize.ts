import { hashNormalized, isSha256Hex } from "./hash.js";
import type { ServerUserData, UserDataInput } from "./types.js";

const COUNTRY_NAMES: Record<string, string> = {
  bangladesh: "bd",
  india: "in",
  pakistan: "pk",
  "united states": "us",
  usa: "us",
  "united kingdom": "gb",
  uk: "gb",
  canada: "ca",
  australia: "au",
  germany: "de",
  "saudi arabia": "sa",
  "united arab emirates": "ae",
  uae: "ae",
  malaysia: "my",
  singapore: "sg",
};

export function normalizeEmail(raw: string): string | undefined {
  const v = raw.trim().toLowerCase();
  if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return undefined;
  return v;
}

/**
 * Digits only, with country code, no leading zeros or symbols.
 * Numbers without a "+" or "00" prefix are interpreted using defaultCc
 * (Bangladesh "880" by default): 01712345678 -> 8801712345678.
 */
export function normalizePhone(raw: string, defaultCc = "880"): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const plus = s.startsWith("+");
  let d = s.replace(/\D/g, "");
  if (!d) return undefined;
  if (!plus) {
    if (d.startsWith("00")) d = d.slice(2);
    else if (d.startsWith(defaultCc)) {
      // already carries the country code
    } else if (d.startsWith("0")) d = defaultCc + d.replace(/^0+/, "");
    else if (d.length <= 10) d = defaultCc + d;
  }
  // Drop a trunk zero written after the default country code: +880 01712...
  if (d.startsWith(defaultCc) && d.slice(defaultCc.length).startsWith("0")) {
    d = defaultCc + d.slice(defaultCc.length).replace(/^0+/, "");
  }
  d = d.replace(/^0+/, "");
  if (d.length < 7 || d.length > 15) return undefined;
  return d;
}

/** Bangladesh mobile in international digits: 880 1[3-9]XXXXXXXX. */
export function isBangladeshMobile(digits: string): boolean {
  return /^8801[3-9]\d{8}$/.test(digits);
}

export function normalizeName(raw: string): string | undefined {
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return v || undefined;
}

export function normalizeCity(raw: string): string | undefined {
  const v = raw.toLowerCase().replace(/[^\p{L}\p{M}]/gu, "");
  return v || undefined;
}

export function normalizeState(raw: string): string | undefined {
  const v = raw.toLowerCase().replace(/[^\p{L}\p{M}]/gu, "");
  return v || undefined;
}

export function normalizeZip(raw: string, country?: string): string | undefined {
  let v = raw.toLowerCase().replace(/[\s-]/g, "");
  if (!v) return undefined;
  if (country === "us" && /^\d{5}/.test(v)) v = v.slice(0, 5);
  return v;
}

export function normalizeCountry(raw: string): string | undefined {
  const v = raw.trim().toLowerCase();
  const alias = COUNTRY_NAMES[v]; // also fixes common non-ISO codes such as "uk"
  if (alias) return alias;
  return /^[a-z]{2}$/.test(v) ? v : undefined;
}

export function normalizeExternalId(raw: string): string | undefined {
  const v = raw.trim();
  return v || undefined;
}

/** Date of birth as YYYYMMDD. Accepts YYYY-MM-DD, YYYY/MM/DD or YYYYMMDD. */
export function normalizeDob(raw: string): string | undefined {
  const m = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/.exec(raw.trim());
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${y}${mo}${d}`;
}

export function normalizeGender(raw: string): string | undefined {
  const v = raw.trim().toLowerCase();
  if (["f", "female", "woman"].includes(v)) return "f";
  if (["m", "male", "man"].includes(v)) return "m";
  return undefined;
}

export interface UserDataContext {
  ip?: string;
  userAgent?: string;
  defaultCountryCode?: string;
}

/** Strip the IPv4-mapped IPv6 prefix so Meta sees a plain IPv4 address. */
export function cleanIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const v = ip.trim().replace(/^::ffff:/i, "");
  return v || undefined;
}

type Norm = (v: string) => string | undefined;

function hashField(raw: string | undefined, fn: Norm): string[] | undefined {
  if (raw === undefined) return undefined;
  // Pre-hashed values are trusted and passed through unchanged.
  if (isSha256Hex(raw.trim())) return [raw.trim().toLowerCase()];
  const n = fn(raw);
  return n ? [hashNormalized(n)] : undefined;
}

export function buildUserData(input: UserDataInput, ctx: UserDataContext = {}): ServerUserData {
  const cc = ctx.defaultCountryCode ?? "880";
  const country = input.country ? normalizeCountry(input.country) : undefined;
  const out: ServerUserData = {};
  const set = <K extends keyof ServerUserData>(k: K, v: ServerUserData[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("em", hashField(input.email, normalizeEmail));
  set("ph", hashField(input.phone, (v) => normalizePhone(v, cc)));
  set("fn", hashField(input.first_name, normalizeName));
  set("ln", hashField(input.last_name, normalizeName));
  set("ct", hashField(input.city, normalizeCity));
  set("st", hashField(input.state, normalizeState));
  set("zp", hashField(input.zip, (v) => normalizeZip(v, country)));
  set("country", hashField(input.country, normalizeCountry));
  set("external_id", hashField(input.external_id, normalizeExternalId));
  set("db", hashField(input.date_of_birth, normalizeDob));
  set("ge", hashField(input.gender, normalizeGender));
  const ip = cleanIp(ctx.ip);
  if (ip) out.client_ip_address = ip;
  if (ctx.userAgent) out.client_user_agent = ctx.userAgent;
  if (input.fbp) out.fbp = input.fbp;
  if (input.fbc) out.fbc = input.fbc;
  return out;
}
