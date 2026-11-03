import crypto from "crypto";
import fs from "fs/promises";
import WebSocket from "ws";
import { languageByCode } from "../../lib/languages";
import type { WordTiming } from "../../lib/timing";
import { estimateTimings } from "../../lib/timing";
import { espeakToMp3, probeDuration } from "../media";
import { EDGE_GEC_VERSION, EDGE_TOKEN, edgeMuid, generateSecMsGecV2, noteEdgeClock } from "./edgeDrm";

function xmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function edgeVoiceFor(input: { providerVoiceId: string; gender: string; language: string }) {
  const language = languageByCode(input.language);
  if (input.language === "en") return input.providerVoiceId;
  return input.gender === "female" ? language.edgeFemale : language.edgeMale;
}

function edgeTimestamp() {
  const date = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function sanitizeSpeech(text: string) {
  return [...text]
    .map((char) => {
      const code = char.charCodeAt(0);
      if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) return " ";
      return char;
    })
    .join("");
}

class EdgeRejected extends Error {
  serverDate?: string;
  constructor(status: number, serverDate?: string) {
    super(`Edge TTS rejected the connection (${status}).`);
    this.serverDate = serverDate;
  }
}

export function edgeTimeoutMs(text: string) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.min(240_000, Math.max(45_000, 20_000 + words * 800));
}

function speakOnce(text: string, voice: string, speed: number) {
  const rate = `${speed >= 1 ? "+" : ""}${Math.round((speed - 1) * 100)}%`;
  const connectionId = crypto.randomUUID().replace(/-/g, "");
  const gec = generateSecMsGecV2();
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TOKEN}&ConnectionId=${connectionId}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}`;
  const spoken = sanitizeSpeech(text);
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${xmlEscape(spoken)}</prosody></voice></speak>`;

  return new Promise<{ audio: Buffer; wordTimings: WordTiming[] }>((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: {
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: `muid=${edgeMuid()};`,
      },
    });
    const chunks: Buffer[] = [];
    const wordTimings: WordTiming[] = [];
    let settled = false;
    let idle: NodeJS.Timeout;
    const timer = setTimeout(() => fail(new Error("Edge TTS timed out.")), edgeTimeoutMs(spoken));
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail(new Error("Edge TTS stopped responding.")), 20_000);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      ws.close();
      if (!chunks.length) {
        reject(new Error("Edge TTS returned no audio."));
        return;
      }
      resolve({ audio: Buffer.concat(chunks), wordTimings });
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      ws.close();
      reject(error);
    };

    ws.on("open", () => {
      armIdle();
      const stamp = edgeTimestamp();
      ws.send(
        `X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`,
      );
      const requestId = crypto.randomUUID().replace(/-/g, "");
      ws.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    });

    ws.on("message", (data, isBinary) => {
      armIdle();
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (isBinary || (buf.length >= 2 && buf[0] === 0 && buf[1]! > 0 && !buf.subarray(0, 80).toString("utf8").includes("Path:"))) {
        if (buf.length < 2) return;
        const headerLength = buf.readUInt16BE(0);
        if (headerLength <= 0 || headerLength > buf.length) return;
        const header = buf.subarray(0, headerLength).toString("utf8");
        if (!header.includes("Path:audio")) return;
        const audio = buf.subarray(headerLength + 2);
        if (header.includes("Content-Type:audio/mpeg") && audio.length) chunks.push(audio);
        return;
      }
      const asText = buf.toString("utf8");
      const split = asText.indexOf("\r\n\r\n");
      const header = split >= 0 ? asText.slice(0, split) : asText;
      const body = split >= 0 ? asText.slice(split + 4) : "";
      if (header.includes("Path:turn.end")) {
        finish();
        return;
      }
      if (header.includes("Path:audio.metadata") && body) {
        try {
          const parsed = JSON.parse(body) as {
            Metadata?: { Type?: string; Data?: { Offset?: number; Duration?: number; text?: { Text?: string } } }[];
          };
          for (const item of parsed.Metadata ?? []) {
            if (item.Type !== "WordBoundary") continue;
            const offset = item.Data?.Offset ?? 0;
            const duration = item.Data?.Duration ?? 0;
            const word = item.Data?.text?.Text?.trim();
            if (!word) continue;
            wordTimings.push({ word, startMs: offset / 10000, endMs: (offset + duration) / 10000 });
          }
        } catch {
          /* metadata is optional */
        }
      }
    });
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      fail(new EdgeRejected(response.statusCode ?? 0, response.headers.date));
    });
    ws.on("error", (error) => {
      if (error.message.includes("Unexpected server response")) return;
      fail(error);
    });
    ws.on("close", () => {
      if (settled) return;
      if (chunks.length) finish();
      else fail(new Error("Edge TTS closed before sending audio."));
    });
  });
}

