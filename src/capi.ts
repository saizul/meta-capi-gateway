import { buildUserData } from "./normalize.js";
import type { Logger } from "./logger.js";
import { silentLogger } from "./logger.js";
import type { ServerEvent, ValidEvent } from "./types.js";

/** Meta accepts at most 1000 events per request. */
export const API_MAX_BATCH = 1000;

export function toServerEvent(
  ev: ValidEvent,
  ctx: { ip?: string; userAgent?: string; defaultCountryCode?: string },
): ServerEvent {
  const out: ServerEvent = {
    event_name: ev.event_name,
    event_time: ev.event_time,
    event_id: ev.event_id,
    action_source: "website",
    user_data: buildUserData(ev.user, ctx),
  };
  if (ev.event_source_url) out.event_source_url = ev.event_source_url;
  if (Object.keys(ev.custom_data).length > 0) out.custom_data = ev.custom_data;
  return out;
}

export interface CapiError {
  status: number;
  code?: number;
  type?: string;
  message: string;
  fbtrace_id?: string;
}

export interface ChunkResult {
  ok: boolean;
  events: ServerEvent[];
  attempts: number;
  eventsReceived?: number;
  fbtraceId?: string;
  error?: CapiError;
}

export interface CapiClientOptions {
  pixelId: string;
  accessToken: string;
  apiVersion?: string;
  baseUrl?: string;
  testEventCode?: string;
  maxBatchSize?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: Logger;
}

// Graph API error codes that indicate a transient problem or throttling.
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

export class CapiClient {
  private readonly o: Required<
    Omit<CapiClientOptions, "testEventCode" | "fetch" | "sleep" | "random" | "logger">
  > &
    Pick<CapiClientOptions, "testEventCode">;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly logger: Logger;

  constructor(opts: CapiClientOptions) {
    this.o = {
      pixelId: opts.pixelId,
      accessToken: opts.accessToken,
      apiVersion: opts.apiVersion ?? "v23.0",
      baseUrl: (opts.baseUrl ?? "https://graph.facebook.com").replace(/\/+$/, ""),
      maxBatchSize: Math.min(opts.maxBatchSize ?? API_MAX_BATCH, API_MAX_BATCH),
      maxRetries: opts.maxRetries ?? 4,
      baseDelayMs: opts.baseDelayMs ?? 500,
      maxDelayMs: opts.maxDelayMs ?? 30_000,
      timeoutMs: opts.timeoutMs ?? 15_000,
      testEventCode: opts.testEventCode,
    };
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.logger = opts.logger ?? silentLogger;
  }

  get endpoint(): string {
    return `${this.o.baseUrl}/${this.o.apiVersion}/${this.o.pixelId}/events`;
  }

  /** Split into API-sized chunks and send each. Never throws for API failures. */
  async send(events: ServerEvent[]): Promise<ChunkResult[]> {
    const results: ChunkResult[] = [];
    for (let i = 0; i < events.length; i += this.o.maxBatchSize) {
      results.push(await this.sendChunk(events.slice(i, i + this.o.maxBatchSize)));
    }
    return results;
  }

  backoffMs(attempt: number, retryAfterSec?: number): number {
    if (retryAfterSec !== undefined && retryAfterSec >= 0) {
      return Math.min(retryAfterSec * 1000, this.o.maxDelayMs);
    }
    const exp = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** attempt);
    return Math.round(exp * (0.5 + this.random() * 0.5));
  }

  private async sendChunk(events: ServerEvent[]): Promise<ChunkResult> {
    const body: Record<string, unknown> = { data: events, access_token: this.o.accessToken };
    if (this.o.testEventCode) body.test_event_code = this.o.testEventCode;
    const payload = JSON.stringify(body);

    let last: CapiError = { status: 0, message: "unknown" };
    for (let attempt = 0; attempt <= this.o.maxRetries; attempt++) {
      let retryAfter: number | undefined;
      let retryable = true;
      try {
        const res = await this.fetchFn(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
        const json = (await res.json().catch(() => ({}))) as {
          events_received?: number;
          fbtrace_id?: string;
          error?: { code?: number; type?: string; message?: string; fbtrace_id?: string; is_transient?: boolean };
        };
        if (res.ok) {
          this.logger.info("capi batch sent", {
            events: events.length,
            attempts: attempt + 1,
            events_received: json.events_received,
            fbtrace_id: json.fbtrace_id,
          });
          const r: ChunkResult = { ok: true, events, attempts: attempt + 1 };
          if (json.events_received !== undefined) r.eventsReceived = json.events_received;
          if (json.fbtrace_id) r.fbtraceId = json.fbtrace_id;
          return r;
        }
        const e = json.error ?? {};
        last = { status: res.status, message: e.message ?? `HTTP ${res.status}` };
        if (e.code !== undefined) last.code = e.code;
        if (e.type) last.type = e.type;
        const trace = e.fbtrace_id ?? json.fbtrace_id;
        if (trace) last.fbtrace_id = trace;
        retryable =
          res.status >= 500 ||
          res.status === 429 ||
          e.is_transient === true ||
          (e.code !== undefined && TRANSIENT_CODES.has(e.code));
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && res.headers.get("retry-after") !== null) retryAfter = ra;
      } catch (err) {
        last = { status: 0, message: err instanceof Error ? err.message : "network error" };
      }
      if (!retryable || attempt === this.o.maxRetries) {
        this.logger.error("capi batch failed", {
          events: events.length,
          attempts: attempt + 1,
          status: last.status,
          code: last.code,
          fbtrace_id: last.fbtrace_id,
        });
        return { ok: false, events, attempts: attempt + 1, error: last };
      }
      const delay = this.backoffMs(attempt, retryAfter);
      this.logger.warn("capi batch retry", { attempt: attempt + 1, delay_ms: delay, status: last.status });
      await this.sleep(delay);
    }
    return { ok: false, events, attempts: this.o.maxRetries + 1, error: last };
  }
}
