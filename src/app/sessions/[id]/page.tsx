import { notFound } from "next/navigation";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents, documentEdits, documents, products, sessions, users } from "@/db/schema";
import { ensureSeed } from "@/lib/seed";
import {
  ReviewConsole,
  type ConsoleAudit,
  type ConsoleEdit,
  type ConsoleSession,
} from "@/components/review-console";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await ensureSeed();

  const [row] = await db
    .select({ s: sessions, productName: products.name, productSlug: products.slug })
    .from(sessions)
    .leftJoin(products, eq(sessions.productId, products.id))
    .where(eq(sessions.id, id));
  if (!row) notFound();
  const { s } = row;

  const editRows = await db
    .select()
    .from(documentEdits)
    .where(eq(documentEdits.sessionId, id));

  const docIds = [...new Set(editRows.map((e) => e.documentId))];
  const docRows =
    docIds.length > 0
      ? await db
          .select({ id: documents.id, version: documents.version })
          .from(documents)
          .where(inArray(documents.id, docIds))
      : [];
  const versionById = new Map(docRows.map((d) => [d.id, d.version]));

  const auditRows = await db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      detail: auditEvents.detail,
      createdAt: auditEvents.createdAt,
      actorName: users.name,
      actorHue: users.hue,
    })
    .from(auditEvents)
    .leftJoin(users, eq(auditEvents.actorId, users.id))
    .where(eq(auditEvents.sessionId, id))
    .orderBy(desc(auditEvents.createdAt));

  const allUsers = await db.select().from(users);
  const nameOf = (uid: string | null) =>
    uid ? allUsers.find((u) => u.id === uid)?.name ?? null : null;

  const proposal = (s.proposal ?? {}) as { llm?: boolean; pullRequestUrl?: string };

  const consoleSession: ConsoleSession = {
    id: s.id,
    title: s.title,
    status: s.status,
    triggerType: s.triggerType,
    baseRevision: s.baseRevision,
    headRevision: s.headRevision,
    changeSummary: s.changeSummary,
    provider: s.provider,
    model: s.model,
    llm: proposal.llm ?? false,
    impactStatement: s.impactStatement,
    uncertainties: s.uncertainties,
    testsToRun: s.testsToRun,
    rejectionReason: s.rejectionReason,
    pullRequestUrl: proposal.pullRequestUrl ?? null,
    productName: row.productName ?? "Product",
    productSlug: row.productSlug ?? "",
    createdAt: s.createdAt.toISOString(),
    publishedAt: s.publishedAt ? s.publishedAt.toISOString() : null,
    createdByName: nameOf(s.createdById),
    reviewedByName: nameOf(s.reviewedById),
  };

  const consoleEdits: ConsoleEdit[] = editRows.map((e) => ({
    id: e.id,
    docPath: e.docPath,
    sectionHeading: e.sectionHeading,
    before: e.beforeContent,
    after: e.afterContent,
    evidence: e.evidence,
    docVersion: e.docVersion,
    currentVersion: versionById.get(e.documentId) ?? e.docVersion,
  }));

  const consoleAudits: ConsoleAudit[] = auditRows.map((a) => ({
    id: a.id,
    action: a.action,
    actorName: a.actorName,
    actorHue: a.actorHue ?? 200,
    detail: a.detail,
    createdAt: a.createdAt.toISOString(),
  }));

  return <ReviewConsole session={consoleSession} edits={consoleEdits} audits={consoleAudits} />;
}
