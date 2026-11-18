import { pool } from "@/db";
import { runPipeline, serverActorByRole } from "@/lib/actions";

type QueueRow = {
  id: string;
  job_type: string;
  payload: Record<string, unknown>;
  attempts: number;
};

const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 1_000;

let worker: Promise<void> | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid queued job field: ${key}`);
  }
  return value;
}

async function claimJob(): Promise<QueueRow | null> {
  const result = await pool.query<QueueRow>(`
    WITH candidate AS (
      SELECT id
      FROM pipeline_jobs
      WHERE (status = 'QUEUED' AND available_at <= now())
         OR (status = 'RUNNING' AND locked_at < now() - interval '5 minutes')
      ORDER BY available_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE pipeline_jobs AS job
    SET status = 'RUNNING',
        attempts = job.attempts + 1,
        locked_at = now(),
        updated_at = now()
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.id, job.job_type, job.payload, job.attempts
  `);
  return result.rows[0] ?? null;
}

async function executeJob(job: QueueRow): Promise<{ sessionId: string; status: string }> {
  if (job.job_type !== "github_push") {
    throw new Error(`Unsupported queued job type: ${job.job_type}`);
  }
  const payload = job.payload;
  const actor = await serverActorByRole("WRITER");
  if (!actor) throw new Error("No writer identity is provisioned for webhook runs");
  return runPipeline({
    productId: requiredString(payload, "productId"),
    baseRevision: requiredString(payload, "baseRevision"),
    headRevision: requiredString(payload, "headRevision"),
    changeSummary: typeof payload.changeSummary === "string" ? payload.changeSummary : "",
    provider: requiredString(payload, "provider"),
    model: requiredString(payload, "model"),
    diffText: requiredString(payload, "diffText"),
    triggerType: "WEBHOOK",
    actor,
    title: requiredString(payload, "title"),
    deliveryId: requiredString(payload, "deliveryId"),
    truncated: payload.truncated === true,
  });
}

async function runWorker(): Promise<void> {
  while (true) {
    let job: QueueRow | null;
    try {
      job = await claimJob();
    } catch (error) {
      console.error("[docline] pipeline queue claim failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      await sleep(5_000);
      continue;
    }
    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    try {
      const result = await executeJob(job);
      await pool.query(
        `UPDATE pipeline_jobs
         SET status = 'COMPLETED', result = $2::jsonb, locked_at = NULL,
             last_error = NULL, updated_at = now()
         WHERE id = $1`,
        [job.id, JSON.stringify(result)]
      );
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "unknown";
      const failed = job.attempts >= MAX_ATTEMPTS;
      const delaySeconds = Math.min(300, 2 ** job.attempts * 5);
      await pool.query(
        `UPDATE pipeline_jobs
         SET status = $2,
             available_at = CASE WHEN $2 = 'QUEUED'
               THEN now() + ($3 * interval '1 second') ELSE available_at END,
             locked_at = NULL, last_error = $4, updated_at = now()
         WHERE id = $1`,
        [job.id, failed ? "FAILED" : "QUEUED", delaySeconds, `Execution failed (${errorType})`]
      );
      console.error("[docline] pipeline job failed", {
        jobId: job.id,
        attempt: job.attempts,
        willRetry: !failed,
        errorType,
      });
    }
  }
}

export function startPipelineJobWorker(): void {
  worker ??= runWorker();
  void worker.catch((error) => {
    console.error("[docline] pipeline worker stopped", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
  });
}
