import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CapiError, CapiClient } from "./capi.js";
import type { ServerEvent } from "./types.js";

export interface DeadLetterEntry {
  failed_at: string;
  attempts: number;
  error: CapiError;
  events: ServerEvent[];
}

export interface DeadLetterSink {
  write(entry: DeadLetterEntry): Promise<void>;
}

/** Append-only JSON Lines file. Contains hashed identifiers, IPs and user agents; protect it. */
export class FileDeadLetter implements DeadLetterSink {
  constructor(private readonly path: string) {}

  async write(entry: DeadLetterEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
  }
}

export async function readDeadLetter(path: string): Promise<DeadLetterEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: DeadLetterEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DeadLetterEntry);
    } catch {
      // skip corrupt lines rather than blocking a replay
    }
  }
  return out;
}

/**
 * Re-send dead-lettered events. Entries that fail again are kept in the file.
 * Events older than the API's 7-day window will keep failing; they are reported, not dropped.
 */
export async function replayDeadLetter(
  path: string,
  client: CapiClient,
): Promise<{ sent: number; remaining: number }> {
  const entries = await readDeadLetter(path);
  const kept: DeadLetterEntry[] = [];
  let sent = 0;
  for (const entry of entries) {
    const results = await client.send(entry.events);
    const failed = results.filter((r) => !r.ok);
    sent += results.filter((r) => r.ok).reduce((n, r) => n + r.events.length, 0);
    for (const f of failed) {
      kept.push({ failed_at: new Date().toISOString(), attempts: f.attempts, error: f.error!, events: f.events });
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""), {
    encoding: "utf8",
    mode: 0o600,
  });
  return { sent, remaining: kept.reduce((n, e) => n + e.events.length, 0) };
}
