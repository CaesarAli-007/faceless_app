import type { NicheProfile } from "../../lib/niches";
import { scriptFromPrompt, type PromptDraft } from "../../lib/promptScript";
import { extractJson, generatedScriptSchema, normalizeScriptShape, type GeneratedScript } from "../../lib/scriptSchema";
import { countWords, sceneCount, wordRange } from "../../lib/utils";
import { scriptSystemPrompt } from "../pipeline/prompts";

export type BuiltinInput = {
  niche: NicheProfile;
  minSec: number;
  maxSec: number;
  pastTopics: string[];
  languageName: string;
  customNichePrompt?: string | null;
  variant?: number;
  repairNote?: string;
};

const PADS = [
  "Look closer.",
  "Wait one beat.",
  "Hold that picture still.",
  "Keep your eyes on the door.",
  "Hold that picture for one more breath.",
];

const POOLS: Record<string, string[]> = {
  "scary-stories": [
    "The hallway light is on again.",
    "You switched it off and heard the click.",
    "The bolt is open though you locked it.",
    "Inside, the air smells like rain.",
    "A chair faces the wall tonight.",
    "Your coat hangs there, still warm.",
    "A floorboard answers a step upstairs.",
    "You did not take that step.",
    "The mirror fogs when you breathe.",
    "A word appears and you wipe it.",
    "Your phone shows the hall without you.",
    "The chair has turned to face you.",
    "Something sits there and does not blink.",
    "The light clicks off by itself.",
    "You hear your name in the next room.",
    "The front door locks from the outside.",
    "Rain taps the glass, but the sky is clear.",
    "Your reflection lifts a hand first.",
    "The spare key is already missing.",
    "You smile in the photo you never took.",
    "The stairs end one step too soon.",
    "Do not answer when it knocks again.",
  ],
  history: [
    "A library burned. The index survived.",
    "One clerk copied the names anyway.",
    "The city stored its grain in stone.",
    "A river moved and the port went quiet.",
    "Soldiers stopped when the noon sky darkened.",
    "Paper outran every horse that week.",
    "The map hid a coastline on purpose.",
    "A tax, a road, and a rumor remained.",
    "The harbor silted shut in one lifetime.",
    "Salt paid for more than one army.",
    "A courier crossed the pass at night.",
    "The gate opened for the smaller force.",
    "They counted ships and missed the tide.",
    "A wall was built to turn the wind.",
    "The archive kept the losing side's letters.",
    "Someone moved the boundary stone at dusk.",
    "The new calendar skipped a market day.",
    "A bridge failed and the town changed hands.",
    "They buried the tools, not the plan.",
    "The record ends in the middle of a word.",
    "What lasted was the road, not the king.",
    "We still argue over who kept the key.",
  ],
  "greek-mythology": [
    "A weaver challenged the wrong goddess.",
    "The loom answered with a crueler scene.",
    "A musician sang at the underworld gate.",
    "He was told not to look back.",
    "He looked, and the path closed.",
    "Wax held a boy's wings together.",
    "Praise lifted him higher than the glue.",
    "The sea kept what the sky refused.",
    "A king served the gods a forbidden meal.",
    "The table has been hungry ever since.",
    "A thread led into the dark hall.",
    "It also led back, if you trusted it.",
    "The box was a jar, and it opened.",
    "Hope stayed behind on purpose.",
    "A hunter was written into the stars.",
    "His dogs still run the same circle.",
    "The ship wanted its name spoken aloud.",
    "Waves tested every boast they heard.",
    "A promise made to the tide came due.",
    "Olive leaves fell on a bronze shield.",
    "The hero won by refusing the fight.",
    "The gods do not forget a clever insult.",
  ],
  "historical-figures": [
    "The contradiction showed up before the fame.",
    "A child learned the port before the court.",
    "Letters left the city under a plain seal.",
    "One choice cost more than the victory.",
    "They published the mistake and kept going.",
    "A retreat saved the smaller army.",
    "The workshop light stayed on for years.",
    "Praise arrived after the useful work.",
    "A map was copied by a tired hand.",
    "The patient count changed the whole ward.",
    "Someone gave the machine away for nothing.",
    "The diary skips the famous afternoon.",
    "A runner carried news farther than orders.",
    "Shade mattered more than the height.",
    "The old coat still had road dust.",
    "Friends left. The practice did not.",
    "A signature moved a border by an inch.",
    "They ate simply on the night of the win.",
    "The last letter asks for no monument.",
    "What remains is the work, not the noise.",
    "History kept the result and lost the doubt.",
    "Stand where they stood and count the cost.",
  ],
  "true-crime": [
    "The public ledger did not match the vault.",
    "One night is missing from the log.",
    "A ticket was punched twice that evening.",
    "Three witnesses described three different doors.",
    "The stamp on the letter arrived early.",
    "A will changed hands, not handwriting.",
    "The radio call came before the alarm.",
    "Footprints walked up to a locked gate.",
    "The archive box was labeled empty.",
    "It was not empty.",
    "A courtroom clock ran seven minutes fast.",
    "Nobody photographed the second stairwell.",
    "The spare key had a fresh scratch.",
    "Records show a name and then a gap.",
    "The town paper printed the careful version.",
    "What was never named stays unnamed.",
    "A coat was checked and never collected.",
    "The timeline works until the last hour.",
    "Silence in the file is also evidence.",
    "The case closed. The question did not.",
    "Read the record. Do not invent the rest.",
    "Some doors in the story stay shut.",
  ],
  "stoic-motivation": [
    "You cannot argue the weather into mercy.",
    "So you do the next small thing.",
    "Fear can ride along. It does not drive.",
    "Praise is weather. Let it pass.",
    "That opinion was never yours to carry.",
    "Wait without letting the hour rot.",
    "A loss does not get the last word.",
    "Train the hour you can actually hold.",
    "Anger wants a speech. Decline it.",
    "Begin again where nobody is watching.",
    "The door in front of you still opens.",
    "You do not need a better past today.",
    "Put the tool back in your hand.",
    "Let other people rush the hallway.",
    "Your name is not the work.",
    "Keep the promise you made this morning.",
    "Rest is part of the discipline.",
    "Speak less than you repair.",
    "The obstacle is the assignment.",
    "When the noise rises, lower your pace.",
    "You can be steady without being stone.",
    "Start now. Start smaller if you must.",
  ],
  "good-morals": [
    "The extra coin sat on the counter.",
    "Nobody was watching the open drawer.",
    "A borrowed ladder had a weak rung.",
    "He fixed it before he brought it back.",
    "The last seat went to the tired stranger.",
    "An apology arrived late and still mattered.",
    "She shared the map, not only the meal.",
    "The rumor stopped in his mouth.",
    "What nobody saw was returned anyway.",
    "Help arrived without an audience.",
    "A promise was kept in the rain.",
    "He let someone else finish the story.",
    "The shortcut would have cost a friend.",
    "They told the truth while it was small.",
    "A door was held past the easy moment.",
    "Credit was handed back with the tool.",
    "The quiet choice was the brave one.",
    "Kindness did not ask to be filmed.",
    "They left the place better than found.",
    "The lesson fit in a single small act.",
    "You can still choose the harder right.",
    "That is the whole of the story.",
  ],
  "kids-stories": [
    "A fox found a berry basket.",
    "It was not his basket.",
    "He carried it back down the hill.",
    "A turtle waited for the slowest friend.",
    "The puddle was too wide for one mouse.",
    "Two mice built a leaf bridge.",
    "An owl shared the sunny branch.",
    "There was room after all.",
    "A rabbit asked for help and got it.",
    "The bear saved the bees' winter honey.",
    "He only took one taste.",
    "A crane did not laugh at short legs.",
    "The squirrel left some nuts behind.",
    "Someone else was still hungry.",
    "A lantern fish knew the dark path.",
    "She waited so nobody swam alone.",
    "The ducks followed the whale home.",
    "They said thank you in little splashes.",
    "Friends can be different and still kind.",
    "The forest felt bigger with company.",
    "Sharing made the road feel shorter.",
    "They got home before the stars came out.",
  ],
  custom: [
    "The story starts in the middle.",
    "A small object remembers more than people.",
    "The night shift kept a quiet log.",
    "One rule was never written down.",
    "Two strangers had the same spare key.",
    "The broadcast played a minute early.",
    "A letter arrived with the wrong year.",
    "The road changed its name overnight.",
    "An apprentice kept the useful secret.",
    "The contest hid its real prize.",
    "Someone left the light on for a reason.",
    "The map gained a street at dawn.",
    "They followed the sound, not the sign.",
    "A door opened onto the work itself.",
    "The rumor was wrong and still useful.",
    "Notes in the margin told the truth.",
    "The crowd looked the other way.",
    "One person stayed and finished the job.",
    "The pattern repeated every seventh night.",
    "What they built did not need a logo.",
    "The last line points back to the first.",
    "Tell it again, a little closer this time.",
  ],
};

