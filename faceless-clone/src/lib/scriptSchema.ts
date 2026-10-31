import { z } from "zod";

export const generatedScriptSchema = z.object({
  topic: z.string().min(3),
  title: z.string().min(3).max(80),
  description: z.string().min(10),
  hashtags: z.array(z.string().min(1)).min(5).max(8),
  styleBible: z.string().min(10),
  scenes: z
    .array(
      z.object({
        narration: z.string().min(1),
        imagePrompt: z.string().min(10),
      }),
    )
    .min(4)
    .max(12),
});

export type GeneratedScript = z.infer<typeof generatedScriptSchema>;

export function normalizeScriptShape(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const record = input as Record<string, unknown>;
  const hashtags = Array.isArray(record.hashtags) ? record.hashtags : [];
  const cleaned = hashtags
    .map((tag) => (typeof tag === "string" ? tag.replace(/^#/, "").trim() : ""))
    .filter(Boolean)
    .slice(0, 8);
  const title = typeof record.title === "string" ? record.title.trim().slice(0, 80) : record.title;
  return { ...record, title, hashtags: cleaned };
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return a JSON object.");
  return JSON.parse(raw.slice(start, end + 1)) as unknown;
}
