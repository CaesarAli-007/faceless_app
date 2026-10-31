"use client";

import Link from "next/link";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative z-10 mx-auto min-h-screen max-w-6xl px-4 py-6 md:px-8 md:py-8">
      <header className="mb-8 flex items-end justify-between gap-6">
        <Link href="/" className="block">
          <div className="kicker">On this computer</div>
          <div className="display mt-1 text-5xl leading-none">
            Reels<span className="ml-1 inline-block h-2 w-2 rounded-full bg-cadmium align-middle" />
          </div>
        </Link>
        <p className="hidden max-w-xs text-right text-sm leading-6 text-muted md:block">
          Describe the reel. Download the video. Post it wherever you want.
        </p>
      </header>
      <main>{children}</main>
    </div>
  );
}
