import { NextResponse } from "next/server";
import { db } from "@/db";
import { pipelineJobs } from "@/db/schema";
import { runPipeline, uid } from "@/lib/actions";
import { resolveMachineActor, resolveRequestActor } from "@/lib/identity";
import { readRequestBodyText } from "@/lib/request-body";

export const dynamic = "force-dynamic";
export const maxDuration = 180;
const MAX_REQUEST_BYTES = 1_000_000;

export async function POST(req: Request) {
  try {
    const actor = (await resolveMachineActor(req)) ?? (await resolveRequestActor(req));
    if (!actor) {
      return NextResponse.json(
        { error: "Authentication required. Sign in, or send Authorization: Bearer PIPELINE_API_TOKEN for CI." },
        { status: 401 }
      );
    }
    const rawBody = await readRequestBodyText(req, MAX_REQUEST_BYTES);
    if (rawBody === null) {
      return NextResponse.json({ error: "Request body exceeds the 1 MB limit." }, { status: 413 });
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    const required = ["productId", "baseRevision", "headRevision", "diffText"];
    for (const key of required) {
      if (typeof body[key] !== "string" || !body[key]) {
        return NextResponse.json({ error: `Missing field: ${key}` }, { status: 400 });
      }
    }
    const runInput = {
      productId: body.productId as string,
      baseRevision: body.baseRevision as string,
      headRevision: body.headRevision as string,
      changeSummary: typeof body.changeSummary === "string" ? body.changeSummary.slice(0, 4000) : "",
      provider: typeof body.provider === "string" ? body.provider : "local",
      model: typeof body.model === "string" ? body.model : "docline-local-1",
      diffText: (body.diffText as string).slice(0, 250_000),
      truncated: (body.diffText as string).length > 250_000,
      triggerType: typeof body.triggerType === "string" ? body.triggerType : "MANUAL",
      actor,
      title: typeof body.title === "string" && body.title ? body.title : undefined,
    };
    if (body.async === true) {
      const jobId = uid();
      await db.insert(pipelineJobs).values({
        id: jobId,
        jobType: "manual_run",
        dedupeKey: `manual:${jobId}`,
        payload: {
          productId: runInput.productId,
          baseRevision: runInput.baseRevision,
          headRevision: runInput.headRevision,
          changeSummary: runInput.changeSummary,
          provider: runInput.provider,
          model: runInput.model,
          diffText: runInput.diffText,
          triggerType: runInput.triggerType,
          actorId: actor.id,
          title: runInput.title,
          truncated: runInput.truncated,
        },
      });
      return NextResponse.json({ jobId, status: "QUEUED" }, { status: 202 });
    }
    const result = await runPipeline(runInput);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Run failed" },
      { status: 500 }
    );
  }
}