const BIBLES: Record<string, string> = {
  "scary-stories":
    "The same narrow rented hallway, one wool coat, one wooden chair, one phone, moonlight through a single window, the same unnamed person seen from behind.",
  history:
    "The same dust-colored city, linen and wool clothing, stone streets, oil lamps, no modern objects, crowds of unnamed people seen at a distance.",
  "greek-mythology":
    "The same bronze-and-marble world, olive trees, one recurring hero in a plain cloak, gods shown as distant light rather than famous faces.",
  "historical-figures":
    "One recurring unnamed figure in period clothes, candlelight, paper, roads, and workrooms, never a copy of a famous portrait.",
  "true-crime":
    "Empty rooms, paper files, a clock, a hallway, rain on glass, no weapons, no injured people, no readable names.",
  "stoic-motivation":
    "One walker in a plain coat, stone paths, dawn light, the same landscape returning, no logos and no crowd.",
  "good-morals":
    "A small town street, warm daylight, ordinary clothes, the same two unnamed neighbors, clear hand gestures, no brands.",
  "kids-stories":
    "Soft storybook animals with consistent colors, a fox with a rust scarf, round shapes, bright leaves, no fear and no text.",
  custom:
    "One consistent setting taken from the viewer's niche, the same two unnamed people, a repeated prop, natural light, no logos.",
};

