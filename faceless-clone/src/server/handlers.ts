import { randomBytes } from "crypto";
import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { ART_STYLES, artStyleByKey } from "../lib/artStyles";
import { defaultCaptionStyle, type CaptionStyle } from "../lib/caption";
import { EFFECTS } from "../lib/effects";
import { NICHES, nicheByKey } from "../lib/niches";
import { bulkVideoSchema, generateCountSchema, reelPromptSchema, rerenderSchema, seriesWriteSchema, settingPatchSchema, videoPatchSchema } from "../lib/schemas";
import type { GeneratedScript } from "../lib/scriptSchema";
import { upcomingPublishSlots } from "../lib/schedule";
import { PREVIEW_SENTENCE } from "../lib/voiceCatalog";
import { hashSeed, parseJson } from "../lib/utils";
import { bootstrap } from "./bootstrap";
import { prisma } from "./db";
import { providerStatus, socialStatus } from "./envStatus";
import { error, json, parseBody, readJson } from "./http";
import { directorySize } from "./media";
import { ensureDir, fileExists, projectRoot, safeProjectFile, storageRoot, videoFolder } from "./paths";
import { generateImage, imageSizeFor, placeholderForStyle } from "./providers/image";
import { buildBuiltinScript, generateScript } from "./providers/script";
import { synthesizeSpeech } from "./providers/tts";
import { enqueue } from "./queue";
import { isPlatform, oauthCallback, oauthStart } from "./publish/oauth";

async function ready() {
  await bootstrap();
}

function seriesData(input: ReturnType<typeof seriesWriteSchema.parse>) {
  return {
    name: input.name,
    nicheKey: input.nicheKey,
    customNichePrompt: input.nicheKey === "custom" ? input.customNichePrompt?.trim() || null : null,
    language: input.language,
    voiceId: input.voiceId,
    musicTrackIds: JSON.stringify(input.musicTrackIds),
    artStyleKey: input.artStyleKey,
    captionStyle: JSON.stringify(input.captionStyle),
    effects: JSON.stringify(input.effects),
    durationMinSec: input.durationMinSec,
    durationMaxSec: input.durationMaxSec,
    timezone: input.timezone,
    publishTimes: JSON.stringify(input.publishTimes),
    publishDays: JSON.stringify([...new Set(input.publishDays)].sort()),
    leadHours: input.leadHours,
    autoApprove: input.autoApprove,
    autoPublish: input.autoPublish,
  };
}

function presentSeries(series: {
  id: string;
  name: string;
  nicheKey: string;
  customNichePrompt: string | null;
  language: string;
  voiceId: string;
  musicTrackIds: string;
  artStyleKey: string;
  captionStyle: string;
  effects: string;
  durationMinSec: number;
  durationMaxSec: number;
  timezone: string;
  publishTimes: string;
  publishDays: string;
  leadHours: number;
  autoApprove: boolean;
  autoPublish: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  accounts?: { account: { id: string; platform: string; displayName: string } }[];
  videos?: { id: string; status: string; progress: number; title: string | null; scheduledFor: Date | null; thumbPath: string | null; createdAt: Date }[];
}) {
  const publishTimes = parseJson<string[]>(series.publishTimes, []);
  const publishDays = parseJson<number[]>(series.publishDays, []);
  const next = upcomingPublishSlots({
    now: new Date(),
    timezone: series.timezone,
    publishTimes,
    publishDays,
    leadHours: 24 * 14,
  })[0];
  return {
    ...series,
    musicTrackIds: parseJson<string[]>(series.musicTrackIds, []),
    captionStyle: parseJson<CaptionStyle>(series.captionStyle, defaultCaptionStyle()),
    effects: parseJson<string[]>(series.effects, []),
    publishTimes,
    publishDays,
    accountIds: series.accounts?.map((link) => link.account.id) ?? [],
    accounts: series.accounts?.map((link) => link.account) ?? [],
    nextPublishAt: next?.toISOString() ?? null,
    videos: series.videos?.map((video) => ({
      id: video.id,
      status: video.status,
      progress: video.progress,
      title: video.title,
      scheduledFor: video.scheduledFor,
      createdAt: video.createdAt,
      hasThumb: Boolean(video.thumbPath),
    })),
  };
}

