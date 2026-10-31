"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ProgressBar, StatusChip, statusLabel } from "@/components/status-chip";
import { api, sendJson } from "@/lib/client";

type Scene = { narration: string; imagePrompt: string };
type Video = {
  id: string;
  title: string | null;
  prompt: string | null;
  status: string;
  progress: number;
  error: string | null;
  hasFile: boolean;
  durationSec: number | null;
  updatedAt: string;
  script: { scenes: Scene[] } | null;
};

const BUSY = new Set(["PENDING", "SCRIPTING", "VOICING", "IMAGING", "CAPTIONING", "RENDERING"]);
const READY = new Set(["READY", "APPROVED", "PUBLISHED"]);

const STAGE: Record<string, string> = {
  PENDING: "Waiting to start",
  SCRIPTING: "Writing the voiceover",
  VOICING: "Recording the voice",
  IMAGING: "Choosing the pictures",
  CAPTIONING: "Timing the captions",
  RENDERING: "Rendering the video",
};

function fileName(title: string | null) {
  const base = (title || "reel").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
  return `${base || "reel"}.mp4`;
}

export default function VideoPage() {
  const params = useParams<{ id: string }>();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["video", params.id],
    queryFn: () => api<Video>(`/api/videos/${params.id}`),
    refetchInterval: (q) => (q.state.data && BUSY.has(q.state.data.status) ? 2000 : false),
  });
  const retry = useMutation({
    mutationFn: () => sendJson(`/api/videos/${params.id}/retry`, "POST"),
    onSuccess: () => {
      toast.success("Trying again");
      void client.invalidateQueries({ queryKey: ["video", params.id] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const video = query.data;
  if (!video) return <div className="skeleton mx-auto h-[70vh] max-w-[380px]" />;
  const ready = READY.has(video.status) && video.hasFile;

  return (
    <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[380px_minmax(0,1fr)]">
      <div>
        <Link href="/" className="kicker">Back</Link>
        <div className="mt-3 overflow-hidden rounded-[32px] border border-white/10 bg-black">
          <div className="relative aspect-[9/16]">
            {ready ? (
              <video key={video.updatedAt} src={`/api/videos/${video.id}/file`} controls playsInline className="h-full w-full bg-black" />
            ) : (
              <div className="grid h-full place-items-center px-8 text-center">
                <div>
                  <div className="display text-4xl">{statusLabel(video.status)}</div>
                  <p className="mt-3 text-sm text-muted">{STAGE[video.status] || "The picture shows up when the render finishes."}</p>
                  {BUSY.has(video.status) && (
                    <div className="mt-5">
                      <ProgressBar value={video.progress} />
                      <div className="mt-2 text-xs text-muted">{video.progress}%</div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        {ready && (
          <a className="btn mt-4 w-full" href={`/api/videos/${video.id}/file?download=1`} download={fileName(video.title)}>
            Download video
          </a>
        )}
      </div>
      <div className="pt-8">
        <div className="flex items-center gap-3">
          <StatusChip status={video.status} />
          {video.durationSec ? <span className="text-sm text-muted">{Math.round(video.durationSec)} seconds</span> : null}
        </div>
        <h1 className="display mt-3 text-5xl">{video.title || "Your reel"}</h1>
        {video.prompt && <p className="mt-4 max-w-xl text-muted">{video.prompt}</p>}
        {video.error && <p className="mt-4 text-[#ffb4a8]">{video.error}</p>}
        {video.status === "FAILED" && (
          <button className="btn mt-4" onClick={() => retry.mutate()} disabled={retry.isPending}>
            Try again
          </button>
        )}
        {video.script && (
          <>
            <h2 className="kicker mt-10">Voiceover</h2>
            <ol className="mt-3 grid gap-3">
              {video.script.scenes.map((scene, index) => (
                <li key={index} className="rounded-2xl border border-white/10 px-4 py-3">
                  <span className="text-xs text-muted">Scene {index + 1}</span>
                  <p className="mt-1">{scene.narration}</p>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}