const TAGS: Record<string, string[]> = {
  "scary-stories": ["scarystories", "horrorstory", "creepypasta", "nightshift", "faceless", "storytime"],
  history: ["history", "historyfacts", "ancientworld", "onthisday", "faceless", "storytime"],
  "greek-mythology": ["mythology", "greekmyth", "myths", "legends", "faceless", "storytime"],
  "historical-figures": ["history", "biography", "historicalfigures", "oneminute", "faceless", "storytime"],
  "true-crime": ["truecrime", "coldcase", "publicrecord", "mystery", "faceless", "storytime"],
  "stoic-motivation": ["stoicism", "discipline", "mindset", "lifelessons", "faceless", "motivation"],
  "good-morals": ["lifelessons", "goodmorals", "kindness", "stories", "faceless", "storytime"],
  "kids-stories": ["kidsstories", "bedtimestory", "animals", "moralstory", "faceless", "storytime"],
  custom: ["faceless", "storytime", "shorts", "story", "viralvideo", "aitale"],
};

function join(lines: string[]) {
  return lines.join(" ");
}

function fitWords(sentences: string[], min: number, max: number) {
  let guard = 0;
  while (countWords(join(sentences)) < min && guard < 24) {
    const need = min - countWords(join(sentences));
    const pad = [...PADS].reverse().find((line) => countWords(line) <= need) ?? PADS[0]!;
    if (countWords(join(sentences)) + countWords(pad) > max) {
      const smaller = PADS.find((line) => countWords(join(sentences)) + countWords(line) <= max);
      if (!smaller) break;
      sentences.splice(Math.max(1, sentences.length - 1), 0, smaller);
    } else {
      sentences.splice(Math.max(1, sentences.length - 1), 0, pad);
    }
    guard += 1;
  }
  guard = 0;
  while (countWords(join(sentences)) > max && guard < 24) {
    const padAt = sentences.findIndex((line, index) => index > 0 && PADS.includes(line));
    if (padAt > 0) sentences.splice(padAt, 1);
    else if (sentences.length > 8) sentences.splice(sentences.length - 2, 1);
    else break;
    guard += 1;
  }
  return sentences;
}