export async function speakWithEdge(text: string, voice: string, speed = 1) {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await speakOnce(text, voice, speed);
    } catch (error) {
      last = error;
      if (error instanceof EdgeRejected && error.serverDate) noteEdgeClock(error.serverDate);
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
  throw last instanceof Error ? last : new Error("Edge TTS failed.");
}

async function kokoro(text: string, gender: string) {
  const base = (process.env.KOKORO_URL || "http://127.0.0.1:8880").replace(/\/$/, "");
  const response = await fetch(`${base}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "kokoro",
      input: text,
      voice: gender === "female" ? "af_bella" : "am_adam",
      response_format: "mp3",
    }),
  });
  if (!response.ok) throw new Error(`Kokoro failed (${response.status}). Is it running at KOKORO_URL?`);
  return Buffer.from(await response.arrayBuffer());
}

async function eleven(text: string, gender: string) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is empty.");
  const voice = gender === "female" ? "21m00Tcm4TlvDq8ikWAM" : "pNInz6obpgDQGcFmaJgB";
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2" }),
  });
  if (!response.ok) throw new Error(`ElevenLabs failed (${response.status}).`);
  const body = (await response.json()) as {
    audio_base64?: string;
    alignment?: { characters?: string[]; character_start_times_seconds?: number[]; character_end_times_seconds?: number[] };
  };
  if (!body.audio_base64) throw new Error("ElevenLabs returned no audio.");
  const chars = body.alignment?.characters ?? [];
  const starts = body.alignment?.character_start_times_seconds ?? [];
  const ends = body.alignment?.character_end_times_seconds ?? [];
  const wordTimings: WordTiming[] = [];
  let word = "";
  let startMs = 0;
  chars.forEach((char, index) => {
    if (char.trim() === "") {
      if (word) wordTimings.push({ word, startMs, endMs: (ends[index - 1] ?? ends[index] ?? 0) * 1000 });
      word = "";
      return;
    }
    if (!word) startMs = (starts[index] ?? 0) * 1000;
    word += char;
  });
  if (word) wordTimings.push({ word, startMs, endMs: (ends[ends.length - 1] ?? 0) * 1000 });
  return { audio: Buffer.from(body.audio_base64, "base64"), wordTimings };
}

export async function synthesizeSpeech(input: {
  text: string;
  voiceId: string;
  gender: string;
  language: string;
  speed?: number;
}) {
  const provider = (process.env.TTS_PROVIDER || "edge").toLowerCase();
  const speed = input.speed ?? 1;
  if (provider === "edge") {
    const voice = edgeVoiceFor({ providerVoiceId: input.voiceId, gender: input.gender, language: input.language });
    try {
      return await speakWithEdge(input.text, voice, speed);
    } catch (error) {
      const fallback = input.gender === "female" ? "en-US-AriaNeural" : "en-US-AndrewNeural";
      if (voice !== fallback && input.language === "en") {
        try {
          return await speakWithEdge(input.text, fallback, speed);
        } catch {
          /* try local speech below */
        }
      }
      try {
        const file = `/tmp/faceless-espeak-${crypto.randomBytes(4).toString("hex")}.mp3`;
        await espeakToMp3(input.text, file);
        const audio = await fs.readFile(file);
        await fs.rm(file, { force: true });
        const duration = await probeDurationFile(audio);
        return {
          audio,
          wordTimings: estimateTimings(input.text, duration * 1000),
          fallback: error instanceof Error ? error.message : "Edge TTS failed",
        };
      } catch {
        throw error;
      }
    }
  }
  if (provider === "kokoro") {
    const audio = await kokoro(input.text, input.gender);
    const duration = await probeDurationFile(audio);
    return { audio, wordTimings: estimateTimings(input.text, duration * 1000) };
  }
  if (provider === "elevenlabs") return eleven(input.text, input.gender);
  throw new Error(`Unknown TTS_PROVIDER "${provider}".`);
}

async function probeDurationFile(audio: Buffer) {
  const file = `/tmp/faceless-probe-${crypto.randomBytes(4).toString("hex")}.mp3`;
  await fs.writeFile(file, audio);
  try {
    return await probeDuration(file);
  } finally {
    await fs.rm(file, { force: true });
  }
}
