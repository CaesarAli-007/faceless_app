"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ProgressBar, StatusChip, statusLabel } from "@/components/status-chip";
import { api, sendJson } from "@/lib/client";

type Reel = {
  id: string;
  title: string | null;
  prompt: string | null;
  status: string;
  progress: number;
  error: string | null;
  hasFile: boolean;
  durationSec: number | null;
  createdAt: string;
};

const BUSY = new Set(["PENDING", "SCRIPTING", "VOICING", "IMAGING", "CAPTIONING", "RENDERING", "PUBLISHING"]);
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

export default function HomePage() {
  const client = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const reels = useQuery({
    queryKey: ["videos"],
    queryFn: () => api<Reel[]>("/api/videos"),
    refetchInterval: (query) => ((query.state.data ?? []).some((reel) => BUSY.has(reel.status)) ? 2000 : false),
  });
  const make = useMutation({
    mutationFn: () => sendJson<Reel>("/api/reels", "POST", { prompt: prompt.trim() }),
    onSuccess: (reel) => {
      setFocusId(reel.id);
      setPrompt("");
      toast.success("Making your reel");
      void client.invalidateQueries({ queryKey: ["videos"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const rows = reels.data ?? [];
  const focus = rows.find((reel) => reel.id === focusId) ?? rows[0] ?? null;
  const ready = focus ? READY.has(focus.status) && focus.hasFile : false;

  return (
    <div>
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <form
          className="panel p-6 md:p-8"
          onSubmit={(event) => {
            event.preventDefault();
            if (prompt.trim().length < 8) {
              toast.error("Describe the reel in at least a few words.");
              return;
            }
            make.mutate();
          }}
        >
          <div className="kicker">The prompt</div>
          <h1 className="display mt-2 text-5xl leading-none md:text-6xl">Explain the reel.</h1>
          <p className="mt-4 max-w-xl text-muted">
            Write the idea, or paste the words you want spoken. You get a vertical video with pictures, a voiceover, and captions.
          </p>
          <label className="mt-6 block">
            <span className="sr-only">Prompt</span>
            <textarea
              className="field min-h-52 text-lg leading-7"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Explain why leaves change color in autumn. Keep it plain, calm, and about thirty seconds."
              maxLength={2000}
            />
          </label>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <button className="btn" type="submit" disabled={make.isPending}>
              {make.isPending ? "Starting…" : "Make the reel"}
            </button>
            <p className="text-sm text-muted">Then download the MP4 and upload it wherever you want.</p>
          </div>
        </form>

        <aside className="mx-auto w-full max-w-[340px]">
          <div className="kicker mb-3">Preview</div>
          <div className="overflow-hidden rounded-[32px] border border-white/10 bg-black shadow-lift">
            <div className="relative aspect-[9/16]">
              {ready && focus ? (
                <video key={focus.id} src={`/api/videos/${focus.id}/file`} controls playsInline className="h-full w-full bg-black object-contain" />
              ) : (
                <div className="grid h-full place-items-center px-8 text-center">
                  <div>
                    <div className="display text-4xl">{focus ? statusLabel(focus.status) : "Empty"}</div>
                    <p className="mt-3 text-sm leading-6 text-muted">
                      {focus ? STAGE[focus.status] || focus.error || "The picture shows up when the render finishes." : "Your video plays here."}
                    </p>
                    {focus && BUSY.has(focus.status) && (
                      <div className="mt-5">
                        <ProgressBar value={focus.progress} />
                        <div className="mt-2 text-xs text-muted">{focus.progress}%</div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          {focus && (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-bold">{focus.title || focus.prompt || "Untitled reel"}</div>
                  {focus.durationSec ? <div className="text-sm text-muted">{Math.round(focus.durationSec)}s</div> : null}
                </div>
                <StatusChip status={focus.status} />
              </div>
              {focus.error && <p className="mt-3 text-sm text-[#ffb4a8]">{focus.error}</p>}
              {ready && (
                <a className="btn mt-4 w-full" href={`/api/videos/${focus.id}/file?download=1`} download={fileName(focus.title)}>
                  Download video
                </a>
              )}
              {focus.status === "FAILED" && (
                <button
                  className="btn ghost mt-3 w-full"
                  onClick={() => {
                    void sendJson(`/api/videos/${focus.id}/retry`, "POST")
                      .then(() => {
                        toast.success("Trying again");
                        void client.invalidateQueries({ queryKey: ["videos"] });
                      })
                      .catch((error: Error) => toast.error(error.message));
                  }}
                >
                  Try again
                </button>
              )}
            </div>
          )}
        </aside>
      </div>

      <section className="mt-12">
        <h2 className="kicker">Your reels</h2>
        {rows.length === 0 && !reels.isLoading && <p className="mt-3 text-muted">Nothing here yet. The first one shows up as soon as you describe it.</p>}
        <div className="mt-4 grid gap-3">
          {rows.map((reel) => (
            <div key={reel.id} className={`panel flex flex-wrap items-center gap-4 p-4 ${focus?.id === reel.id ? "border-cadmium/50" : ""}`}>
              <button className="min-w-0 flex-1 text-left" onClick={() => setFocusId(reel.id)}>
                <div className="truncate font-bold">{reel.title || reel.prompt || "Untitled reel"}</div>
                <div className="truncate text-sm text-muted">{reel.prompt || statusLabel(reel.status)}</div>
              </button>
              <StatusChip status={reel.status} />
              {READY.has(reel.status) && reel.hasFile ? (
                <a className="btn" href={`/api/videos/${reel.id}/file?download=1`} download={fileName(reel.title)}>
                  Download
                </a>
              ) : (
                <Link className="btn ghost" href={`/videos/${reel.id}`}>
                  Open
                </Link>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
