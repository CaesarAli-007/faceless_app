import { generatedScriptSchema, type GeneratedScript } from "./scriptSchema";
import { countWords } from "./utils";

export type PromptDraft = {
  title?: string;
  character?: string;
  scenes?: { narration?: string; search?: string; action?: string }[];
};

const STOP = new Set(
  "a an the and or of to for in on with from that this is are was were be been being it its your you we they their them our i me my why how what when where who which into about over under after before just than then so if but not no yes please make create write explain reel reels video videos short shorts voiceover caption captions".split(
    " ",
  ),
);

function tidy(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number) {
  const clean = tidy(text);
  if (clean.length <= max) return clean;
  const sliced = clean.slice(0, max - 1).replace(/\s+\S*$/, "").trim();
  return sliced.length >= 3 ? sliced : clean.slice(0, max).trim();
}

function clipWords(text: string, max: number) {
  return tidy(text)
    .replace(/[.?!]+$/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, max)
    .join(" ");
}

export function speakable(text: string) {
  let line = tidy(text).replace(/^["']+|["']+$/g, "");
  if (!line) return "Watch this closely.";
  line = line.charAt(0).toUpperCase() + line.slice(1);
  if (!/[.!?]$/.test(line)) line += ".";
  return line;
}

function wordsOf(text: string) {
  return tidy(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word));
}

export function searchFromLine(line: string, topic: string) {
  const fromLine = wordsOf(line).slice(0, 4);
  const fromTopic = wordsOf(topic);
  const picked = (fromLine.length >= 2 ? fromLine : [...fromLine, ...fromTopic]).slice(0, 4);
  return picked.join(" ") || "open landscape";
}

function splitInHalf(sentence: string): [string, string] | null {
  const words = tidy(sentence).replace(/[.?!]+$/g, "").split(/\s+/).filter(Boolean);
  if (words.length < 8) return null;
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

function splitLong(sentence: string): string[] {
  const parts = [tidy(sentence)];
  let guard = 0;
  while (guard < 8) {
    const index = parts.findIndex((part) => countWords(part) > 18);
    if (index < 0) break;
    const split = splitInHalf(parts[index]!);
    if (!split) break;
    parts.splice(index, 1, split[0], split[1]);
    guard += 1;
  }
  return parts.filter(Boolean);
}

function chunkNarration(text: string) {
  const sentences = tidy(text)
    .split(/(?<=[.!?])\s+/)
    .map(tidy)
    .filter(Boolean);
  let parts = (sentences.length ? sentences : [tidy(text)]).flatMap(splitLong);
  while (parts.length > 12) {
    const next = parts.pop()!;
    const prev = parts.pop()!;
    parts.push(`${prev.replace(/[.?!]+$/g, "")}. ${next}`);
  }
  let guard = 0;
  while (parts.length < 4 && guard < 8) {
    const index = parts.reduce((best, part, partIndex, all) => (countWords(part) > countWords(all[best] ?? "") ? partIndex : best), 0);
    const split = splitInHalf(parts[index] ?? "");
    if (!split) break;
    parts.splice(index, 1, split[0], split[1]);
    guard += 1;
  }
  return parts.map(speakable);
}

function stripLead(prompt: string) {
  return tidy(prompt)
    .replace(/^(please\s+)?(make|create|write|generate)\s+(me\s+)?(a\s+)?(short\s+)?(reel|video|short)\s+(about|on|explaining)?\s*/i, "")
    .replace(/^(please\s+)?explain\s+/i, "")
    .replace(/^(a|an|the)\s+/i, "")
    .replace(/,?\s*(in plain language|keep it plain|calm and short|about thirty seconds|for someone who.+|no jargon)\b/gi, "")
    .replace(/\s+,/g, ",")
    .replace(/,+/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function explainBrief(prompt: string) {
  const idea = stripLead(prompt).replace(/[.?!]+$/g, "").trim() || tidy(prompt);
  const subject = idea.charAt(0).toUpperCase() + idea.slice(1);
  const hook = clipWords(subject, 10);
  const lines = [
    hook,
    `Here is the plain version of ${clipWords(idea, 8)}.`,
    `${subject} starts with one thing you can point at.`,
    "Look at that first, before the explanation.",
    "Then follow the one change that matters.",
    `Stay on ${clipWords(idea, 6)}, and leave the side stories out.`,
    "Say it the way you would tell a friend.",
    `The line to keep is ${clipWords(idea, 8)}.`,
  ];
  return lines.map((narration) => ({ narration: speakable(narration), search: searchFromLine(narration, idea) }));
}

function draftScenes(draft: PromptDraft | undefined) {
  const scenes = (draft?.scenes ?? [])
    .map((scene) => ({
      narration: tidy(scene.narration ?? ""),
      search: tidy(scene.action || scene.search || ""),
    }))
    .filter((scene) => countWords(scene.narration) > 0);
  const words = countWords(scenes.map((scene) => scene.narration).join(" "));
  if (words < 24) return null;
  if (scenes.length < 4) {
    const spoken = chunkNarration(scenes.map((scene) => scene.narration).join(" "));
    if (spoken.length < 4) return null;
    return spoken.map((narration) => ({ narration, search: scenes[0]?.search || "" }));
  }
  let parts = scenes.flatMap((scene) => splitLong(scene.narration).map((narration) => ({ narration, search: scene.search })));
  while (parts.length > 12) {
    const next = parts.pop()!;
    const prev = parts.pop()!;
    parts.push({
      narration: `${prev.narration.replace(/[.?!]+$/g, "")}. ${next.narration}`,
      search: prev.search || next.search,
    });
  }
  return parts.map((scene) => ({ narration: speakable(scene.narration), search: scene.search }));
}

function tagsFrom(text: string) {
  const unique = [...new Set(wordsOf(text))].slice(0, 4);
  for (const extra of ["shorts", "reels", "explained", "storytime", "facts"]) {
    if (unique.length >= 6) break;
    if (!unique.includes(extra)) unique.push(extra);
  }
  return unique.slice(0, 6);
}

function imagePromptFor(search: string, narration: string, topic: string) {
  const action = tidy(search) || searchFromLine(narration, topic);
  const phrase = action.length >= 8 ? action : searchFromLine(`${action} ${narration}`, topic);
  const prompt = `Professional photograph of ${phrase}. Photorealistic workplace, natural light, real people in business attire, navy and red accents, vertical framing, no cartoon, no illustration, no text, no logos, no watermark`;
  return prompt.length >= 10 ? prompt : "Professional photograph of a modern workplace, natural light, no cartoon, no text";
}

function spokenOnce(narration: string) {
  let line = tidy(narration);
  line = line.split(/\.\s+In other words,\s+/i)[0] ?? line;
  line = line.replace(/^(in other words|once more),\s+/i, "");
  return speakable(line);
}

function narrationKey(narration: string) {
  return spokenOnce(narration)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeScenes(scenes: { narration: string; search: string }[]) {
  const seen = new Set<string>();
  const unique: { narration: string; search: string }[] = [];
  for (const scene of scenes) {
    const narration = spokenOnce(scene.narration);
    const key = narrationKey(narration);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push({ narration, search: scene.search });
  }
  return unique;
}

export function scriptFromPrompt(prompt: string, draft?: PromptDraft): GeneratedScript {
  const clean = tidy(prompt);
  if (clean.length < 8) throw new Error("Describe the reel in at least a few words.");
  const userLines = chunkNarration(clean);
  const userScenes = dedupeScenes(
    userLines.length >= 4 ? userLines.map((narration) => ({ narration, search: "" })) : explainBrief(clean),
  );
  const drafted = dedupeScenes(draftScenes(draft) ?? []);
  const base = userLines.length >= 4 ? userScenes : drafted.length >= 4 ? drafted : userScenes;
  const scenes = dedupeScenes(base);
  if (scenes.length < 4) throw new Error("Describe the reel in a few full sentences.");
  const idea = stripLead(clean) || clean;
  const titleSource = (userLines.length >= 4 ? "" : tidy(draft?.title ?? "")) || scenes[0]?.narration.replace(/[.?!]+$/g, "") || idea;
  const title = clip(titleSource, 80);
  const description = clip(clean.length >= 10 ? clean : `${clean} A short professional video.`, 240);
  const script: GeneratedScript = {
    topic: clip(idea, 140),
    title: title.length >= 3 ? title : clip(idea, 80),
    description,
    hashtags: tagsFrom(`${idea} ${scenes.map((scene) => scene.narration).join(" ")}`),
    styleBible:
      "Realistic professional photographs in every scene. Modern workplace, natural light, real people, navy and red accents. No cartoons, no illustrations, no text, no logos.",
    scenes: scenes.map((scene) => ({
      narration: scene.narration,
      imagePrompt: imagePromptFor(scene.search, scene.narration, idea),
    })),
  };
  const parsed = generatedScriptSchema.safeParse(script);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data;
}
