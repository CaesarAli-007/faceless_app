import { describe, expect, it } from "vitest";
import { edgeTimeoutMs } from "./tts";
import { generateSecMsGecV2 } from "./edgeDrm";

describe("edge Sec-MS-GEC v2", () => {
  it("matches the edge-tts 7.3.1 tokens for fixed timestamps", () => {
    expect(generateSecMsGecV2(1700000000)).toBe(
      "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
    );
    expect(generateSecMsGecV2(1761170000)).toBe(
      "67E3AEC602F5E1F4-475875386968E260A057334E8533455267A324A6228C4704FA0E779C5CF0A0C8",
    );
    expect(generateSecMsGecV2(1761173800.5)).toBe(
      "0DAE1C084292CCA8-D085A63716552C7C3A497C4FAFE035E87978EAAD23DF382E9F5D88101F510ABB",
    );
  });
});

describe("edge timeout", () => {
  it("gives a long script more than a minute", () => {
    expect(edgeTimeoutMs("one two three")).toBe(45_000);
    expect(edgeTimeoutMs(Array.from({ length: 270 }, () => "word").join(" "))).toBe(236_000);
    expect(edgeTimeoutMs(Array.from({ length: 400 }, () => "word").join(" "))).toBe(240_000);
  });
});
