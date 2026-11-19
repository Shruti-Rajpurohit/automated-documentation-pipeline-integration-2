import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  auditEvents,
  documentEdits,
  documents,
  products,
  sessions,
  toneProfiles,
  users,
} from "@/db/schema";
import { createDocumentationPullRequest } from "@/lib/pipeline/github-publisher";
import {
  buildProposal,
  DiffLimitError,
  extractSignals,
  parseDiff,
  retrieveSections,
  validateProposal,
  type Proposal,
  type ToneProfileLite,
} from "@/lib/pipeline/engine";
import { tryOllama, tryOpenRouter } from "@/lib/pipeline/llm";
import { publishLocalFiles } from "@/lib/pipeline/local-publisher";
import type { Actor } from "@/lib/identity";

export const uid = () => crypto.randomUUID();

/**
 * Server-internal actor resolution by role. Trusted callers ONLY: the seed
 * script and the verified GitHub webhook. Request-serving routes resolve
 * actors from the signed session cookie via resolveRequestActor instead.
 */
export async function serverActorByRole(role: string): Promise<Actor | null> {
  const all = await db
    .select({ id: users.id, name: users.name, role: users.role, email: users.email })
    .from(users);
  const wanted = all.find((u) => u.role === role && !u.id.startsWith("u-bot"));
  return wanted ?? (all.find((u) => u.role === role) || null);
}

/** Hash of all draft bodies in insertion order — captured at approval and
 *  re-verified at publish, closing the edit/approve race window. */
export function editsContentHash(afterContents: string[]): string {
  return createHash("sha256").update(afterContents.join("\n\u0000\n")).digest("hex");
}

/** Structural type covering both the pool database and a transaction. */
type DbOrTx = Pick<typeof db, "insert">;

async function audit(
  sessionId: string | null,
  actorId: string | null,
  action: string,
  detail: Record<string, unknown>,
  at: Date,
  tx?: DbOrTx
) {
  await (tx ?? db).insert(auditEvents).values({
    id: uid(),
    sessionId,
    actorId,
    action,
    detail,
    createdAt: at,
  });
}

export interface RunInput {
  productId: string;
  baseRevision: string;
  headRevision: string;
  changeSummary: string;
  provider: string;
  model: string;
  diffText: string;
  triggerType: string;
  actor: Actor | null;
  title?: string;
  deliveryId?: string;
  truncated?: boolean;
}

/**
 * Execute the full pipeline synchronously and persist a review session.
 * `at` lets the seeder anchor runs in the recent past; audits are spaced
 * across the preceding ~35 minutes for a realistic timeline.
 */
