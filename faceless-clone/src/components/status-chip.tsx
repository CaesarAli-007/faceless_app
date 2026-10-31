const TONE: Record<string, string> = {
  READY: "bg-phosphor text-[#1a1a0a]",
  APPROVED: "bg-phosphor text-[#1a1a0a]",
  PUBLISHED: "bg-[#d6ffb0] text-[#142006]",
  FAILED: "bg-[#ffb4a8] text-[#2a0c08]",
  CANCELLED: "bg-white/10 text-muted",
};

const LABEL: Record<string, string> = {
  PENDING: "Queued",
  SCRIPTING: "Writing",
  VOICING: "Voice",
  IMAGING: "Pictures",
  CAPTIONING: "Captions",
  RENDERING: "Rendering",
  READY: "Ready",
  APPROVED: "Ready",
  FAILED: "Failed",
  PUBLISHING: "Publishing",
  PUBLISHED: "Published",
  CANCELLED: "Cancelled",
};

export function statusLabel(status: string) {
  return LABEL[status] ?? status;
}

export function StatusChip({ status }: { status: string }) {
  const active = ["SCRIPTING", "VOICING", "IMAGING", "CAPTIONING", "RENDERING", "PUBLISHING", "PENDING"].includes(status);
  return (
    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide ${TONE[status] ?? (active ? "bg-cadmium text-[#1a0c08]" : "bg-white/10")}`}>
      {statusLabel(status)}
    </span>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-cadmium transition-[width] duration-500" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