export async function listSeries() {
  await ready();
  const rows = await prisma.series.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      accounts: { include: { account: { select: { id: true, platform: true, displayName: true } } } },
      videos: { orderBy: { createdAt: "desc" }, take: 4, select: { id: true, status: true, progress: true, title: true, scheduledFor: true, thumbPath: true, createdAt: true } },
    },
  });
  return json(rows.map(presentSeries));
}

export async function createSeries(req: Request) {
  await ready();
  const parsed = parseBody(seriesWriteSchema, await readJson(req));
  if (!parsed.ok) return error(parsed.error);
  const voice = await prisma.voice.findUnique({ where: { id: parsed.data.voiceId } });
  if (!voice) return error("Pick a voice from the catalog.");
  const tracks = await prisma.musicTrack.findMany({ where: { id: { in: parsed.data.musicTrackIds } } });
  if (tracks.length !== parsed.data.musicTrackIds.length) return error("One of the selected songs is missing.");
  const accounts = await prisma.socialAccount.findMany({ where: { id: { in: parsed.data.accountIds } } });
  if (accounts.length !== parsed.data.accountIds.length) return error("One of the selected accounts is missing.");
  const series = await prisma.series.create({
    data: {
      ...seriesData(parsed.data),
      accounts: { create: accounts.map((account) => ({ accountId: account.id })) },
    },
  });
  if (parsed.data.generateNow) {
    const video = await prisma.video.create({ data: { seriesId: series.id, status: "PENDING" } });
    await enqueue("GENERATE_VIDEO", { videoId: video.id });
  }
  const full = await prisma.series.findUnique({
    where: { id: series.id },
    include: { accounts: { include: { account: { select: { id: true, platform: true, displayName: true } } } } },
  });
  return json(presentSeries(full!), 201);
}

