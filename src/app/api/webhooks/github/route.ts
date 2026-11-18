import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  auditEvents,
  documentEdits,
  documents,
  pipelineJobs,
  products,
  sessions,
} from "@/db/schema";
import { uid } from "@/lib/actions";
import { readRequestBodyText } from "@/lib/request-body";

/** "https://github.com/Org/Relay.git" → "org/relay". No wildcards, no LIKE. */
function normalizeRepoRef(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

/**
 * Exact repository mapping. `owner/repo` after normalization must equal the
 * configured product repo (with or without host prefix). `org/relay` never
 * matches `org/relay-docs`, and `_` is just a character.
 */
function matchProductByRepo(
  all: { id: string; name: string; repoUrl: string; docsRepoUrl?: string }[],
  fullName: string,
  docsRepository = false
) {
  const target = fullName.toLowerCase();
  return all.find((p) => {
    const ref = normalizeRepoRef(
      docsRepository ? p.docsRepoUrl || p.repoUrl : p.repoUrl
    );
    return ref === target || ref.endsWith(`/${target}`);
  });
}

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GitHub release-push and pull-request-merge webhooks.
 *
 * Contract parity with the FastAPI service (`app/api/webhooks.py`):
 *   - HMAC-SHA256 over the raw body, `sha256=` prefix, constant-time compare
 *   - 503 when GITHUB_WEBHOOK_SECRET is not configured (fail closed)
 *   - 401 on a bad signature
 *   - unsupported events, tag pushes, and branch deletions are acknowledged
 *     with `{ status: "ignored" }` instead of an error
 *
 * Differences from the Python service, by design of this unified app:
 *   - the patch target lives in the database (documents table), so no
 *     SOURCE_REPO_PATH / DOCS_REPO_PATH path validation is needed
 *   - accepted work is stored in PostgreSQL and processed by the app worker
 *
 * Optional env: GITHUB_TOKEN (private repos), GITHUB_API_BASE (Enterprise).
 */

const EMPTY_SHA = "0".repeat(40);
const MAX_WEBHOOK_BODY_BYTES = 1_000_000;
const MAX_DIFF_BYTES = 250_000;

function verifySignature(secret: string, body: string, header: string | null): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface PushPayload {
  ref?: string;
  before?: string;
  after?: string;
  repository?: { full_name?: string; html_url?: string };
  head_commit?: { message?: string } | null;
  compare?: string;
}

interface PullRequestPayload {
  action?: string;
  repository?: { full_name?: string };
  pull_request?: {
    merged?: boolean;
    html_url?: string;
    head?: { ref?: string };
  };
}

/** Fetch the unified diff for before...after from the GitHub compare API. */
async function fetchCompareDiff(fullName: string, before: string, head: string) {
  const apiBase = process.env.GITHUB_API_BASE?.replace(/\/+$/, "") || "https://api.github.com";
  const token = process.env.GITHUB_TOKEN;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(
      `${apiBase}/repos/${fullName}/compare/${before}...${head}`,
      {
        signal: ctrl.signal,
        headers: {
          accept: "application/vnd.github.diff",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "x-github-api-version": "2022-11-28",
        },
      }
    );
    if (!res.ok) return { error: `GitHub compare API answered ${res.status}` } as const;
    const reader = res.body?.getReader();
    if (!reader) return { error: "GitHub compare API returned an empty response body" } as const;
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = MAX_DIFF_BYTES - total;
        if (value.byteLength > remaining) {
          if (remaining > 0) chunks.push(value.slice(0, remaining));
          total = MAX_DIFF_BYTES;
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { diff: new TextDecoder().decode(bytes), truncated } as const;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "diff fetch failed" } as const;
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (
    !secret ||
    (process.env.NODE_ENV === "production" &&
      (secret.length < 32 || secret.toLowerCase().includes("replace-with")))
  ) {
    return NextResponse.json(
      { status: "error", message: "Webhook authentication requires a non-placeholder secret of at least 32 characters" },
      { status: 503 }
    );
  }

  const body = await readRequestBodyText(req, MAX_WEBHOOK_BODY_BYTES);
  if (body === null) {
    return NextResponse.json(
      { status: "error", message: "Webhook payload exceeds the 1 MB limit" },
      { status: 413 }
    );
  }
  const signature = req.headers.get("x-hub-signature-256");
  if (!verifySignature(secret, body, signature)) {
    return NextResponse.json(
      { status: "error", message: "Invalid webhook signature" },
      { status: 401 }
    );
  }

  const event = req.headers.get("x-github-event");
  if (event !== "push" && event !== "pull_request") {
    return NextResponse.json({ status: "ignored", message: "Event is not handled" });
  }

  let payload: PushPayload & PullRequestPayload;
  try {
    payload = JSON.parse(body) as PushPayload;
  } catch {
    return NextResponse.json(
      { status: "error", message: "Invalid GitHub webhook payload" },
      { status: 422 }
    );
  }

  if (event === "pull_request") {
    const pullRequest = payload.pull_request;
    const branch = pullRequest?.head?.ref ?? "";
    if (payload.action !== "closed" || pullRequest?.merged !== true) {
      return NextResponse.json({ status: "ignored", message: "Pull request was not merged" });
    }
    if (!branch.startsWith("docline-") || !pullRequest.html_url) {
      return NextResponse.json({ status: "ignored", message: "Pull request is not a pipeline proposal" });
    }
    const fullName = payload.repository?.full_name ?? "";
    const all = await db
      .select({
        id: products.id,
        name: products.name,
        repoUrl: products.repoUrl,
        docsRepoUrl: products.docsRepoUrl,
      })
      .from(products);
    const product = matchProductByRepo(all, fullName, true);
    if (!product) {
      return NextResponse.json({ status: "ignored", message: "Documentation repository is not mapped" });
    }
    const sessionId = branch.slice("docline-".length);
    const [session] = await db
      .select({ id: sessions.id, productId: sessions.productId, status: sessions.status, proposal: sessions.proposal })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const proposal = session?.proposal as { pullRequestBranch?: string; pullRequestUrl?: string } | null;
    if (
      !session ||
      session.productId !== product.id ||
      session.status !== "PR_OPEN" ||
      !proposal ||
      proposal.pullRequestBranch !== branch ||
      proposal.pullRequestUrl !== pullRequest.html_url
    ) {
      return NextResponse.json({ status: "ignored", message: "No matching open pipeline proposal" });
    }
    const mergedAt = new Date();
    await db.transaction(async (tx) => {
      const [lockedSession] = await tx
        .select({ id: sessions.id, status: sessions.status })
        .from(sessions)
        .where(and(eq(sessions.id, session.id), eq(sessions.status, "PR_OPEN")))
        .for("update");
      if (!lockedSession) return;

      const edits = await tx
        .select()
        .from(documentEdits)
        .where(eq(documentEdits.sessionId, session.id));
      const docsToUpdate = new Map<
        string,
        { path: string; version: number; content: string }
      >();
      const conflicts: string[] = [];
      for (const edit of edits) {
        let current = docsToUpdate.get(edit.documentId);
        if (!current) {
          const [doc] = await tx
            .select()
            .from(documents)
            .where(eq(documents.id, edit.documentId))
            .for("update");
          if (!doc || doc.version !== edit.docVersion) {
            conflicts.push(edit.docPath);
            break;
          }
          current = {
            path: doc.path,
            version: doc.version,
            content: doc.content,
          };
          docsToUpdate.set(edit.documentId, current);
        }
        if (!current.content.includes(edit.beforeContent)) {
          conflicts.push(edit.docPath);
          break;
        }
        current.content = current.content.replace(edit.beforeContent, () => edit.afterContent);
      }

      if (conflicts.length === 0) {
        for (const [documentId, doc] of docsToUpdate) {
          await tx
            .update(documents)
            .set({ content: doc.content, version: doc.version + 1, updatedAt: mergedAt })
            .where(eq(documents.id, documentId));
          await tx.insert(auditEvents).values({
            id: uid(),
            sessionId: session.id,
            actorId: null,
            action: "DOC_PUBLISHED",
            detail: {
              docPath: doc.path,
              fromVersion: doc.version,
              toVersion: doc.version + 1,
              source: "github_merge",
            },
            createdAt: mergedAt,
          });
        }
      } else {
        await tx.insert(auditEvents).values({
          id: uid(),
          sessionId: session.id,
          actorId: null,
          action: "DOC_SYNC_SKIPPED",
          detail: { reason: "stale_document_snapshot", docPaths: conflicts },
          createdAt: mergedAt,
        });
      }

      const updated = await tx
        .update(sessions)
        .set({ status: "PUBLISHED", publishedAt: mergedAt, updatedAt: mergedAt })
        .where(and(eq(sessions.id, session.id), eq(sessions.status, "PR_OPEN")))
        .returning({ id: sessions.id });
      if (updated.length > 0) {
        await tx.insert(auditEvents).values({
          id: uid(),
          sessionId: session.id,
          actorId: null,
          action: "PUBLISHED",
          detail: { url: pullRequest.html_url, merged: true, documentSync: conflicts.length === 0 },
          createdAt: mergedAt,
        });
      }
    });
    return NextResponse.json({ status: "published", sessionId });
  }

  const ref = payload.ref ?? "";
  const before = payload.before ?? "";
  const afterTail = payload.after ?? "";
  if (!ref.startsWith("refs/heads/") || afterTail === EMPTY_SHA) {
    return NextResponse.json({ status: "ignored", message: "Push does not update a branch" });
  }
  if (before === EMPTY_SHA) {
    return NextResponse.json({
      status: "ignored",
      message: "Branch creation has no compare base",
    });
  }

  const fullName = payload.repository?.full_name ?? "";
  if (!fullName) {
    return NextResponse.json(
      { status: "error", message: "Payload carries no repository name" },
      { status: 422 }
    );
  }

  // Map the pushed repository to a registered product, exactly.
  const all = await db
    .select({
      id: products.id,
      name: products.name,
      repoUrl: products.repoUrl,
      docsRepoUrl: products.docsRepoUrl,
    })
    .from(products);
  const product = matchProductByRepo(all, fullName);
  if (!product) {
    return NextResponse.json({
      status: "ignored",
      message: `No product is mapped to repository ${fullName}`,
    });
  }

  const fetched = await fetchCompareDiff(fullName, before, afterTail);
  if ("error" in fetched) {
    return NextResponse.json(
      { status: "error", message: `Could not resolve release diff: ${fetched.error}` },
      { status: 502 }
    );
  }
  const diffText = fetched.diff;
  if (!diffText.trim()) {
    return NextResponse.json({
      status: "ignored",
      message: "Compare range produced an empty diff",
    });
  }

  const branch = ref.replace("refs/heads/", "");

  // Documentation runs belong to release lines, not every feature branch.
  const allowed = new RegExp(process.env.PIPELINE_WEBHOOK_BRANCHES ?? "^(main|master|release/.*)$");
  if (!allowed.test(branch)) {
    return NextResponse.json({ status: "ignored", message: `Branch ${branch} is not a release line` });
  }
  const shortAfter = afterTail.slice(0, 7);
  const headMessage = payload.head_commit?.message?.split("\n")[0]?.slice(0, 72);
  // Persist the job before acknowledging so a process restart cannot lose it.
  const deliveryId = req.headers.get("x-github-delivery") ?? `${fullName.toLowerCase()}:${afterTail}`;
  const changeSummary = headMessage ?? "";
  const title = `${product.name} ${branch}@${shortAfter}${headMessage ? ` — ${headMessage}` : ""}`;
  const provider = process.env.DEFAULT_PROVIDER === "openrouter" ? "openrouter" : "local";
  const model = process.env.DEFAULT_MODEL ?? "docline-local-1";
  const dedupeKey = `github:${fullName.toLowerCase()}:${afterTail}`;
  const jobId = uid();
  await db.insert(pipelineJobs).values({
    id: jobId,
    jobType: "github_push",
    dedupeKey,
    payload: {
      productId: product.id,
      baseRevision: before,
      headRevision: afterTail,
      changeSummary,
      provider,
      model,
      diffText,
      truncated: fetched.truncated,
      title,
      deliveryId,
    },
  }).onConflictDoNothing({ target: pipelineJobs.dedupeKey });
  const [job] = await db
    .select({ id: pipelineJobs.id, status: pipelineJobs.status })
    .from(pipelineJobs)
    .where(eq(pipelineJobs.dedupeKey, dedupeKey));

  return NextResponse.json({
    status: "accepted",
    jobId: job?.id ?? jobId,
    jobStatus: job?.status ?? "QUEUED",
    message: "Pipeline job durably queued",
    deliveryId: deliveryId ?? null,
  }, { status: 202 });
}
