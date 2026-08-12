import { describe, expect, it } from "vitest";
import { addressesMatch, bexContext } from "../src/bex.js";

describe("BEX discovery integrity", () => {
  it("compares API and on-chain token sets without casing or order artifacts", () => {
    expect(addressesMatch(["0xAb", "0xCd", "0xAb"], ["0xcd", "0xab"])).toBe(true);
    expect(addressesMatch(["0xab"], ["0xcd"])).toBe(false);
  });

  it("does not present uncollected BEX data as a market signal", () => {
    expect(bexContext(undefined)).toMatchObject({ status: "not-collected" });
  });
});
