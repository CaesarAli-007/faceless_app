import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import type { Series, Video } from "@prisma/client";
import { artStyleByKey } from "../../lib/artStyles";
import { defaultCaptionStyle, type CaptionStyle } from "../../lib/caption";
import { languageByCode } from "../../lib/languages";
import { nicheByKey } from "../../lib/niches";
import { assembleImagePrompt, NEGATIVE_PROMPT } from "../../lib/promptAssembly";
import type { GeneratedScript } from "../../lib/scriptSchema";
import { alignScenes, estimateTimings, groupCaptions, type WordTiming } from "../../lib/timing";
import { hashSeed, mapPool, parseJson, sleep } from "../../lib/utils";
import { prisma } from "../db";
import { videoLog } from "../log";
import { changeTempo, loudnormToMp3, probeDuration } from "../media";
import { ensureDir, fileExists, projectRoot, safeProjectFile, videoFolder } from "../paths";
import { generateImage, imageSizeFor, placeholderForStyle, SafetyRejection } from "../providers/image";
import { generatePromptScript, generateScript, rewriteImagePrompt } from "../providers/script";
import { synthesizeSpeech } from "../providers/tts";
import type { KenBurns, ReelProps } from "../../../remotion/types";
import { renderReel, stagePublicAsset } from "./renderReel";

export class CancelledError extends Error {
  constructor() {
    super("CANCELLED");
    this.name = "CancelledError";
  }
}

type Loaded = Video & { series: Series };

async function load(videoId: string): Promise<Loaded> {
  const video = await prisma.video.findUnique({ where: { id: videoId }, include: { series: true } });
  if (!video) throw new Error("That video no longer exists.");
  if (video.status === "CANCELLED") throw new CancelledError();
  return video;
}

async function mark(videoId: string, status: string, progress: number, extra: Record<string, unknown> = {}) {
  await prisma.video.update({ where: { id: videoId }, data: { status, progress, ...extra } });
}

const KEN: KenBurns[] = ["zoom-in", "zoom-out", "pan-left", "pan-right"];

async function whisperTimings(file: string, language: string): Promise<WordTiming[] | null> {
  const bin = process.env.WHISPER_CPP_PATH || "whisper-cli";
  const model = process.env.WHISPER_MODEL || (language === "en" ? "base.en" : "base");
  return new Promise((resolve) => {
    const child = spawn(bin, ["-m", model, "-f", file, "-oj", "-of", `${file}.whisper`], { stdio: "ignore" });
    child.on("error", () => resolve(null));
    child.on("close", async (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const raw = JSON.parse(await fs.readFile(`${file}.whisper.json`, "utf8")) as {
          transcription?: { tokens?: { text: string; offsets?: { from: number; to: number } }[] };
        };
        const words =
          raw.transcription?.tokens
            ?.map((token) => ({
              word: token.text.trim(),
              startMs: token.offsets?.from ?? 0,
              endMs: token.offsets?.to ?? 0,
            }))
            .filter((token) => token.word && !token.word.startsWith("[")) ?? [];
        resolve(words.length ? words : null);
      } catch {
        resolve(null);
      }
    });
  });
}

export async function generateVideo(videoId: string, from?: "script" | "voice" | "images" | "captions" | "render") {
  const video = await load(videoId);
  const folder = videoFolder(videoId);
  await ensureDir(path.join(folder, "images"));
  const scriptPath = path.join(folder, "script.json");
  const voicePath = path.join(folder, "voice.mp3");
  const timingPath = path.join(folder, "wordTimings.json");
  const captionPath = path.join(folder, "captions.json");
  const finalPath = path.join(folder, "final.mp4");
  const thumbPath = path.join(folder, "thumb.jpg");

  if (from === "script") await fs.rm(folder, { recursive: true, force: true });
  if (from === "voice") await Promise.all([fs.rm(voicePath, { force: true }), fs.rm(timingPath, { force: true }), fs.rm(captionPath, { force: true }), fs.rm(finalPath, { force: true }), fs.rm(thumbPath, { force: true })]);
  if (from === "images") {
    await fs.rm(path.join(folder, "images"), { recursive: true, force: true });
    await Promise.all([fs.rm(finalPath, { force: true }), fs.rm(thumbPath, { force: true })]);
  }
  if (from === "captions") await Promise.all([fs.rm(captionPath, { force: true }), fs.rm(finalPath, { force: true }), fs.rm(thumbPath, { force: true })]);
  if (from === "render") await Promise.all([fs.rm(finalPath, { force: true }), fs.rm(thumbPath, { force: true })]);
  await ensureDir(path.join(folder, "images"));

  await mark(videoId, "SCRIPTING", 2, { error: null });
  await videoLog(videoId, "Picking a topic and writing the script.");
  const script = await ensureScript(videoId, scriptPath);
  await mark(videoId, "VOICING", 15);
  await videoLog(videoId, "Recording narration.");
  const spoken = await ensureVoice(await load(videoId), script, voicePath, timingPath);
  await mark(videoId, "IMAGING", 30);
  await videoLog(videoId, "Drawing scene images.");
  await ensureImages(await load(videoId), script, folder);
  await mark(videoId, "CAPTIONING", 72);
  await videoLog(videoId, "Timing captions.");
  const captions = await ensureCaptions(await load(videoId), script, spoken.words, spoken.durationSec, captionPath);
  await mark(videoId, "RENDERING", 75);
  await videoLog(videoId, "Rendering the vertical video.");
  await ensureRender(await load(videoId), script, spoken.durationSec, captions.pages, voicePath, finalPath, thumbPath);
  const series = (await load(videoId)).series;
  const status = series.autoApprove ? "APPROVED" : "READY";
  await mark(videoId, status, 100, {
    filePath: path.relative(projectRoot(), finalPath),
    thumbPath: path.relative(projectRoot(), thumbPath),
    durationSec: spoken.durationSec,
    error: null,
  });
  await videoLog(videoId, `Finished. Status is ${status}.`);
}