function selectSentences(pool: string[], minWords: number, maxWords: number, scenes: number) {
  const chosen: string[] = [];
  for (const sentence of pool) {
    const nextCount = countWords(join([...chosen, sentence]));
    if (chosen.length >= scenes && countWords(join(chosen)) >= minWords && nextCount > maxWords) break;
    if (nextCount > maxWords && chosen.length >= Math.min(scenes, 8) && countWords(join(chosen)) >= minWords) break;
    chosen.push(sentence);
    if (chosen.length >= scenes && countWords(join(chosen)) >= minWords && countWords(join(chosen)) <= maxWords) break;
  }
  if (chosen.length === 0) chosen.push(pool[0] ?? "The story begins here.");
  return fitWords(chosen, minWords, maxWords);
}

function toScenes(sentences: string[], sceneTotal: number, topic: string) {
  const total = Math.min(12, Math.max(8, sceneTotal));
  const groups: string[][] = Array.from({ length: total }, () => []);
  groups[0] = [sentences[0] ?? "Watch closely."];
  const rest = sentences.slice(1);
  const slots = total - 1;
  rest.forEach((sentence, index) => {
    const bucket = slots === 0 ? 0 : Math.min(slots - 1, Math.floor((index * slots) / Math.max(1, rest.length)));
    groups[bucket + 1]!.push(sentence);
  });
  for (let index = 1; index < groups.length; index += 1) {
    if (groups[index]!.length === 0) {
      groups[index]!.push("The moment holds.");
    }
  }
  return groups.map((group) => {
    const narration = group.join(" ");
    const visual = narration.replace(/[^\p{L}\p{N}\s]/gu, "");
    return {
      narration,
      imagePrompt: `A single concrete moment showing ${visual}. Story context: ${topic}. One clear subject mid-action, eye-level camera, shallow depth of field, no written words, no logos, no watermark`,
    };
  });
}