export async function runPipeline(
  input: RunInput,
  opts: { at?: Date } = {}
): Promise<{ sessionId: string; status: string }> {
  const at = opts.at ?? new Date();
  const actor = input.actor;

  // Webhook redeliveries are at-least-once: the same delivery id returns the
  // already-created session instead of queueing a duplicate review.
  if (input.deliveryId) {
    const dupes = await db
      .select({ id: sessions.id, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.deliveryId, input.deliveryId));
    if (dupes[0]) return { sessionId: dupes[0].id, status: dupes[0].status };
  }

  const [product] = await db.select().from(products).where(eq(products.id, input.productId));
  if (!product) throw new Error("Unknown product.");
  const [toneRow] = await db
    .select()
    .from(toneProfiles)
    .where(eq(toneProfiles.productId, product.id));
  const tone: ToneProfileLite = toneRow
    ? { voice: toneRow.voice, person: toneRow.person, formality: toneRow.formality, rules: toneRow.rules }
    : { voice: "Direct and plain", person: "second", formality: 2, rules: [] };
  const docs = await db
    .select()
    .from(documents)
    .where(eq(documents.productId, product.id));

  let files: ReturnType<typeof parseDiff> = [];
  let parseLimit: string | null = null;
  if (!input.truncated) {
    try {
      files = parseDiff(input.diffText);
    } catch (error) {
      if (!(error instanceof DiffLimitError)) throw error;
      parseLimit = error.message;
    }
  }
  const signals = parseLimit || input.truncated ? [] : extractSignals(files);

  let proposal: Proposal | null = null;
  let providerNote: string | null = null;
  const incompleteInput = Boolean(input.truncated || parseLimit);
  if ((input.provider === "openrouter" || input.provider === "ollama") && !incompleteInput) {
    const retrieved = retrieveSections(docs, {
      signals,
      diffText: input.diffText,
      changeSummary: input.changeSummary,
      changedFiles: files.map((file) => file.path),
    }).map((result) => result.section);
    const modelInput = {
      model: input.model,
      productName: product.name,
      changeSummary: input.changeSummary,
      diffText: input.diffText,
      tone,
      docs,
      sections: retrieved,
      signals,
    };
    const result = input.provider === "ollama"
      ? await tryOllama(modelInput)
      : await tryOpenRouter(modelInput);
    proposal = result.proposal;
    if (!proposal) {
      providerNote = `${input.provider}_fell_back_to_local: ${result.reason ?? "unknown failure"}`;
    }
  }
  if (!proposal) {
    proposal = buildProposal({
      docs,
      files,
      signals,
      tone,
      diffText: input.diffText,
      changeSummary: input.changeSummary,
    });
  }

  const invalid = validateProposal(proposal, docs, files);
  const insufficientSignals = !invalid && (!proposal.llm || proposal.edits.length === 0) &&
    !incompleteInput && files.length > 0 && signals.length === 0;
  const noReviewableEdit = !incompleteInput && files.length > 0 && proposal.edits.length === 0;
  const needsInvestigation = incompleteInput || insufficientSignals || noReviewableEdit;
  const status = invalid || needsInvestigation
    ? "NEEDS_INVESTIGATION"
    : proposal.edits.length === 0
      ? "NO_UPDATE"
      : "AWAITING_REVIEW";
  const uncertainties = [
    ...(input.truncated
      ? ["The release diff exceeded the ingest limit and was truncated — analysis is partial; investigate manually."]
      : []),
    ...(parseLimit ? [`${parseLimit}; investigate the complete change manually.`] : []),
    ...(insufficientSignals
      ? ["The diff contains source changes that the configured signal extractors could not classify."]
      : []),
    ...(noReviewableEdit
      ? ["The diff contains changes, but the pipeline could not produce a verified documentation edit."]
      : []),
    ...(providerNote ? [`LLM provider notice: ${providerNote}`] : []),
    ...(invalid ? [`Proposal rejected by validator: ${invalid}`] : []),
    ...proposal.uncertainties,
  ];

  // Seeded historical runs spread audits across ~35 minutes; live runs
  // complete in seconds but keep a realistic, ordered trail.
  const spacing = opts.at ? [35, 31, 26, 22].map((m) => m * 60_000) : [8, 6, 3, 0].map((s) => s * 1000);

  const sessionId = uid();
  await db.insert(sessions).values({
    id: sessionId,
    productId: product.id,
    title:
      input.title ??
      `${product.name} ${input.headRevision}${input.changeSummary ? ` — ${input.changeSummary.split(".")[0].slice(0, 72)}` : ""}`,
    status,
    triggerType: input.triggerType,
    baseRevision: input.baseRevision,
    headRevision: input.headRevision,
    changeSummary: input.changeSummary,
    provider: input.provider,
    model: input.model,
    diffText: input.diffText,
    proposal: { llm: proposal.llm, signalCount: signals.length, fileCount: files.length },
    impactStatement: needsInvestigation || invalid
      ? "Manual investigation required before review."
      : proposal.impactStatement,
    uncertainties,
    testsToRun: proposal.testsToRun,
    createdById: actor?.id ?? null,
    deliveryId: input.deliveryId ?? null,
    createdAt: new Date(at.getTime() - spacing[0]),
    updatedAt: at,
  });

  if (!invalid) {
    for (const e of proposal.edits) {
      await db.insert(documentEdits).values({
        id: uid(),
        sessionId,
        documentId: e.documentId,
        docPath: e.docPath,
        sectionHeading: e.sectionHeading,
        beforeContent: e.before,
        afterContent: e.after,
        action: e.action,
        evidence: e.evidence,
        docVersion: e.docVersion,
      });
    }
  }

  await audit(sessionId, actor?.id ?? null, "RUN_STARTED", {
    trigger: input.triggerType,
    ...(input.deliveryId ? { delivery: input.deliveryId } : {}),
    base: input.baseRevision,
    head: input.headRevision,
    provider: input.provider,
    model: input.model,
  }, new Date(at.getTime() - spacing[0]));
  await audit(sessionId, null, "SIGNALS_EXTRACTED", {
    files: files.length,
    signals: signals.map((s) => `${s.kind}:${s.value}`),
  }, new Date(at.getTime() - spacing[1]));
  await audit(sessionId, null, "SECTIONS_MAPPED", {
    edits: proposal.edits.map((e) => ({
      docPath: e.docPath,
      section: e.sectionHeading,
      evidence: e.evidence,
    })),
  }, new Date(at.getTime() - spacing[2]));
  await audit(sessionId, null, "PROPOSAL_READY", {
    llm: proposal.llm,
    status,
    ...(providerNote ? { note: providerNote } : {}),
    ...(invalid ? { invalid } : {}),
  }, new Date(at.getTime() - spacing[3]));

  return { sessionId, status };
}

