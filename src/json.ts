/** Converts RPC payloads (which contain bigint values) into PostgreSQL JSON-safe data. */
export function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, current) => typeof current === "bigint" ? current.toString() : current));
}