async function ensureScript(videoId: string, scriptPath: string) {
  if (await fileExists(scriptPath)) return JSON.parse(await fs.readFile(scriptPath, "utf8")) as GeneratedScript;
  const video = await load(videoId);
  if (video.prompt?.trim()) {
    await videoLog(videoId, "Writing the voiceover from your prompt.");
    const written = await generatePromptScript(video.prompt.trim());
    if (written.source === "local") await videoLog(videoId, "The writer was busy, so the reel stays close to your own words.");
    const script = written.script;
    await fs.writeFile(scriptPath, JSON.stringify(script, null, 2));
    await prisma.video.update({
      where: { id: videoId },
      data: {
        topic: script.topic,
        title: script.title,
        description: script.description,
        hashtags: JSON.stringify(script.hashtags),
        scriptJson: JSON.stringify(script),
        progress: 15,
      },
    });
    await videoLog(videoId, `Script ready: ${script.title}`);
    return script;
  }
  const niche = nicheByKey(video.series.nicheKey);
  const past = await prisma.video.findMany({
    where: { seriesId: video.seriesId, NOT: { id: videoId }, topic: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { topic: true },
  });
  const script = await generateScript({
    niche,
    minSec: video.series.durationMinSec,
    maxSec: video.series.durationMaxSec,
    pastTopics: past.map((item) => item.topic || "").filter(Boolean),
    languageName: languageByCode(video.series.language).name,
    customNichePrompt: video.series.customNichePrompt,
  });
  await fs.writeFile(scriptPath, JSON.stringify(script, null, 2));
  await prisma.video.update({
    where: { id: videoId },
    data: {
      topic: script.topic,
      title: script.title,
      description: script.description,
      hashtags: JSON.stringify(script.hashtags),
      scriptJson: JSON.stringify(script),
      progress: 15,
    },
  });
  await videoLog(videoId, `Script ready: ${script.title}`);
  return script;
}

async function ensureVoice(video: Loaded, script: GeneratedScript, voicePath: string, timingPath: string) {
  if ((await fileExists(voicePath)) && (await fileExists(timingPath))) {
    const words = JSON.parse(await fs.readFile(timingPath, "utf8")) as WordTiming[];
    return { words, durationSec: await probeDuration(voicePath) };
  }
  const voice = await prisma.voice.findUnique({ where: { id: video.series.voiceId } });
  if (!voice) throw new Error("That voice is no longer in the catalog.");
  const narration = script.scenes.map((scene) => scene.narration).join(" ");
  const rough = path.join(path.dirname(voicePath), "voice-raw.mp3");
  let spoken = await synthesizeSpeech({
    text: narration,
    voiceId: voice.providerVoiceId,
    gender: voice.gender,
    language: video.series.language,
  });
  if ("fallback" in spoken && spoken.fallback) await videoLog(video.id, `Voice provider fallback: ${spoken.fallback}`);
  await fs.writeFile(rough, spoken.audio);
  let words = spoken.wordTimings.length ? spoken.wordTimings : estimateTimings(narration, (await probeDuration(rough)) * 1000);
  try {
    await loudnormToMp3(rough, voicePath);
  } catch {
    await fs.copyFile(rough, voicePath);
  }
  let durationSec = await probeDuration(voicePath);
  if (durationSec > video.series.durationMaxSec + 5) {
    await videoLog(video.id, "Narration ran long. Speaking it slightly faster.");
    spoken = await synthesizeSpeech({
      text: narration,
      voiceId: voice.providerVoiceId,
      gender: voice.gender,
      language: video.series.language,
      speed: 1.1,
    });
    await fs.writeFile(rough, spoken.audio);
    words = spoken.wordTimings.length ? spoken.wordTimings : estimateTimings(narration, (await probeDuration(rough)) * 1000);
    try {
      await loudnormToMp3(rough, voicePath);
    } catch {
      await fs.copyFile(rough, voicePath);
    }
    durationSec = await probeDuration(voicePath);
  }
  if (durationSec > 90) {
    const tempo = durationSec / 88;
    const sped = path.join(path.dirname(voicePath), "voice-sped.mp3");
    await changeTempo(voicePath, sped, tempo);
    await fs.copyFile(sped, voicePath);
    words = words.map((word) => ({ ...word, startMs: word.startMs / tempo, endMs: word.endMs / tempo }));
    durationSec = await probeDuration(voicePath);
    await videoLog(video.id, "Narration was over 90 seconds, so it was sped up to fit.");
  }
  await fs.writeFile(timingPath, JSON.stringify(words, null, 2));
  await fs.rm(rough, { force: true });
  const tracks = parseJson<string[]>(video.series.musicTrackIds, []);
  if (tracks.length) {
    const picked = tracks[hashSeed(video.id) % tracks.length]!;
    const music = await prisma.musicTrack.findUnique({ where: { id: picked } });
    if (music && (await fileExists(safeProjectFile(music.filePath)))) {
      await prisma.video.update({ where: { id: video.id }, data: { musicTrackId: music.id, durationSec } });
    }
  } else {
    await prisma.video.update({ where: { id: video.id }, data: { durationSec } });
  }
  await videoLog(video.id, `Narration is ${durationSec.toFixed(1)} seconds.`);
  return { words, durationSec };
}

async function ensureImages(video: Loaded, script: GeneratedScript, folder: string) {
  const style = artStyleByKey(video.series.artStyleKey);
  const niche = nicheByKey(video.series.nicheKey);
  const size = imageSizeFor();
  const seed = hashSeed(video.id);
  const provider = (process.env.IMAGE_PROVIDER || "comfyui").toLowerCase();
  const limit = Math.max(1, Number(process.env.IMAGE_CONCURRENCY || 2));
  let finished = 0;
  await mapPool(script.scenes, limit, async (scene, index) => {
    const target = path.join(folder, "images", `scene-${String(index + 1).padStart(2, "0")}.png`);
    if (await fileExists(target)) {
      finished += 1;
      return;
    }
    let prompt = provider === "commons"
      ? scene.imagePrompt
      : assembleImagePrompt({
          imagePrompt: scene.imagePrompt,
          styleBible: script.styleBible,
          artSuffix: style.promptSuffix,
          nicheAddendum: niche.imageStyleAddendum,
        });
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const image = await generateImage({
          prompt,
          negativePrompt: NEGATIVE_PROMPT,
          width: size.width,
          height: size.height,
          seed,
          styleKey: style.key,
          scene: index + 1,
        });
        await fs.writeFile(target, image);
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Image generation failed.");
        if (error instanceof SafetyRejection && attempt === 0) {
          prompt = await rewriteImagePrompt(prompt);
          await videoLog(video.id, `Scene ${index + 1} was softened after a safety rejection.`);
        }
        await sleep(400 * 2 ** attempt);
      }
    }
    if (!(await fileExists(target))) {
      const previous = path.join(folder, "images", `scene-${String(index).padStart(2, "0")}.png`);
      if (index > 0 && (await fileExists(previous))) {
        await fs.copyFile(previous, target);
        await videoLog(video.id, `Scene ${index + 1} reused the previous image after ${lastError?.message ?? "a failure"}.`);
      } else if (provider === "commons") {
        throw lastError ?? new Error(`Scene ${index + 1} has no photo.`);
      } else {
        await fs.writeFile(target, await placeholderForStyle(style.key));
        await videoLog(video.id, `Scene ${index + 1} used a stand-in image after ${lastError?.message ?? "a failure"}.`);
      }
    }
    finished += 1;
    const progress = 30 + Math.round((finished / script.scenes.length) * 40);
    await prisma.video.update({ where: { id: video.id }, data: { progress } });
  });
}