/**
 * Draft edits are only possible while a session awaits a human decision.
 * Editing an APPROVED draft would bypass review — so it is refused outright
 * rather than silently resetting the approval.
 */
export async function editDraft(input: {
  sessionId: string;
  editId: string;
  content: string;
  actor: Actor | null;
}) {
  const actor = input.actor;
  if (!actor) return { ok: false as const, error: "Authentication required." };
  if (actor.role !== "WRITER" && actor.role !== "REVIEWER") {
    return { ok: false as const, error: "Only Writers and Reviewers can edit drafts." };
  }
  const [session] = await db
    .select({ id: sessions.id, status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, input.sessionId));
  if (!session) return { ok: false as const, error: "Session not found." };
  if (session.status !== "AWAITING_REVIEW") {
    return {
      ok: false as const,
      error: `Draft is locked (${session.status}). Edits are only possible while awaiting review; create a new run to change content after a decision.`,
    };
  }

  const [edit] = await db
    .select()
    .from(documentEdits)
    .where(eq(documentEdits.id, input.editId));
  if (!edit || edit.sessionId !== input.sessionId)
    return { ok: false as const, error: "Edit not found." };
  await db
    .update(documentEdits)
    .set({ afterContent: input.content, editedById: actor?.id ?? null })
    .where(eq(documentEdits.id, input.editId));
  await db
    .update(sessions)
    .set({ updatedAt: new Date() })
    .where(eq(sessions.id, input.sessionId));
  await audit(input.sessionId, actor?.id ?? null, "EDIT_APPLIED", {
    docPath: edit.docPath,
    section: edit.sectionHeading,
    deltaChars: input.content.length - edit.afterContent.length,
  }, new Date());
  return { ok: true as const };
}

import { inArray } from "drizzle-orm";
const inArrayStatuses = (values: string[]) => inArray(sessions.status, values);

class PublishBlocked extends Error {
  auditDetail: Record<string, unknown>;
  constructor(message: string, auditDetail: Record<string, unknown>) {
    super(message);
    this.auditDetail = auditDetail;
  }
}

