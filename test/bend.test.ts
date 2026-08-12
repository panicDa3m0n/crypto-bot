import { describe, expect, it } from "vitest";
import { calculateHealthFactorWad } from "../src/bend.js";

describe("Bend health factor", () => {
  it("uses Morpho Blue's fixed 1e36 oracle scale", () => {
    // Real WBTC/HONEY position and oracle values observed on Berachain mainnet.
    const health = calculateHealthFactorWad(
      177091974n,
      640219640318513757496745609470875069697986615124753n,
      860000000000000000n,
      75320098895649467309711n
    );
    expect(health).toBe(1294539902914903708n);
    expect(health! > 10n ** 18n).toBe(true);
  });
});
