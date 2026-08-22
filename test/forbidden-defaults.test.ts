import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * FORBIDDEN DEFAULTS (architectural invariant, not a unit test).
 *
 * The standing rule is that a missing datum is ENRICHMENT WORK, never something to paper over with a
 * plausible number. Fail-closed is the safety net while the datum is missing; a silent default is a bug that
 * HIDES the hole — it turns "we don't know" into a confident answer, and on a strategy whose edge is basis
 * points that is worse than no answer at all.
 *
 * The rule existed and was written down. It came back anyway: `fee || 3000` reappeared in eight production
 * sites and `decimals ?? 18` in five, because a rule with no test is a rule that decays. This file is that
 * test. It scans the decision-making source for the patterns and fails if any returns.
 *
 * A genuine exception can opt out on its line with `// default-allow: <reason>` — deliberately noisy, so an
 * exception is a decision someone made and can be found later, not something that slipped in.
 */

const SCANNED_DIRS = ["src/kg", "src/router", "src"];
const SKIP_DIRS = new Set(["scripts", "node_modules", "dist", "prompts", "strategy"]);
const SKIP_FILES = new Set(["archetypes.ts"]); // where the canonical constants legitimately live

const RULES: Array<{ name: string; re: RegExp; why: string }> = [
  {
    name: "invented swap fee",
    // Anchored on a FEE identifier: `blocks ?? 3000` is a block count, not a fee, and a rule that cries wolf
    // gets disabled. Catches both the `||`/`??` fallback and the `cond ? x : 3000` ternary form.
    re: /\b\w*[Ff]ee\w*\b[^;\n]{0,40}(\|\||\?\?|:)\s*3000n?\b/,
    why: "a pool that cannot state its fee must not be quoted — use resolveFeePpm() and fail closed",
  },
  {
    name: "invented token decimals",
    re: /decimals\s*(\?\?|\|\|)\s*18\b|(\?\?|\|\|)\s*18\s*\)\s*\)?\s*;?\s*\/\/\s*decimals/i,
    why: "decimals come from the entities registry; guessing 18 silently mis-scales every amount by up to 10^12",
  },
  {
    name: "duplicated fee-tier table",
    re: /FEE_TO_SPACING\s*[:=]/,
    why: "tickSpacing has ONE source of truth (archetypes.tickSpacingFor); four copies had already diverged",
  },
  {
    name: "duplicated archetype set",
    re: /const\s+(CONC|MODELABLE|CP_ARCH)\s*=\s*new Set/,
    why: "archetype capabilities have ONE source of truth (src/archetypes.ts); twelve copies drifted into five different answers",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (!SKIP_DIRS.has(e)) walk(p, out); }
    else if (e.endsWith(".ts") && !SKIP_FILES.has(e)) out.push(p);
  }
  return out;
}

describe("forbidden defaults never come back", () => {
  const files = [...new Set(SCANNED_DIRS.flatMap((d) => walk(d)))];

  it("scans a real, non-trivial part of the source", () => {
    expect(files.length).toBeGreaterThan(20); // guards against the scan silently matching nothing
  });

  for (const rule of RULES) {
    it(`no ${rule.name}`, () => {
      const hits: string[] = [];
      for (const f of files) {
        const lines = readFileSync(f, "utf8").split("\n");
        lines.forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith("*") || t.startsWith("/*") || t.startsWith("//")) return; // documentation, not code
          const code = line.split("//")[0];
          if (!rule.re.test(code)) return;
          if (/default-allow:/.test(line)) return;        // explicit, findable exception
          hits.push(`${f}:${i + 1}  ${line.trim().slice(0, 110)}`);
        });
      }
      expect(hits, `${rule.why}\n${hits.join("\n")}`).toEqual([]);
    });
  }
});