export async function decide(input: {
  sessionId: string;
  action: "approve" | "reject" | "publish";
  actor: Actor | null;
  reason?: string;
  at?: Date;
}): Promise<{ ok: boolean; error?: string }> {
  const at = input.at ?? new Date();
  const actor = input.actor;
  if (!actor) return { ok: false, error: "Authentication required." };
  if (actor.role === "WRITER")
    return { ok: false, error: "Writers cannot approve, reject, or publish. Switch identity to a Reviewer or Approver." };
  if (actor.role !== "REVIEWER" && actor.role !== "APPROVER")
    return { ok: false, error: "This identity cannot approve, reject, or publish." };

  if (input.action === "approve") {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, input.sessionId));
    if (!session) return { ok: false, error: "Session not found." };
    if (session.status !== "AWAITING_REVIEW")
      return { ok: false, error: `Cannot approve from state ${session.status}.` };
    if (
      process.env.ENFORCE_SEPARATION_OF_DUTIES === "true" &&
      session.createdById &&
      session.createdById === actor.id
    )
      return { ok: false, error: "Separation of duties: you cannot approve your own run." };
    const editsNow = await db
      .select({ afterContent: documentEdits.afterContent })
      .from(documentEdits)
      .where(eq(documentEdits.sessionId, session.id));
    const approvedHash = editsContentHash(editsNow.map((e) => e.afterContent));
    // Conditional UPDATE: the approve only lands if the session is still
    // awaiting review — no check-then-act window.
    const updated = await db
      .update(sessions)
      .set({
        status: "APPROVED",
        reviewedById: actor.id,
        proposal: { ...(session.proposal ?? {}), approvedContentHash: approvedHash },
        updatedAt: at,
      })
      .where(and(eq(sessions.id, session.id), eq(sessions.status, "AWAITING_REVIEW")))
      .returning({ id: sessions.id });
    if (!updated[0])
      return { ok: false, error: "Session state changed concurrently — re-open and review again." };
    await audit(session.id, actor.id, "APPROVED", { contentHash: approvedHash }, at);
    return { ok: true };
  }

  if (input.action === "reject") {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, input.sessionId));
    if (!session) return { ok: false, error: "Session not found." };
    if (!["AWAITING_REVIEW", "APPROVED"].includes(session.status))
      return { ok: false, error: `Cannot reject from state ${session.status}.` };
    if (!input.reason?.trim()) return { ok: false, error: "A rejection reason is required." };
    const updated = await db
      .update(sessions)
      .set({
        status: "REJECTED",
        reviewedById: actor.id,
        rejectionReason: input.reason.trim(),
        updatedAt: at,
      })
      .where(and(eq(sessions.id, session.id), inArrayStatuses(["AWAITING_REVIEW", "APPROVED"])))
      .returning({ id: sessions.id });
    if (!updated[0])
      return { ok: false, error: "Session state changed concurrently — re-open and review again." };
    await audit(session.id, actor.id, "REJECTED", { reason: input.reason.trim() }, at);
    return { ok: true };
  }

  const actorIdRef = { current: actor.id };
  const localPublish: {
    rollback?: () => Promise<void>;
    commit?: () => Promise<void>;
  } = {};
  try {
    await db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .for("update");
      if (!session) throw new PublishBlocked("Session not found.", { reason: "missing_session" });
      if (session.status !== "APPROVED")
        throw new PublishBlocked("Only approved sessions can be published.", {
          reason: "bad_state",
          status: session.status,
        });
      if (
        process.env.ENFORCE_SEPARATION_OF_DUTIES === "true" &&
        session.createdById &&
        session.createdById === actorIdRef.current
      )
        throw new PublishBlocked("Separation of duties: you cannot publish your own run.", {
          reason: "self_publish",
        });
      const [product] = await tx.select().from(products).where(eq(products.id, session.productId));
      if (!product) throw new PublishBlocked("Product configuration is missing.", { reason: "missing_product" });
      const publishDestination = product.publishMode || "database";
      if (!["github_pr", "local_disk", "database"].includes(publishDestination)) {
        throw new PublishBlocked("Configure publishMode as github_pr, local_disk, or database.", {
          reason: "invalid_publish_mode",
        });
      }
      if (publishDestination === "github_pr" && !product.docsRepoUrl && !product.sourceRepoUrl) {
        throw new PublishBlocked("Configure a documentation or source GitHub URL for this product.", {
          reason: "missing_docs_repository",
        });
      }
      if (publishDestination === "local_disk" && !product.docsRepoPath && !product.sourceRepoPath) {
        throw new PublishBlocked("Configure a documentation or source local checkout path before using local_disk publishing.", {
          reason: "missing_docs_path",
        });
      }

      const edits = await tx
        .select()
        .from(documentEdits)
        .where(eq(documentEdits.sessionId, session.id));

      // What was approved must be what ships. The hash captured at approval
      // time is recomputed over the current drafts.
      const approvedHash = (session.proposal as { approvedContentHash?: string } | null)?.approvedContentHash;
      if (approvedHash) {
        const nowHash = editsContentHash(edits.map((e) => e.afterContent));
        if (nowHash !== approvedHash)
          throw new PublishBlocked("Draft content changed after approval. Re-run review.", {
            reason: "content_hash_mismatch",
          });
      }

      const docContent = new Map<string, string>();
      const originalDocContent = new Map<string, string>();
      const docsToPublish = new Map<
        string,
        { path: string; beforeContent: string; afterContent: string; version: number }
      >();
      const docTouched = new Set<string>();
      for (const edit of edits) {
        const [doc] = await tx
          .select()
          .from(documents)
          .where(eq(documents.id, edit.documentId))
          .for("update");
        if (!doc)
          throw new PublishBlocked(`Document missing for ${edit.docPath}.`, {
            reason: "missing_document",
            docPath: edit.docPath,
          });
        if (!docContent.has(doc.id)) {
          docContent.set(doc.id, doc.content);
          originalDocContent.set(doc.id, doc.content);
        }
        const expectedVersion =
          edit.docVersion +
          (publishDestination === "database" && docTouched.has(doc.id) ? 1 : 0);
        if (doc.version !== expectedVersion) {
          throw new PublishBlocked(
            `${edit.docPath} changed since this preview (v${expectedVersion} → v${doc.version}). Re-run the pipeline.`,
            {
              reason: "stale_document",
              docPath: edit.docPath,
              expected: edit.docVersion,
              actual: doc.version,
            }
          );
        }
        if (edit.action !== "create" && !docContent.get(doc.id)!.includes(edit.beforeContent)) {
          throw new PublishBlocked(`${edit.docPath} no longer contains the reviewed section.`, {
            reason: "target_section_mismatch",
            docPath: edit.docPath,
          });
        }
        const next = edit.action === "create"
          ? `${docContent.get(doc.id)!.replace(/\s*$/, "")}\n\n${edit.afterContent.trim()}\n`
          : docContent.get(doc.id)!.replace(edit.beforeContent, () => edit.afterContent);
        docContent.set(doc.id, next);
        if (publishDestination === "database") {
          await tx
            .update(documents)
            .set({ content: next, version: doc.version + 1, updatedAt: at })
            .where(eq(documents.id, doc.id));
          await audit(session.id, actor.id, "DOC_PUBLISHED", {
            docPath: edit.docPath,
            fromVersion: doc.version,
            toVersion: doc.version + 1,
            section: edit.sectionHeading,
          }, at, tx);
        } else {
          docsToPublish.set(doc.id, {
            path: doc.path,
            beforeContent: originalDocContent.get(doc.id)!,
            afterContent: next,
            version: doc.version,
          });
        }
        docTouched.add(doc.id);
      }

      if (edits.length === 0)
        throw new PublishBlocked("This session contains no document edits to publish.", {
          reason: "empty_patch",
        });

      if (publishDestination === "github_pr") {
        let pullRequest: { url: string; branch: string; baseBranch: string; merged: boolean };
        try {
          pullRequest = await createDocumentationPullRequest({
            repoUrl: product.docsRepoUrl || product.sourceRepoUrl,
            docsRoot: product.docsRoot,
            sessionId: session.id,
            headRevision: session.headRevision,
            title: session.title,
            files: [...docsToPublish.values()],
          });
        } catch (error) {
          throw new PublishBlocked(
            error instanceof Error ? error.message : "Could not create the documentation pull request.",
            { reason: "github_publish_failed" }
          );
        }
        if (pullRequest.merged) {
          for (const [documentId, doc] of docsToPublish) {
            await tx
              .update(documents)
              .set({ content: doc.afterContent, version: doc.version + 1, updatedAt: at })
              .where(eq(documents.id, documentId));
            await audit(session.id, actor.id, "DOC_PUBLISHED", {
              docPath: doc.path,
              fromVersion: doc.version,
              toVersion: doc.version + 1,
              source: "github_merge",
            }, at, tx);
          }
        }
        await tx
          .update(sessions)
          .set({
            status: pullRequest.merged ? "PUBLISHED" : "PR_OPEN",
            publishedAt: pullRequest.merged ? at : null,
            proposal: {
              ...(session.proposal ?? {}),
              pullRequestUrl: pullRequest.url,
              pullRequestBranch: pullRequest.branch,
            },
            updatedAt: at,
          })
          .where(eq(sessions.id, session.id));
        await audit(session.id, actor.id, pullRequest.merged ? "PUBLISHED" : "PULL_REQUEST_OPENED", {
          url: pullRequest.url,
          branch: pullRequest.branch,
          base: pullRequest.baseBranch,
          edits: edits.length,
          merged: pullRequest.merged,
        }, at, tx);
      } else if (publishDestination === "local_disk") {
        try {
          const result = await publishLocalFiles({
            repoPath: product.docsRepoPath || product.sourceRepoPath,
            docsRoot: product.docsRoot,
            files: [...docsToPublish.values()],
          });
          localPublish.rollback = result.rollback;
          localPublish.commit = result.commit;
          for (const [documentId, doc] of docsToPublish) {
            await tx
              .update(documents)
              .set({ content: doc.afterContent, version: doc.version + 1, updatedAt: at })
              .where(eq(documents.id, documentId));
            await audit(session.id, actor.id, "DOC_PUBLISHED", {
              docPath: doc.path,
              fromVersion: doc.version,
              toVersion: doc.version + 1,
              source: "local_disk",
            }, at, tx);
          }
          await tx
            .update(sessions)
            .set({ status: "PUBLISHED", publishedAt: at, updatedAt: at })
            .where(eq(sessions.id, session.id));
          await audit(session.id, actor.id, "PUBLISHED", { edits: edits.length, destination: "local_disk" }, at, tx);
        } catch (error) {
          throw new PublishBlocked(
            error instanceof Error ? error.message : "Local disk publishing failed.",
            { reason: "local_disk_publish_failed" }
          );
        }
      } else {
        await tx
          .update(sessions)
          .set({ status: "PUBLISHED", publishedAt: at, updatedAt: at })
          .where(eq(sessions.id, session.id));
        await audit(session.id, actor.id, "PUBLISHED", { edits: edits.length }, at, tx);
      }
    });
    if (localPublish.commit) {
      localPublish.rollback = undefined;
      await localPublish.commit();
      localPublish.commit = undefined;
    }
    return { ok: true };
  } catch (e) {
    if (localPublish.rollback) {
      await localPublish.rollback();
      localPublish.rollback = undefined;
    }
    if (e instanceof PublishBlocked) {
      // Persist the policy block OUTSIDE the rolled-back transaction.
      await audit(input.sessionId, actor.id, "POLICY_BLOCKED", e.auditDetail, at);
      return { ok: false, error: e.message };
    }
    throw e;
  }
}
