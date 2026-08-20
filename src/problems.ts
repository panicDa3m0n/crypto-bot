import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

/**
 * PROBLEM FEED — the WARN/ERROR/FATAL lines only, deduplicated into distinct problems with counts and
 * first/last-seen. Not a log stream: a human needs "what is wrong, how often, since when", not thousands of
 * healthy lines. Reads the tail of the rotating pino files (no new write path, nothing to keep in sync).
 *
 * Deduplication is by SIGNATURE (component + message + error shape) so one recurring fault is ONE row with a
 * count, instead of drowning the real diversity of problems.
 */

export interface Problem {
  level: "warn" | "error" | "fatal";
  /** fault = something is wrong. config = a deliberate steady state announced at warn level (a disabled
   * component, a retired subsystem). Mixing them makes the list unreadable: intentional states repeat on
   * every restart and drown real faults, so they are separated instead of hidden. */
  category: "fault" | "config";
  component: string;
  message: string;
  detail?: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** Still happening (seen within the recency window) vs already stopped. Without this a fault that was fixed
   * an hour ago still reads as a live alarm — the count alone cannot tell you if it is over. */
  active: boolean;
}

// Deliberate configuration states, logged as warnings by design. Kept visible, but out of the fault list.
const CONFIG_STATE = [
  /DISABLED by config/i, /RETIRED by config/i, /disabled — skipping/i,
  /NOT started\. .*still run/i, /Set [A-Z_]+=true to re-enable/i,
];

const LEVEL_NAME: Record<number, Problem["level"]> = { 40: "warn", 50: "error", 60: "fatal" };
const TAIL_BYTES = 1_500_000; // enough for a meaningful window without reading whole rotated logs

/** Read the last `TAIL_BYTES` of a file (whole-file if smaller). Avoids loading rotated multi-MB logs. */
function tail(path: string, bytes = TAIL_BYTES): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const len = size - start;
  if (len <= 0) return "";
  const fd = openSync(path, "r");
  try { const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, start); return buf.toString("utf8"); }
  finally { closeSync(fd); }
}

/** Collapse a message into a signature: strip addresses, hashes, and numbers so the SAME fault with different
 * operands groups into one problem (otherwise every pool address looks like a distinct issue). */
function signature(s: string): string {
  return s.replace(/0x[a-fA-F0-9]{6,}/g, "0x…").replace(/\b\d[\d.,]*\b/g, "N").slice(0, 200);
}

export function readProblems(logDir = "logs", opts: { minLevel?: number; limit?: number; activeWindowMs?: number } = {}): { problems: Problem[]; configStates?: Problem[]; scannedFiles: string[]; note?: string } {
  const minLevel = opts.minLevel ?? 40;
  let files: string[] = [];
  try { files = readdirSync(logDir).filter((f) => f.endsWith(".log") && f.startsWith("system-")).map((f) => join(logDir, f)); }
  catch { return { problems: [], scannedFiles: [], note: `log dir "${logDir}" not readable` }; }
  if (!files.length) return { problems: [], scannedFiles: [], note: "no system-*.log files found" };

  const byKey = new Map<string, Problem>();
  for (const f of files) {
    let text = ""; try { text = tail(f); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue; // partial first line after the byte-offset cut
      let o: Record<string, unknown>;
      try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const lvl = Number(o.level);
      if (!Number.isFinite(lvl) || lvl < minLevel) continue;
      const level = LEVEL_NAME[lvl] ?? "error";
      const msg = String(o.msg ?? "(no message)");
      const errRaw = o.err ?? o.error ?? o.reason;
      const detail = errRaw == null ? undefined : (typeof errRaw === "string" ? errRaw : JSON.stringify(errRaw)).split("\n")[0].slice(0, 300);
      const component = String(o.role ?? o.service ?? "system");
      const when = String(o.time ?? new Date().toISOString());
      const iso = /^\d+$/.test(when) ? new Date(Number(when)).toISOString() : when;
      const category: Problem["category"] = CONFIG_STATE.some((re) => re.test(msg)) ? "config" : "fault";
      const key = `${level}|${component}|${signature(msg)}|${signature(detail ?? "")}`;
      const cur = byKey.get(key);
      if (cur) { cur.count++; if (iso > cur.lastSeen) cur.lastSeen = iso; if (iso < cur.firstSeen) cur.firstSeen = iso; }
      else byKey.set(key, { level, category, component, message: msg, detail, count: 1, firstSeen: iso, lastSeen: iso, active: false });
    }
  }
  // ACTIVE = seen in the recency window. A stopped fault must not read as a live alarm.
  const activeSince = new Date(Date.now() - (opts.activeWindowMs ?? 5 * 60_000)).toISOString();
  for (const p of byKey.values()) p.active = p.lastSeen >= activeSince;
  const rank = { fatal: 0, error: 1, warn: 2 };
  const all = [...byKey.values()].sort((a, b) => Number(b.active) - Number(a.active) || rank[a.level] - rank[b.level] || b.lastSeen.localeCompare(a.lastSeen) || b.count - a.count);
  const limit = opts.limit ?? 120;
  return { problems: all.filter((p) => p.category === "fault").slice(0, limit), configStates: all.filter((p) => p.category === "config").slice(0, 20), scannedFiles: files };
}
