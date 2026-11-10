export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Keys whose values are never logged.
const SENSITIVE_KEY =
  /^(em|ph|fn|ln|ct|st|zp|db|ge|country|external_id|client_ip_address|client_user_agent|fbp|fbc|ip|ua|user_agent|user|user_data|email|phone|first_name|last_name|access_token|token|secret|authorization|cookie|signature|password)$/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const LONG_TOKEN = /\b(?:EA[A-Za-z0-9]{20,}|[A-Fa-f0-9]{64})\b/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") {
    return value.replace(EMAIL, "[email]").replace(LONG_TOKEN, "[token]").slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  level: Level = "info",
  sink: (line: string) => void = (l) => process.stdout.write(l + "\n"),
  now: () => Date = () => new Date(),
): Logger {
  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const safe = fields ? (redact(fields) as Record<string, unknown>) : {};
    sink(JSON.stringify({ ts: now().toISOString(), level: lvl, msg, ...safe }));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
