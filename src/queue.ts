import type { CapiClient } from "./capi.js";
import type { DeadLetterSink } from "./deadletter.js";
import type { Logger } from "./logger.js";
import { silentLogger } from "./logger.js";
import type { ServerEvent } from "./types.js";

export interface QueueOptions {
  client: Pick<CapiClient, "send">;
  deadLetter: DeadLetterSink;
  batchSize: number;
  flushIntervalMs: number;
  maxQueue: number;
  logger?: Logger;
}

export interface EventSink {
  add(events: ServerEvent[]): boolean;
  size(): number;
}

/** In-memory batching queue: flushes on size or interval; failed batches go to the dead-letter sink. */
export class EventQueue implements EventSink {
  private pending: ServerEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly inflight = new Set<Promise<void>>();
  private closed = false;
  private readonly logger: Logger;

  constructor(private readonly o: QueueOptions) {
    this.logger = o.logger ?? silentLogger;
  }

  size(): number {
    return this.pending.length;
  }

  /** Returns false when the queue is full or shut down (caller should answer 503). */
  add(events: ServerEvent[]): boolean {
    if (this.closed || this.pending.length + events.length > this.o.maxQueue) return false;
    this.pending.push(...events);
    if (this.pending.length >= this.o.batchSize) {
      this.track(this.flush());
    } else if (!this.timer && this.pending.length > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.track(this.flush());
      }, this.o.flushIntervalMs);
      this.timer.unref();
    }
    return true;
  }

  private track(p: Promise<void>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    const results = await this.o.client.send(batch);
    for (const r of results) {
      if (r.ok) continue;
      try {
        await this.o.deadLetter.write({
          failed_at: new Date().toISOString(),
          attempts: r.attempts,
          error: r.error ?? { status: 0, message: "unknown" },
          events: r.events,
        });
        this.logger.warn("batch moved to dead letter", { events: r.events.length, status: r.error?.status });
      } catch (err) {
        this.logger.error("dead letter write failed", {
          events: r.events.length,
          reason: err instanceof Error ? err.message : "unknown",
        });
      }
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.flush();
    await Promise.allSettled([...this.inflight]);
  }
}