export async function getSeries(_req: Request, id: string) {
  await ready();
  const series = await prisma.series.findUnique({
    where: { id },
    include: {
      accounts: { include: { account: { select: { id: true, platform: true, displayName: true } } } },
      videos: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!series) return error("Series not found.", 404);
  return json({
    ...presentSeries(series),
    videos: series.videos.map(presentVideo),
  });
}

export async function patchSeries(req: Request, id: string) {
  await ready();
  const parsed = parseBody(seriesWriteSchema, await readJson(req));
  if (!parsed.ok) return error(parsed.error);
  const existing = await prisma.series.findUnique({ where: { id } });
  if (!existing) return error("Series not found.", 404);
  const accounts = await prisma.socialAccount.findMany({ where: { id: { in: parsed.data.accountIds } } });
  if (accounts.length !== parsed.data.accountIds.length) return error("One of the selected accounts is missing.");
  await prisma.seriesAccount.deleteMany({ where: { seriesId: id } });
  const series = await prisma.series.update({
    where: { id },
    data: {
      ...seriesData(parsed.data),
      accounts: { create: parsed.data.accountIds.map((accountId) => ({ accountId })) },
    },
    include: { accounts: { include: { account: { select: { id: true, platform: true, displayName: true } } } } },
  });
  return json(presentSeries(series));
}

export async function deleteSeries(id: string) {
  await ready();
  await prisma.series.delete({ where: { id } }).catch(() => null);
  return json({ ok: true });
}

export async function generateForSeries(req: Request, id: string) {
  await ready();
  const parsed = parseBody(generateCountSchema, await readJson(req));
  if (!parsed.ok) return error(parsed.error);
  const series = await prisma.series.findUnique({ where: { id } });
  if (!series) return error("Series not found.", 404);
  const count = parsed.data.count ?? 1;
  const videos = [];
  for (let index = 0; index < count; index += 1) {
    const video = await prisma.video.create({ data: { seriesId: id, status: "PENDING" } });
    await enqueue("GENERATE_VIDEO", { videoId: video.id });
    videos.push(video.id);
  }
  return json({ ok: true, count, videoIds: videos });
}

export async function setSeriesStatus(id: string, status: "ACTIVE" | "PAUSED") {
  await ready();
  const series = await prisma.series.update({ where: { id }, data: { status } }).catch(() => null);
  if (!series) return error("Series not found.", 404);
  return json({ ok: true, status });
}

function presentVideo(video: {
  id: string;
  seriesId: string;
  status: string;
  progress: number;
  topic: string | null;
  prompt?: string | null;
  title: string | null;
  description: string | null;
  hashtags: string;
  scriptJson: string | null;
  scheduledFor: Date | null;
  filePath: string | null;
  thumbPath: string | null;
  durationSec: number | null;
  musicTrackId: string | null;
  error: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  publications?: { id: string; platform: string; status: string; url: string | null; error: string | null; externalId: string | null }[];
  series?: { name: string; autoApprove: boolean; autoPublish: boolean };
}) {
  return {
    ...video,
    filePath: undefined,
    thumbPath: undefined,
    prompt: video.prompt ?? null,
    hasFile: Boolean(video.filePath),
    hasThumb: Boolean(video.thumbPath),
    hashtags: parseJson<string[]>(video.hashtags, []),
    script: parseJson<GeneratedScript | null>(video.scriptJson, null),
    scriptJson: undefined,
    missedSlot:
      video.status === "READY" &&
      video.series?.autoApprove === false &&
      video.scheduledFor !== null &&
      video.scheduledFor.getTime() <= Date.now(),
  };
}

export async function listVideos(req: Request) {
  await ready();
  const url = new URL(req.url);
  const status = url.searchParams.get("status") || undefined;
  const seriesId = url.searchParams.get("seriesId") || undefined;
  const rows = await prisma.video.findMany({
    where: { status, seriesId },
    orderBy: { createdAt: "desc" },
    include: {
      series: { select: { name: true, autoApprove: true, autoPublish: true } },
      publications: { select: { id: true, platform: true, status: true, url: true, error: true, externalId: true } },
    },
  });
  return json(rows.map(presentVideo));
}

export async function getVideo(id: string) {
  await ready();
  const video = await prisma.video.findUnique({
    where: { id },
    include: {
      series: { select: { name: true, autoApprove: true, autoPublish: true, id: true } },
      publications: { select: { id: true, platform: true, status: true, url: true, error: true, externalId: true } },
    },
  });
  if (!video) return error("Video not found.", 404);
  let log = "";
  try {
    log = await fs.readFile(path.join(storageRoot(), "logs", `${id}.log`), "utf8");
  } catch {
    log = "";
  }
  return json({ ...presentVideo(video), log: log.trim().split("\n").slice(-200).join("\n") });
}

export async function patchVideo(req: Request, id: string) {
  await ready();
  const parsed = parseBody(videoPatchSchema, await readJson(req));
  if (!parsed.ok) return error(parsed.error);
  const data: Record<string, unknown> = {};
  if (parsed.data.title) data.title = parsed.data.title;
  if (parsed.data.description) data.description = parsed.data.description;
  if (parsed.data.hashtags) data.hashtags = JSON.stringify(parsed.data.hashtags.map((tag) => tag.replace(/^#/, "")));
  if (parsed.data.script) {
    data.scriptJson = JSON.stringify(parsed.data.script);
    data.topic = parsed.data.script.topic;
    await fs.writeFile(path.join(videoFolder(id), "script.json"), JSON.stringify(parsed.data.script, null, 2)).catch(() => undefined);
  }
  const video = await prisma.video.update({ where: { id }, data }).catch(() => null);
  if (!video) return error("Video not found.", 404);
  return json({ ok: true });
}

export async function deleteVideo(id: string) {
  await ready();
  await prisma.video.delete({ where: { id } }).catch(() => null);
  await fs.rm(videoFolder(id), { recursive: true, force: true });
  return json({ ok: true });
}

export async function approveVideo(id: string) {
  await ready();
  const video = await prisma.video.update({ where: { id }, data: { status: "APPROVED", error: null } }).catch(() => null);
  if (!video) return error("Video not found.", 404);
  return json({ ok: true });
}

export async function rejectVideo(id: string) {
  await ready();
  const video = await prisma.video.findUnique({ where: { id } });
  if (!video) return error("Video not found.", 404);
  await prisma.video.update({ where: { id }, data: { status: "CANCELLED" } });
  const fresh = await prisma.video.create({
    data: { seriesId: video.seriesId, status: "PENDING", scheduledFor: video.scheduledFor },
  });
  await enqueue("GENERATE_VIDEO", { videoId: fresh.id });
  return json({ ok: true, videoId: fresh.id });
}

export async function retryVideo(id: string) {
  await ready();
  const video = await prisma.video.findUnique({ where: { id } });
  if (!video) return error("Video not found.", 404);
  await prisma.video.update({ where: { id }, data: { status: "PENDING", error: null } });
  await enqueue("GENERATE_VIDEO", { videoId: id });
  return json({ ok: true });
}

export async function rerenderVideo(req: Request, id: string) {
  await ready();
  const parsed = parseBody(rerenderSchema, await readJson(req));
  if (!parsed.ok) return error(parsed.error);
  await prisma.video.update({ where: { id }, data: { status: "PENDING", error: null } });
  await enqueue("RERENDER", { videoId: id, respeak: Boolean(parsed.data.respeak) });
  return json({ ok: true });
}

export async function regenerateVideo(id: string) {
  await ready();
  await fs.rm(videoFolder(id), { recursive: true, force: true });
  await prisma.video.update({ where: { id }, data: { status: "PENDING", error: null, progress: 0, filePath: null, thumbPath: null } });
  await enqueue("GENERATE_VIDEO", { videoId: id });
  return json({ ok: true });
}

export async function publishNow(id: string) {
  await ready();
  const video = await prisma.video.findUnique({
    where: { id },
    include: { series: { include: { accounts: { include: { account: true } } } } },
  });
  if (!video) return error("Video not found.", 404);
  if (!video.filePath) return error("Render the video before publishing.");
  if (video.series.accounts.length === 0) return error("Connect an account, or download the MP4.");
  await prisma.video.update({ where: { id }, data: { status: "APPROVED" } });
  for (const link of video.series.accounts) {
    const publication = await prisma.publication.create({
      data: { videoId: id, accountId: link.accountId, platform: link.account.platform, status: "PENDING" },
    });
    await enqueue("PUBLISH_VIDEO", { publicationId: publication.id });
  }
  await prisma.video.update({ where: { id }, data: { status: "PUBLISHING" } });
  return json({ ok: true });
}

export async function regenerateScene(id: string, n: string) {
  await ready();
  const sceneIndex = Number(n);
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1 || sceneIndex > 12) return error("Scene number is out of range.");
  await enqueue("REGENERATE_SCENE", { videoId: id, sceneIndex });
  return json({ ok: true });
}

export async function bulkVideos(req: Request) {
  await ready();
  const parsed = parseBody(bulkVideoSchema, await readJson(req));
  if (!parsed.ok) return error(parsed.error);
  for (const id of parsed.data.ids) {
    if (parsed.data.action === "approve") await approveVideo(id);
    if (parsed.data.action === "delete") await deleteVideo(id);
    if (parsed.data.action === "regenerate") await regenerateVideo(id);
  }
  return json({ ok: true, count: parsed.data.ids.length });
}

function downloadName(title: string | null) {
  const base = (title || "reel").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
  return `${base || "reel"}.mp4`;
}

export async function videoFile(req: Request, id: string) {
  await ready();
  const video = await prisma.video.findUnique({ where: { id } });
  if (!video?.filePath) return error("No video file yet.", 404);
  const download = new URL(req.url).searchParams.has("download");
  const disposition = download ? `attachment; filename="${downloadName(video.title)}"` : "inline";
  return streamRange(req, safeProjectFile(video.filePath), "video/mp4", disposition);
}

export async function createReel(req: Request) {
  await ready();
  const parsed = parseBody(reelPromptSchema, await readJson(req));
  if (!parsed.ok) return error(parsed.error);
  const series = await reelSeries();
  const video = await prisma.video.create({
    data: {
      seriesId: series.id,
      status: "PENDING",
      prompt: parsed.data.prompt,
      topic: parsed.data.prompt.slice(0, 180),
    },
  });
  await enqueue("GENERATE_VIDEO", { videoId: video.id });
  const full = await prisma.video.findUnique({
    where: { id: video.id },
    include: { series: { select: { name: true, autoApprove: true, autoPublish: true } } },
  });
  return json(presentVideo(full!), 201);
}

async function reelSeries() {
  const existing = await prisma.series.findFirst({ where: { name: "Prompt reels", nicheKey: "custom" } });
  if (existing) return existing;
  const voice = (await prisma.voice.findUnique({ where: { id: "jonah" } })) ?? (await prisma.voice.findFirst({ where: { language: "en" } }));
  if (!voice) throw new Error("No voice is installed. Run npm run db:setup.");
  const music = await prisma.musicTrack.findUnique({ where: { key: "quiet-before-storm" } });
  return prisma.series.create({
    data: {
      name: "Prompt reels",
      nicheKey: "custom",
      customNichePrompt: "One short reel from a single prompt",
      language: "en",
      voiceId: voice.id,
      musicTrackIds: JSON.stringify(music ? [music.id] : []),
      artStyleKey: "realism",
      captionStyle: JSON.stringify(defaultCaptionStyle()),
      effects: "[]",
      durationMinSec: 20,
      durationMaxSec: 70,
      timezone: "UTC",
      publishTimes: "[]",
      publishDays: "[]",
      leadHours: 0,
      autoApprove: true,
      autoPublish: false,
      status: "PAUSED",
    },
  });
}

export async function videoThumb(id: string) {
  await ready();
  const video = await prisma.video.findUnique({ where: { id } });
  if (!video?.thumbPath) return error("No thumbnail yet.", 404);
  const abs = safeProjectFile(video.thumbPath);
  const data = await fs.readFile(abs);
  return new Response(data, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" } });
}

function streamRange(req: Request, abs: string, contentType: string, disposition = "inline") {
  return fs.stat(abs).then((stat) => {
    const size = stat.size;
    const range = req.headers.get("range");
    if (!range) {
      return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, {
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(size),
          "Accept-Ranges": "bytes",
          "Content-Disposition": disposition,
        },
      });
    }
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (!match) return error("Bad range", 416);
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : Math.min(start + 1024 * 1024 - 1, size - 1);
    if (start >= size || end < start) return error("Range not satisfiable", 416);
    return new Response(Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
      },
    });
  });
}

export async function listVoices(req: Request) {
  await ready();
  const url = new URL(req.url);
  const gender = url.searchParams.get("gender") || "";
  const q = (url.searchParams.get("q") || "").toLowerCase();
  const accent = url.searchParams.get("accent") || "";
  const all = await prisma.voice.findMany({ orderBy: { name: "asc" } });
  const voices = all.filter((voice) => {
    if (gender && voice.gender !== gender) return false;
    if (accent && voice.accent !== accent) return false;
    if (!q) return true;
    return `${voice.name} ${voice.descriptor} ${voice.accent ?? ""}`.toLowerCase().includes(q);
  });
  return json({
    voices,
    counts: {
      all: all.length,
      male: all.filter((voice) => voice.gender === "male").length,
      female: all.filter((voice) => voice.gender === "female").length,
    },
    accents: [...new Set(all.map((voice) => voice.accent).filter(Boolean))],
  });
}

export async function voicePreview(req: Request, id: string) {
  await ready();
  const voice = await prisma.voice.findUnique({ where: { id } });
  if (!voice) return error("Voice not found.", 404);
  const language = new URL(req.url).searchParams.get("language") || voice.language;
  const relative = path.join("storage", "voice-previews", `${id}-${language}.mp3`);
  const abs = path.join(projectRoot(), relative);
  if (!(await fileExists(abs))) {
    await ensureDir(path.dirname(abs));
    const spoken = await synthesizeSpeech({
      text: PREVIEW_SENTENCE,
      voiceId: voice.providerVoiceId,
      gender: voice.gender,
      language,
    });
    await fs.writeFile(abs, spoken.audio);
    await prisma.voice.update({ where: { id }, data: { previewPath: relative } });
  }
  const data = await fs.readFile(abs);
  return new Response(data, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" } });
}

async function withMissing<T extends { filePath: string }>(tracks: T[]) {
  return Promise.all(
    tracks.map(async (track) => {
      const missing = !(await fileExists(safeProjectFile(track.filePath)));
      const { filePath: _filePath, ...rest } = track;
      return { ...rest, missing };
    }),
  );
}

export async function listMusic() {
  await ready();
  const tracks = await prisma.musicTrack.findMany({ orderBy: { createdAt: "asc" } });
  return json(await withMissing(tracks));
}

export async function uploadMusic(req: Request) {
  await ready();
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return error("Choose an audio file.");
  if (file.size > 50 * 1024 * 1024) return error("Music files must be 50 MB or smaller.");
  const ext = path.extname(file.name).toLowerCase();
  if (![".mp3", ".wav", ".m4a"].includes(ext)) return error("Upload an mp3, wav, or m4a file.");
  const name = String(form.get("name") || file.name.replace(ext, ""));
  const id = `upl${randomBytes(8).toString("hex")}`;
  const relative = path.join("storage", "uploads", "music", `${id}${ext}`);
  await ensureDir(path.dirname(path.join(projectRoot(), relative)));
  await fs.writeFile(path.join(projectRoot(), relative), Buffer.from(await file.arrayBuffer()));
  const track = await prisma.musicTrack.create({
    data: { id, name, description: "Uploaded track", filePath: relative, isPreset: false },
  });
  const { filePath: _filePath, ...rest } = track;
  return json({ ...rest, missing: false }, 201);
}

export async function deleteMusic(id: string) {
  await ready();
  const track = await prisma.musicTrack.findUnique({ where: { id } });
  if (!track) return error("Track not found.", 404);
  if (track.isPreset) return error("Preset slots stay in the library. Remove the file from assets/music if you want it greyed out.");
  await prisma.musicTrack.delete({ where: { id } });
  await fs.rm(safeProjectFile(track.filePath), { force: true });
  return json({ ok: true });
}

export async function musicFile(id: string) {
  await ready();
  const track = await prisma.musicTrack.findUnique({ where: { id } });
  if (!track) return error("Track not found.", 404);
  const abs = safeProjectFile(track.filePath);
  if (!(await fileExists(abs))) return error(`Add ${track.filePath}`, 404);
  const data = await fs.readFile(abs);
  const type = abs.endsWith(".wav") ? "audio/wav" : abs.endsWith(".m4a") ? "audio/mp4" : "audio/mpeg";
  return new Response(data, { headers: { "Content-Type": type } });
}

export async function listNiches() {
  return json(NICHES);
}

export async function listArtStyles() {
  return json(ART_STYLES.map(({ palette: _palette, ...style }) => style));
}

export async function listEffects() {
  return json(EFFECTS);
}

export async function artPreview(key: string) {
  await ready();
  if (!ART_STYLES.some((item) => item.key === key)) return error("Unknown art style.", 404);
  const style = artStyleByKey(key);
  const shipped = path.join(projectRoot(), "public", "art-previews", `${key}.jpg`);
  if (await fileExists(shipped)) {
    return new Response(await fs.readFile(shipped), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
  }
  const relative = path.join(storageRoot(), "style-previews", `${key}.jpg`);
  if (!(await fileExists(relative))) {
    await ensureDir(path.dirname(relative));
    const png = await placeholderForStyle(key).catch(() => placeholderForStyle("realism"));
    const jpeg = await (await import("sharp")).default(png).jpeg({ quality: 80 }).toBuffer();
    await fs.writeFile(relative, jpeg);
    if ((process.env.IMAGE_PROVIDER || "placeholder") !== "placeholder") {
      try {
        const size = imageSizeFor();
        const real = await generateImage({
          prompt: `A lone figure in a doorway at night, ${style.promptSuffix}, vertical 9:16 composition, no text, no watermark`,
          width: size.width,
          height: size.height,
          seed: hashSeed(key),
          styleKey: key,
          scene: 1,
        });
        await fs.writeFile(relative, await (await import("sharp")).default(real).jpeg({ quality: 80 }).toBuffer());
      } catch {
        /* keep the cached stand-in */
      }
    }
  }
  const data = await fs.readFile(relative);
  return new Response(data, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
}

export async function listAccounts() {
  await ready();
  const accounts = await prisma.socialAccount.findMany({ orderBy: { createdAt: "desc" } });
  return json(
    accounts.map((account) => ({
      id: account.id,
      platform: account.platform,
      displayName: account.displayName,
      externalUserId: account.externalUserId,
      expiresAt: account.expiresAt,
      health: account.expiresAt && account.expiresAt.getTime() < Date.now() && !account.refreshToken ? "needs-reconnect" : "ok",
    })),
  );
}

export async function deleteAccount(id: string) {
  await ready();
  await prisma.socialAccount.delete({ where: { id } }).catch(() => null);
  return json({ ok: true });
}

export async function startAuth(platform: string, req: Request) {
  if (!isPlatform(platform)) return error("Unknown platform.", 404);
  const result = oauthStart(platform, req);
  if (result.error) return Response.redirect(new URL(`/accounts?error=${encodeURIComponent(result.error)}`, req.url), 302);
  return Response.redirect(result.url!, 302);
}

export async function finishAuth(platform: string, req: Request) {
  await ready();
  if (!isPlatform(platform)) return error("Unknown platform.", 404);
  try {
    await oauthCallback(platform, req);
    return Response.redirect(new URL(`/accounts?connected=${platform}`, req.url), 302);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed.";
    return Response.redirect(new URL(`/accounts?error=${encodeURIComponent(message)}`, req.url), 302);
  }
}

export async function settingsOverview() {
  await ready();
  const timezone = await prisma.setting.findUnique({ where: { key: "timezone" } });
  const bytes = await directorySize(storageRoot());
  const failed = await prisma.job.count({ where: { status: "FAILED" } });
  return json({
    providers: providerStatus(),
    social: socialStatus(),
    timezone: timezone?.value ?? "UTC",
    storageBytes: bytes,
    failedJobs: failed,
    workerConcurrency: Number(process.env.WORKER_CONCURRENCY || 1),
    imageConcurrency: Number(process.env.IMAGE_CONCURRENCY || 2),
  });
}

export async function patchSettings(req: Request) {
  await ready();
  const parsed = parseBody(settingPatchSchema, await readJson(req));
  if (!parsed.ok) return error(parsed.error);
  if (parsed.data.timezone) {
    await prisma.setting.upsert({
      where: { key: "timezone" },
      update: { value: parsed.data.timezone },
      create: { key: "timezone", value: parsed.data.timezone },
    });
  }
  return settingsOverview();
}

export async function clearFailedJobs() {
  await ready();
  const result = await prisma.job.deleteMany({ where: { status: "FAILED" } });
  return json({ ok: true, deleted: result.count });
}

export async function testProvider(name: string) {
  await ready();
  try {
    if (name === "script") {
      const script = await generateScript({
        niche: nicheByKey("scary-stories"),
        minSec: 30,
        maxSec: 40,
        pastTopics: [],
        languageName: "English",
      });
      return json({ ok: true, detail: `Script ok: ${script.title}` });
    }
    if (name === "builtin") {
      const script = buildBuiltinScript({
        niche: nicheByKey("scary-stories"),
        minSec: 30,
        maxSec: 40,
        pastTopics: [],
        languageName: "English",
      });
      return json({ ok: true, detail: script.title });
    }
    if (name === "image") {
      const size = (process.env.IMAGE_PROVIDER || "") === "placeholder" ? { width: 360, height: 640 } : imageSizeFor();
      const image = await generateImage({
        prompt: "A red circle on a dark background, no text",
        width: size.width,
        height: size.height,
        seed: 7,
        styleKey: "realism",
        scene: 1,
      });
      return json({ ok: true, detail: `Image ok, ${image.length} bytes.` });
    }
    if (name === "tts") {
      const spoken = await synthesizeSpeech({
        text: PREVIEW_SENTENCE,
        voiceId: "en-US-AndrewNeural",
        gender: "male",
        language: "en",
      });
      return json({ ok: true, detail: `Voice ok, ${spoken.audio.length} bytes, ${spoken.wordTimings.length} word timings.` });
    }
    if (name === "captions") {
      return json({
        ok: true,
        detail: "Captions use voice-provider word timings. Whisper.cpp is optional and runs only when its binary is on PATH.",
      });
    }
    return error("Unknown provider test.", 404);
  } catch (err) {
    return json({ ok: false, detail: err instanceof Error ? err.message : "Test failed." }, 200);
  }
}
