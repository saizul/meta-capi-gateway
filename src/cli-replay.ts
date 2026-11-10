#!/usr/bin/env node
import { CapiClient } from "./capi.js";
import { loadConfig } from "./config.js";
import { replayDeadLetter } from "./deadletter.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const client = new CapiClient({
  pixelId: config.pixelId,
  accessToken: config.accessToken,
  apiVersion: config.graphApiVersion,
  baseUrl: config.graphBaseUrl,
  maxRetries: config.maxRetries,
  logger: createLogger(config.logLevel),
});
const path = process.argv[2] ?? config.deadLetterPath;
const { sent, remaining } = await replayDeadLetter(path, client);
process.stdout.write(JSON.stringify({ file: path, sent, remaining }) + "\n");
process.exit(remaining > 0 ? 1 : 0);
