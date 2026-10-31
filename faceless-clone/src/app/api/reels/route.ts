import { createReel } from "@/server/handlers";

export const dynamic = "force-dynamic";
export const POST = (req: Request) => createReel(req);
