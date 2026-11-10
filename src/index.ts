import { createServer } from "node:http";
import { CapiClient } from "./capi.js";
import { loadConfig } from "./config.js";
import { FileDeadLetter } from "./deadletter.js";
import { createLogger } from "./logger.js";
import { EventQueue } from "./queue.js";
import { RateLimiter } from "./ratelimit.js";
import { createHandler } from "./server.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);

const client = new CapiClient({
  pixelId: config.pixelId,
  accessToken: config.accessToken,
  apiVersion: config.graphApiVersion,
  baseUrl: config.graphBaseUrl,
  maxBatchSize: config.batchSize,
  maxRetries: config.maxRetries,
  logger,
  ...(config.testEventCode ? { testEventCode: config.testEventCode } : {}),
});
const queue = new EventQueue({
  client,
  deadLetter: new FileDeadLetter(config.deadLetterPath),
  batchSize: config.batchSize,
  flushIntervalMs: config.batchIntervalMs,
  maxQueue: config.maxQueue,
  logger,
});
const rateLimiter = new RateLimiter(config.rateLimitMax, config.rateLimitWindowSec * 1000);
const server = createServer(createHandler({ config, queue, logger, rateLimiter }));

server.listen(config.port, config.host, () => {
  logger.info("gateway listening", {
    port: config.port,
    graph_api_version: config.graphApiVersion,
    test_mode: Boolean(config.testEventCode),
    woocommerce: Boolean(config.wooSecret),
  });
  if (config.testEventCode) logger.warn("TEST_EVENT_CODE is set: events appear only in Test Events");
  if (config.allowedOrigins.length === 0) logger.warn("ALLOWED_ORIGINS is empty: browser events will be rejected");
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("shutting down", { signal });
  server.close();
  await queue.shutdown();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
