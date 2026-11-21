import { NextResponse } from "next/server";
import { pool } from "@/db";
import { resolveRequestActor } from "@/lib/identity";

export const dynamic = "force-dynamic";

interface JobRow {
  id: string;
  status: string;
  result: { stage?: string } | null;
  productId: string | null;
  productName: string | null;
  createdAt: Date;
  lastError: string | null;
}

export async function GET(req: Request) {
  if (!(await resolveRequestActor(req))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const result = await pool.query<JobRow>(`
    SELECT job.id, job.status,
           CASE WHEN job.result ? 'stage'
             THEN jsonb_build_object('stage', job.result->>'stage')
             ELSE '{}'::jsonb
           END AS result,
           job.payload->>'productId' AS "productId",
           product.name AS "productName",
           job.created_at AS "createdAt",
           job.last_error AS "lastError"
    FROM pipeline_jobs AS job
    LEFT JOIN products AS product ON product.id = job.payload->>'productId'
    WHERE job.status IN ('QUEUED', 'RUNNING')
       OR (job.status = 'FAILED' AND job.updated_at >= now() - interval '15 minutes')
    ORDER BY job.created_at DESC
    LIMIT 100
  `);
  return NextResponse.json({ jobs: result.rows });
}
