import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { pipelineJobs } from "@/db/schema";
import { resolveRequestActor } from "@/lib/identity";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await resolveRequestActor(req))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const { id } = await params;
  const [job] = await db
    .select({
      id: pipelineJobs.id,
      status: pipelineJobs.status,
      attempts: pipelineJobs.attempts,
      lastError: pipelineJobs.lastError,
      result: pipelineJobs.result,
      createdAt: pipelineJobs.createdAt,
      updatedAt: pipelineJobs.updatedAt,
    })
    .from(pipelineJobs)
    .where(eq(pipelineJobs.id, id));
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  return NextResponse.json(job);
}
