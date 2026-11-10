export interface Config {
  port: number;
  host: string;
  pixelId: string;
  accessToken: string;
  graphApiVersion: string;
  graphBaseUrl: string;
  testEventCode?: string;
  allowedOrigins: string[];
  allowMissingOrigin: boolean;
  rateLimitMax: number;
  rateLimitWindowSec: number;
  trustProxyHops: number;
  batchSize: number;
  batchIntervalMs: number;
  maxQueue: number;
  maxRetries: number;
  deadLetterPath: string;
  defaultPhoneCountryCode: string;
  logLevel: "debug" | "info" | "warn" | "error";
  wooSecret?: string;
  siteUrl?: string;
  maxBodyBytes: number;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function bool(env: Env, key: string, def: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return def;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new ConfigError(`${key} must be true or false`);
}

export function loadConfig(env: Env = process.env): Config {
  const pixelId = env.PIXEL_ID?.trim();
  const accessToken = env.ACCESS_TOKEN?.trim();
  if (!pixelId || !/^\d+$/.test(pixelId)) throw new ConfigError("PIXEL_ID is required and must be numeric");
  if (!accessToken) throw new ConfigError("ACCESS_TOKEN is required");

  const version = env.GRAPH_API_VERSION?.trim() || "v23.0";
  if (!/^v\d+\.\d+$/.test(version)) throw new ConfigError("GRAPH_API_VERSION must look like v23.0");

  const level = (env.LOG_LEVEL?.trim().toLowerCase() || "info") as Config["logLevel"];
  if (!["debug", "info", "warn", "error"].includes(level)) throw new ConfigError("LOG_LEVEL is invalid");

  const cc = env.DEFAULT_PHONE_COUNTRY_CODE?.trim() || "880";
  if (!/^\d{1,3}$/.test(cc)) throw new ConfigError("DEFAULT_PHONE_COUNTRY_CODE must be 1-3 digits");

  const origins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const cfg: Config = {
    port: int(env, "PORT", 8080, 0, 65535),
    host: env.HOST?.trim() || "0.0.0.0",
    pixelId,
    accessToken,
    graphApiVersion: version,
    graphBaseUrl: (env.GRAPH_BASE_URL?.trim() || "https://graph.facebook.com").replace(/\/+$/, ""),
    allowedOrigins: origins,
    allowMissingOrigin: bool(env, "ALLOW_MISSING_ORIGIN", false),
    rateLimitMax: int(env, "RATE_LIMIT_MAX", 60, 1, 1_000_000),
    rateLimitWindowSec: int(env, "RATE_LIMIT_WINDOW_SEC", 60, 1, 86_400),
    trustProxyHops: int(env, "TRUST_PROXY_HOPS", 0, 0, 10),
    batchSize: int(env, "BATCH_SIZE", 50, 1, 1000),
    batchIntervalMs: int(env, "BATCH_INTERVAL_MS", 2000, 10, 600_000),
    maxQueue: int(env, "MAX_QUEUE", 10_000, 1, 10_000_000),
    maxRetries: int(env, "MAX_RETRIES", 4, 0, 10),
    deadLetterPath: env.DEAD_LETTER_PATH?.trim() || "./data/dead-letter.jsonl",
    defaultPhoneCountryCode: cc,
    logLevel: level,
    maxBodyBytes: int(env, "MAX_BODY_BYTES", 65_536, 1024, 10_000_000),
  };
  if (env.TEST_EVENT_CODE?.trim()) cfg.testEventCode = env.TEST_EVENT_CODE.trim();
  if (env.WOOCOMMERCE_WEBHOOK_SECRET?.trim()) cfg.wooSecret = env.WOOCOMMERCE_WEBHOOK_SECRET.trim();
  if (env.SITE_URL?.trim()) cfg.siteUrl = env.SITE_URL.trim().replace(/\/+$/, "");
  return cfg;
}
