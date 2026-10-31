import { z } from "zod";
import { ART_STYLES } from "./artStyles";
import { captionStyleSchema } from "./caption";
import { EFFECTS } from "./effects";
import { LANGUAGES } from "./languages";
import { NICHES } from "./niches";

const durationPairs = [
  [20, 30],
  [30, 40],
  [40, 60],
  [60, 90],
] as const;

export const seriesWriteSchema = z
  .object({
    name: z.string().trim().min(1, "Series name is required").max(80),
    nicheKey: z.string(),
    customNichePrompt: z.string().optional().nullable(),
    language: z.string(),
    voiceId: z.string().min(1, "Pick a voice"),
    musicTrackIds: z.array(z.string()),
    artStyleKey: z.string(),
    captionStyle: captionStyleSchema,
    effects: z.array(z.string()),
    durationMinSec: z.number().int(),
    durationMaxSec: z.number().int(),
    timezone: z.string().min(1),
    publishTimes: z.array(z.string().regex(/^\d{2}:\d{2}$/, "Use HH:mm")).min(1, "Add a publish time"),
    publishDays: z.array(z.number().int().min(0).max(6)).min(1, "Pick at least one day"),
    leadHours: z.number().int().min(1).max(24),
    autoApprove: z.boolean(),
    autoPublish: z.boolean(),
    accountIds: z.array(z.string()),
    generateNow: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (!NICHES.some((niche) => niche.key === value.nicheKey)) {
      ctx.addIssue({ code: "custom", path: ["nicheKey"], message: "Unknown niche" });
    }
    if (value.nicheKey === "custom" && (value.customNichePrompt ?? "").trim().length < 8) {
      ctx.addIssue({
        code: "custom",
        path: ["customNichePrompt"],
        message: "Describe the kind of stories you want",
      });
    }
    if (!LANGUAGES.some((language) => language.code === value.language)) {
      ctx.addIssue({ code: "custom", path: ["language"], message: "Unknown language" });
    }
    if (!ART_STYLES.some((style) => style.key === value.artStyleKey)) {
      ctx.addIssue({ code: "custom", path: ["artStyleKey"], message: "Unknown art style" });
    }
    const knownEffects = new Set(EFFECTS.map((effect) => effect.key));
    if (value.effects.some((effect) => !knownEffects.has(effect))) {
      ctx.addIssue({ code: "custom", path: ["effects"], message: "Unknown effect" });
    }
    const pairOk = durationPairs.some(([min, max]) => min === value.durationMinSec && max === value.durationMaxSec);
    if (!pairOk) {
      ctx.addIssue({ code: "custom", path: ["durationMinSec"], message: "Pick a duration range" });
    }
  });

export type SeriesWrite = z.infer<typeof seriesWriteSchema>;

export const generateCountSchema = z.object({
  count: z.number().int().positive().optional(),
});

export const videoPatchSchema = z.object({
  title: z.string().min(1).max(80).optional(),
  description: z.string().min(1).max(2000).optional(),
  hashtags: z.array(z.string().min(1)).max(12).optional(),
  script: z
    .object({
      topic: z.string(),
      title: z.string(),
      description: z.string(),
      hashtags: z.array(z.string()),
      styleBible: z.string(),
      scenes: z.array(z.object({ narration: z.string().min(1), imagePrompt: z.string().min(1) })),
    })
    .optional(),
});

export const rerenderSchema = z.object({
  respeak: z.boolean().optional(),
});

export const bulkVideoSchema = z.object({
  action: z.enum(["approve", "delete", "regenerate"]),
  ids: z.array(z.string().min(1)).min(1),
});

export const settingPatchSchema = z.object({
  timezone: z.string().min(1).optional(),
});

export const reelPromptSchema = z.object({
  prompt: z.string().trim().min(8, "Describe the reel in at least a few words.").max(2000, "Keep the prompt under 2000 characters."),
});