async function ensureCaptions(video: Loaded, script: GeneratedScript, words: WordTiming[], durationSec: number, captionPath: string) {
  if (await fileExists(captionPath)) {
    return JSON.parse(await fs.readFile(captionPath, "utf8")) as { words: WordTiming[]; pages: ReturnType<typeof groupCaptions> };
  }
  const narration = script.scenes.map((scene) => scene.narration).join(" ");
  let timed = words;
  if (!timed.length) {
    const whispered = await whisperTimings(path.join(videoFolder(video.id), "voice.mp3"), video.series.language);
    timed = whispered ?? estimateTimings(narration, durationSec * 1000);
    if (!whispered) await videoLog(video.id, "No word timings from the voice provider. Captions were estimated across the narration.");
  }
  const style = parseJson<CaptionStyle>(video.series.captionStyle, defaultCaptionStyle());
  const pages = groupCaptions(timed, style.wordsPerLine);
  const payload = { words: timed, pages };
  await fs.writeFile(captionPath, JSON.stringify(payload, null, 2));
  return payload;
}

async function ensureRender(
  video: Loaded,
  script: GeneratedScript,
  durationSec: number,
  pages: ReturnType<typeof groupCaptions>,
  voicePath: string,
  finalPath: string,
  thumbPath: string,
) {
  if (await fileExists(finalPath) && (await fileExists(thumbPath))) return;
  const fps = 30;
  const durationInFrames = Math.max(fps, Math.ceil((durationSec + 0.6) * fps));
  const words = JSON.parse(await fs.readFile(path.join(videoFolder(video.id), "wordTimings.json"), "utf8")) as WordTiming[];
  const aligned = alignScenes(script.scenes, words, durationSec * 1000);
  const fade = 6;
  const seed = hashSeed(video.id);
  const scenes = [];
  for (let index = 0; index < script.scenes.length; index += 1) {
    const file = path.join(videoFolder(video.id), "images", `scene-${String(index + 1).padStart(2, "0")}.png`);
    const src = await stagePublicAsset(video.id, file, `scene-${String(index + 1).padStart(2, "0")}.png`);
    const startFrame = Math.round(((aligned[index]?.startMs ?? 0) / 1000) * fps);
    const naturalEnd = Math.round(((aligned[index]?.endMs ?? durationSec * 1000) / 1000) * fps);
    const endFrame = index === script.scenes.length - 1 ? durationInFrames : Math.min(durationInFrames, naturalEnd + fade);
    scenes.push({ src, startFrame, endFrame: Math.max(startFrame + 8, endFrame), kenBurns: KEN[(seed + index) % KEN.length]! });
  }
  const voiceSrc = await stagePublicAsset(video.id, voicePath, "voice.mp3");
  let musicSrc: string | null = null;
  if (video.musicTrackId) {
    const track = await prisma.musicTrack.findUnique({ where: { id: video.musicTrackId } });
    if (track && (await fileExists(safeProjectFile(track.filePath)))) {
      musicSrc = await stagePublicAsset(video.id, safeProjectFile(track.filePath), "music.mp3");
    }
  }
  const style = parseJson<CaptionStyle>(video.series.captionStyle, defaultCaptionStyle());
  const props: ReelProps = {
    scenes,
    pages,
    captionStyle: style,
    voiceSrc,
    musicSrc,
    effects: parseJson<string[]>(video.series.effects, []),
    seed,
    durationInFrames,
  };
  let lastBucket = 75;
  await renderReel(props, finalPath, thumbPath, (ratio) => {
    const progress = 75 + Math.round(ratio * 23);
    if (progress >= lastBucket + 4) {
      lastBucket = progress;
      void prisma.video.update({ where: { id: video.id }, data: { progress } });
    }
  });
  await videoLog(video.id, "Render complete.");
}