export function buildBuiltinScript(input: BuiltinInput): GeneratedScript {
  const { minWords, maxWords } = wordRange(input.minSec, input.maxSec);
  const scenesWanted = sceneCount(input.minSec, input.maxSec);
  const pool = POOLS[input.niche.key] ?? POOLS.custom!;
  const unused =
    input.niche.topicExamples.find((topic) => !input.pastTopics.some((past) => past.toLowerCase() === topic.toLowerCase())) ??
    `${input.niche.topicExamples[(input.variant ?? 0) % input.niche.topicExamples.length]} (${input.pastTopics.length + 1})`;
  const topic =
    input.niche.key === "custom" && input.customNichePrompt?.trim()
      ? input.customNichePrompt.trim().slice(0, 80)
      : unused;
  const sentences = selectSentences(pool, minWords, maxWords, scenesWanted);
  const script: GeneratedScript = {
    topic,
    title: topic.length <= 80 ? topic : `${topic.slice(0, 77)}...`,
    description: `${topic}. A short faceless story. Watch until the last line.`,
    hashtags: TAGS[input.niche.key] ?? TAGS.custom!,
    styleBible:
      input.niche.key === "custom" && input.customNichePrompt
        ? `${BIBLES.custom} Niche note: ${input.customNichePrompt.trim().slice(0, 180)}`
        : (BIBLES[input.niche.key] ?? BIBLES.custom!),
    scenes: toScenes(sentences, scenesWanted, topic),
  };
  const parsed = generatedScriptSchema.safeParse(script);
  if (!parsed.success) {
    throw new Error(`Builtin script was invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

async function completeChat(system: string, user: string): Promise<string> {
  const provider = (process.env.SCRIPT_PROVIDER || "anthropic").toLowerCase();
  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is empty. Set it, or use SCRIPT_PROVIDER=builtin.");
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.8,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!response.ok) throw new Error(`OpenAI script request failed (${response.status}).`);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? "";
  }
  if (provider === "ollama") {
    const base = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    const response = await fetch(`${base.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || "llama3.1",
        stream: false,
        format: "json",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Ollama script request failed (${response.status}). Is Ollama running?`);
    const body = (await response.json()) as { message?: { content?: string } };
    return body.message?.content ?? "";
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is empty. Set it, or use SCRIPT_PROVIDER=ollama or builtin.");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
      max_tokens: 2500,
      temperature: 0.7,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!response.ok) throw new Error(`Anthropic script request failed (${response.status}).`);
  const body = (await response.json()) as { content?: { text?: string }[] };
  return body.content?.map((part) => part.text ?? "").join("\n") ?? "";
}

export async function rewriteImagePrompt(prompt: string): Promise<string> {
  const provider = (process.env.SCRIPT_PROVIDER || "builtin").toLowerCase();
  if (provider === "builtin" || provider === "") {
    return prompt
      .replace(/\b(blood|gore|corpse|kill|murder|gun|knife|wound)\b/gi, "shadow")
      .concat(", restrained and non-graphic, no injured people");
  }
  const text = await completeChat(
    "You rewrite image prompts to be less graphic while keeping the story beat. Return one sentence, no markdown.",
    `Make this visual less graphic, keep the story beat:\n${prompt}`,
  );
  return text.trim().replace(/^["']|["']$/g, "") || prompt;
}

const PROMPT_WRITER = `Return JSON only, no markdown:
{"title":"max 70 chars","scenes":[{"narration":"one short spoken sentence","search":"3 photo words"}]}
Write 6 scenes explaining the user's topic in plain speech, about 80 words total.
The first sentence is at most 12 words.
Each search is a real thing a camera can photograph.
If the user already wrote the sentences, keep their facts and do not add new ones.`;

async function promptWriter(prompt: string): Promise<string> {
  let lastError = "The writer was unavailable.";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch("https://text.pollinations.ai/openai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai",
        json: true,
        reasoning_effort: "low",
        max_tokens: 900,
        messages: [
          { role: "system", content: PROMPT_WRITER },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(40_000),
    });
    if (response.status === 402 && attempt === 0) {
      const detail = await response.text();
      const wait = Number(/retry after (\d+)/i.exec(detail)?.[1] ?? 20);
      await new Promise((resolve) => setTimeout(resolve, (Math.min(wait, 50) + 1) * 1000));
      continue;
    }
    if (!response.ok) {
      const detail = await response.text();
      lastError = `The writer failed (${response.status}). ${detail.slice(0, 180)}`;
      continue;
    }
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) {
      lastError = "The writer returned nothing.";
      continue;
    }
    return content;
  }
  throw new Error(lastError);
}

export async function generatePromptScript(prompt: string): Promise<{ script: GeneratedScript; source: "model" | "local" }> {
  try {
    const text = await promptWriter(prompt);
    const draft = extractJson(text) as PromptDraft;
    return { script: scriptFromPrompt(prompt, draft), source: "model" };
  } catch {
    return { script: scriptFromPrompt(prompt), source: "local" };
  }
}

export async function generateScript(input: BuiltinInput): Promise<GeneratedScript> {
  const provider = (process.env.SCRIPT_PROVIDER || "anthropic").toLowerCase();
  const { minWords, maxWords } = wordRange(input.minSec, input.maxSec);
  const scenesWanted = sceneCount(input.minSec, input.maxSec);
  if (provider === "builtin") return buildBuiltinScript(input);

  let repair = input.repairNote ?? "";
  let lastError = "The script was not valid.";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const system = scriptSystemPrompt({
      niche: input.niche,
      languageName: input.languageName,
      minWords,
      maxWords,
      sceneMin: Math.max(8, scenesWanted - 1),
      sceneMax: Math.min(12, scenesWanted + 1),
      pastTopics: input.pastTopics,
      customNichePrompt: input.customNichePrompt,
      repairNote: repair,
    });
    try {
      const text = await completeChat(system, "Write the next video. Return only JSON.");
      const parsed = generatedScriptSchema.safeParse(normalizeScriptShape(extractJson(text)));
      if (!parsed.success) {
        lastError = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        repair = lastError;
        continue;
      }
      const words = countWords(parsed.data.scenes.map((scene) => scene.narration).join(" "));
      if (words < minWords || words > maxWords) {
        lastError = `Word count was ${words}, need ${minWords}-${maxWords}.`;
        repair = lastError;
        continue;
      }
      return parsed.data;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Script request failed.";
      repair = lastError;
    }
  }
  throw new Error(lastError);
}
