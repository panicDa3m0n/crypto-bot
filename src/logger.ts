import pino from "pino";
import { createStream } from "rotating-file-stream";
import { mkdirSync } from "node:fs";
import type { Config } from "./config.js";

/**
 * ONE logger for the WHOLE system — every subsystem (indexer, enricher, Scarlet, position-manager,
 * primitives, chain, RPC lanes, …) receives this instance, so all their events land in the SAME stream.
 * It fans out to: (1) stdout (Docker json-file, for `docker logs`), and (2) a persistent, TIMESTAMPED,
 * ROTATING file on a mounted volume — the unified observability log we review to catch silent bugs across
 * restarts. Rotation (interval + size + retention) keeps it from growing forever; all of it is settable.
 * Every line carries an ISO timestamp so the timeline is unambiguous.
 */
export function createLogger(config: Config) {
  const streams: pino.StreamEntry[] = [{ level: config.LOG_LEVEL, stream: process.stdout }];
  let mainLevel: pino.Level = config.LOG_LEVEL;

  if (config.LOG_FILE_ENABLED) {
    try {
      mkdirSync(config.LOG_DIR, { recursive: true });
      const fileStream = createStream(`system-${config.SERVICE_ROLE}.log`, {
        path: config.LOG_DIR,
        interval: config.LOG_ROTATE_INTERVAL,        // rotate on cadence (e.g. '12h')
        maxFiles: config.LOG_RETENTION_FILES,        // keep this many rotated files (retention)
        size: config.LOG_MAX_SIZE || undefined,      // also rotate past this size
        compress: "gzip"                             // gzip the rotated-out files
      });
      streams.push({ level: config.LOG_FILE_LEVEL, stream: fileStream });
      // The main threshold must be the MORE verbose of the two, so the file can capture debug while stdout stays at info.
      if (pino.levels.values[config.LOG_FILE_LEVEL] < pino.levels.values[mainLevel]) mainLevel = config.LOG_FILE_LEVEL;
    } catch { /* file logging unavailable (e.g. read-only fs) → degrade to stdout only, never crash */ }
  }

  return pino(
    { level: mainLevel, base: { service: "berachain-wallet-brain", role: config.SERVICE_ROLE }, timestamp: pino.stdTimeFunctions.isoTime },
    pino.multistream(streams)
  );
}
