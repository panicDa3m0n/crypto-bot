import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * DB-FIRST BOUNDARY ENFORCEMENT (architectural invariant, not a unit test).
 *
 * Ownership rule (decided): INDEXER decodes block events → DB; ENRICHMENT completes/refreshes what the
 * block doesn't contain → DB; READ-SIDE reasons EXCLUSIVELY on the DB; only PREFLIGHT/EXECUTION touch the
 * chain. So the read-side reasoning core must never make a chain-RPC call — "RPC cost ≈ network changes,
 * not #strategies". Third-party HTTP (Gecko/Dexscreener/…) is out of scope (the invariant is chain-RPC).
 *
 * This test scans the read-side reasoning dirs for chain-RPC call patterns and fails if any appear, so a
 * regression can't slip in silently. A genuine execution/compiler/preflight seam inside these dirs can
 * opt out per-line with a `// db-first-allow: <reason>` comment (there are none today). Harnesses live in
 * src/scripts (excluded); execution/preflight live in primitives.ts / chain.ts (excluded).
 */

// Read-side reasoning core. Extend deliberately (sensors/registries are sanctioned StateRefreshers —
// classify before adding). src/kg = the stateful kernel; src/router = local routing/quote/compile.
const READ_SIDE_DIRS = ["src/kg", "src/router"];

// Chain-RPC call patterns (viem client methods + our precision helper). NOT the `BerachainClients` TYPE
// import (typing a param is not a call). External HTTP is intentionally absent.
const FORBIDDEN: Array<{ re: RegExp; what: string }> = [
  { re: /\.readContract\s*\(/, what: "readContract" },
  { re: /\.simulateContract\s*\(/, what: "simulateContract" },
  { re: /\.multicall\s*\(/, what: "multicall" },
  { re: /\.getBlockNumber\s*\(/, what: "getBlockNumber" },
  { re: /\.getGasPrice\s*\(/, what: "getGasPrice" },
  { re: /\.getBlock\s*\(/, what: "getBlock" },
  { re: /\.getBalance\s*\(/, what: "getBalance" },
  { re: /\.getLogs\s*\(/, what: "getLogs" },
  { re: /\.getTransactionCount\s*\(/, what: "getTransactionCount" },
  { re: /\.getTransactionReceipt\s*\(/, what: "getTransactionReceipt" },
  { re: /\.waitForTransactionReceipt\s*\(/, what: "waitForTransactionReceipt" },
  { re: /\.sendTransaction\s*\(/, what: "sendTransaction" },
  { re: /\.estimateGas\s*\(/, what: "estimateGas" },
  { re: /\.precisionRead\s*\(/, what: "precisionRead" }
];
const ALLOW = /db-first-allow/;

function tsFiles(dir: string): string[] {
  const abs = join(process.cwd(), dir);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(abs, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(join(dir, e)));
    else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(join(dir, e));
  }
  return out;
}

describe("DB-first boundary", () => {
  it("the read-side reasoning core makes no chain-RPC calls", () => {
    const violations: string[] = [];
    for (const dir of READ_SIDE_DIRS) {
      for (const rel of tsFiles(dir)) {
        const lines = readFileSync(join(process.cwd(), rel), "utf8").split("\n");
        lines.forEach((line, i) => {
          if (ALLOW.test(line)) return;
          for (const f of FORBIDDEN) if (f.re.test(line)) violations.push(`${rel}:${i + 1}  [${f.what}]  ${line.trim().slice(0, 90)}`);
        });
      }
    }
    expect(
      violations,
      `Chain-RPC on the read-side reasoning core. Move the read to the indexer/enricher (DB-first), or — for a genuine execution/preflight seam — mark the line with "// db-first-allow: <reason>":\n${violations.join("\n")}`
    ).toEqual([]);
  });
});
