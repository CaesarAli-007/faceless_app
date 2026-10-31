import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { assembleImagePrompt } from "./promptAssembly";
import { generatedScriptSchema } from "./scriptSchema";
import { generateCountSchema } from "./schemas";
import { generationPlan, upcomingPublishSlots } from "./schedule";
import { alignScenes, groupCaptions } from "./timing";
import { buildBuiltinScript } from "../server/providers/script";
import { nicheByKey } from "./niches";
import { scriptFromPrompt } from "./promptScript";
import { countWords } from "./utils";

describe("script schema", () => {
  it("rejects a short scene list", () => {
    const parsed = generatedScriptSchema.safeParse({
      topic: "A door",
      title: "A door",
      description: "A door that should not be open tonight at all.",
      hashtags: ["a", "b", "c", "d", "e"],
      styleBible: "A consistent dark hallway and one coat.",
      scenes: [{ narration: "Hi", imagePrompt: "A dark hallway with one coat" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts an unbounded batch size", () => {
    expect(generateCountSchema.safeParse({ count: 50 }).success).toBe(true);
    expect(generateCountSchema.safeParse({ count: 500 }).success).toBe(true);
    expect(generateCountSchema.safeParse({ count: 0 }).success).toBe(false);
    expect(generateCountSchema.safeParse({}).success).toBe(true);
  });
});

describe("builtin scripts", () => {
  it("hits the word range and schema for every niche", () => {
    for (const key of ["scary-stories", "history", "greek-mythology", "true-crime", "kids-stories", "custom"]) {
      const niche = nicheByKey(key);
      const script = buildBuiltinScript({
        niche,
        minSec: 30,
        maxSec: 40,
        pastTopics: [],
        languageName: "English",
        customNichePrompt: key === "custom" ? "Quiet stories about night-shift radio hosts" : null,
        variant: 0,
      });
      expect(generatedScriptSchema.safeParse(script).success).toBe(true);
      const words = countWords(script.scenes.map((scene) => scene.narration).join(" "));
      expect(words).toBeGreaterThanOrEqual(79);
      expect(words).toBeLessThanOrEqual(96);
      expect(countWords(script.scenes[0]!.narration)).toBeLessThanOrEqual(12);
      expect(script.scenes.length).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("prompt reels", () => {
  it("speaks a written explanation instead of replacing it", () => {
    const prompt =
      "Black holes form when a massive star runs out of fuel. The core collapses under its own weight. Gravity becomes so strong that even light cannot escape. The edge of that darkness is called the event horizon.";
    const script = scriptFromPrompt(prompt);
    const spoken = script.scenes.map((scene) => scene.narration).join(" ");
    expect(spoken.toLowerCase()).toContain("event horizon");
    expect(spoken.toLowerCase()).not.toContain("the line to keep");
    expect(script.scenes.length).toBeGreaterThanOrEqual(4);
    expect(script.scenes.every((scene) => scene.imagePrompt.length >= 10)).toBe(true);
  });

  it("turns a short brief into a speakable reel", () => {
    const script = scriptFromPrompt("Why leaves change color in autumn");
    expect(generatedScriptSchema.safeParse(script).success).toBe(true);
    expect(script.scenes.length).toBeGreaterThanOrEqual(4);
    expect(countWords(script.scenes[0]!.narration)).toBeLessThanOrEqual(12);
    expect(script.scenes[0]!.narration.toLowerCase()).toContain("leaves");
  });

  it("prefers a drafted voiceover when it is long enough", () => {
    const script = scriptFromPrompt("How glass is made", {
      title: "How glass is made",
      scenes: [
        { narration: "Glass starts as sand.", search: "sand dune closeup" },
        { narration: "The sand is heated until it melts.", search: "molten glass furnace" },
        { narration: "Workers gather a glowing blob on a pipe.", search: "glassblower furnace" },
        { narration: "A breath inflates it into a hollow form.", search: "glassblowing bubble" },
        { narration: "The shape cools into something you can hold.", search: "clear glass bottle" },
      ],
    });
    expect(script.title).toBe("How glass is made");
    expect(script.scenes.map((scene) => scene.narration).join(" ")).toContain("glowing blob");
    expect(script.scenes[1]?.imagePrompt.toLowerCase()).toContain("molten glass");
  });
});

describe("captions and scene timing", () => {
  it("breaks early on punctuation", () => {
    const words = [
      { word: "Hello,", startMs: 0, endMs: 200 },
      { word: "world", startMs: 200, endMs: 400 },
      { word: "today.", startMs: 400, endMs: 700 },
      { word: "Listen", startMs: 700, endMs: 900 },
    ];
    const pages = groupCaptions(words, 4);
    expect(pages.map((page) => page.text)).toEqual(["Hello,", "world today.", "Listen"]);
  });

  it("aligns equal word counts onto timings", () => {
    const words = ["one", "two", "three", "four"].map((word, index) => ({
      word,
      startMs: index * 1000,
      endMs: index * 1000 + 800,
    }));
    const aligned = alignScenes([{ narration: "one two" }, { narration: "three four" }], words, 4000);
    expect(aligned[0]).toEqual({ startMs: 0, endMs: 1800 });
    expect(aligned[1]?.startMs).toBe(2000);
    expect(aligned[1]?.endMs).toBe(3800);
  });
});

describe("prompt assembly", () => {
  it("appends style, niche guidance, and the no-text rule", () => {
    const prompt = assembleImagePrompt({
      imagePrompt: "A lone coat on a chair",
      styleBible: "Same wool coat, same narrow hall",
      artSuffix: "dark gritty comic art",
      nicheAddendum: "moonlight and deep shadows",
    });
    expect(prompt).toContain("A lone coat on a chair");
    expect(prompt).toContain("dark gritty comic art");
    expect(prompt).toContain("moonlight and deep shadows");
    expect(prompt.endsWith("vertical 9:16 composition, no text, no watermark")).toBe(true);
  });
});

describe("schedule slots", () => {
  it("keeps a New York morning on the correct side of the spring-forward", () => {
    const before = upcomingPublishSlots({
      now: new Date("2026-03-07T12:00:00.000Z"),
      timezone: "America/New_York",
      publishTimes: ["09:00"],
      publishDays: [0, 1, 2, 3, 4, 5, 6],
      leadHours: 3,
    });
    expect(before.map((slot) => slot.toISOString())).toEqual(["2026-03-07T14:00:00.000Z"]);

    const after = upcomingPublishSlots({
      now: new Date("2026-03-08T12:00:00.000Z"),
      timezone: "America/New_York",
      publishTimes: ["09:00"],
      publishDays: [0, 1, 2, 3, 4, 5, 6],
      leadHours: 3,
    });
    expect(after.map((slot) => slot.toISOString())).toEqual(["2026-03-08T13:00:00.000Z"]);
  });

  it("skips a clock time that does not exist on the spring-forward morning", () => {
    const slots = upcomingPublishSlots({
      now: new Date("2026-03-08T05:30:00.000Z"),
      timezone: "America/New_York",
      publishTimes: ["02:30"],
      publishDays: [0],
      leadHours: 6,
    });
    expect(slots).toEqual([]);
  });

  it("filters by weekday and plans the lead window", () => {
    const sunday = DateTime.fromISO("2026-03-08T13:00:00", { zone: "America/New_York" });
    expect(sunday.weekday % 7).toBe(0);
    const slots = upcomingPublishSlots({
      now: new Date("2026-03-09T12:00:00.000Z"),
      timezone: "UTC",
      publishTimes: ["13:00"],
      publishDays: [0],
      leadHours: 160,
    });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => DateTime.fromJSDate(slot, { zone: "utc" }).weekday % 7 === 0)).toBe(true);
    const plan = generationPlan(new Date("2026-03-10T18:00:00.000Z"), new Date("2026-03-10T10:00:00.000Z"), 6);
    expect(plan.runAfter.toISOString()).toBe("2026-03-10T12:00:00.000Z");
    const immediate = generationPlan(new Date("2026-03-10T10:20:00.000Z"), new Date("2026-03-10T10:00:00.000Z"), 6);
    expect(immediate.runAfter.toISOString()).toBe("2026-03-10T10:00:00.000Z");
  });
});