export async function regenerateSceneImage(videoId: string, sceneNumber: number) {
  const video = await load(videoId);
  const script = parseJson<GeneratedScript | null>(video.scriptJson, null);
  if (!script) throw new Error("This video has no script yet.");
  const scene = script.scenes[sceneNumber - 1];
  if (!scene) throw new Error("That scene does not exist.");
  const previous = video.status;
  await mark(videoId, "IMAGING", Math.max(video.progress, 40));
  const style = artStyleByKey(video.series.artStyleKey);
  const niche = nicheByKey(video.series.nicheKey);
  const size = imageSizeFor();
  const prompt = assembleImagePrompt({
    imagePrompt: scene.imagePrompt,
    styleBible: script.styleBible,
    artSuffix: style.promptSuffix,
    nicheAddendum: niche.imageStyleAddendum,
  });
  const image = await generateImage({
    prompt,
    negativePrompt: NEGATIVE_PROMPT,
    ...size,
    seed: hashSeed(videoId),
    styleKey: style.key,
    scene: sceneNumber,
  });
  const target = path.join(videoFolder(videoId), "images", `scene-${String(sceneNumber).padStart(2, "0")}.png`);
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, image);
  await fs.rm(path.join(videoFolder(videoId), "final.mp4"), { force: true });
  const restore = previous === "PUBLISHED" || previous === "PUBLISHING" ? "READY" : previous === "IMAGING" ? "READY" : previous;
  await mark(videoId, restore === "PENDING" || restore === "FAILED" ? "READY" : restore, 80);
  await videoLog(videoId, `Regenerated scene ${sceneNumber}. Re-render to update the MP4.`);
}
