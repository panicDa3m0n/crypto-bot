/** Converts RPC payloads (which contain bigint values) into PostgreSQL JSON-safe data. */
export function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, current) => {
    if (typeof current === "bigint") return current.toString();
    // PostgreSQL cannot store a NUL byte in text OR in jsonb, and chain-derived strings (a token's name or
    // symbol) are attacker-controlled — anyone can deploy a contract whose name contains one. The whole
    // statement then fails, and because these writes are non-fatal by design the row was silently never
    // written. Stripping here covers every jsonb write at once, rather than at each of the call sites.
    if (typeof current === "string" && current.includes("\u0000")) return current.replace(/\u0000/g, "");
    return current;
  }));
}
