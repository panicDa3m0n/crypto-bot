import { describe, expect, it } from "vitest";
import { decodeAbiString, portfolioContext } from "../src/portfolio.js";

describe("portfolio ABI decoding and context", () => {
  it("decodes both standard dynamic and bytes32 ERC-20 symbols", () => {
    const dynamic = `0x${"20".padStart(64, "0")}${"5".padStart(64, "0")}${Buffer.from("HONEY").toString("hex").padEnd(64, "0")}`;
    const bytes32 = `0x${Buffer.from("iBGT").toString("hex").padEnd(64, "0")}`;
    expect(decodeAbiString(dynamic)).toBe("HONEY");
    expect(decodeAbiString(bytes32)).toBe("iBGT");
  });

  it("does not fabricate a portfolio when no real snapshot has been collected", () => {
    expect(portfolioContext(undefined)).toMatchObject({ status: "not-collected" });
  });
});
