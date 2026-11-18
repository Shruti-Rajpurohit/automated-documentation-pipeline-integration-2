import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { db } from "@/db";
import { auditEvents, documentEdits, documents, products, sessions, users } from "@/db/schema";
import { ensureSeed } from "@/lib/seed";
import { PageHeader } from "@/components/page-header";
import { PipelineFlow } from "@/components/pipeline-flow";
import { Avatar, Counter, Reveal, StatusChip } from "@/components/ui";
import { relativeTime } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  await ensureSeed();

  const allSessions = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      status: sessions.status,
      productId: sessions.productId,
      baseRevision: sessions.baseRevision,
      headRevision: sessions.headRevision,
      model: sessions.model,
      createdAt: sessions.createdAt,
      updatedAt: sessions.updatedAt,
      publishedAt: sessions.publishedAt,
      productName: products.name,
    })
    .from(sessions)
    .leftJoin(products, eq(sessions.productId, products.id))
    .orderBy(desc(sessions.updatedAt))
    .limit(30);

  const awaiting = allSessions.filter((s) => s.status === "AWAITING_REVIEW");
  const awaitingIds = awaiting.map((s) => s.id);
  const awaitingEdits =
    awaitingIds.length > 0
      ? await db
          .select({ sessionId: documentEdits.sessionId })
          .from(documentEdits)
          .where(inArray(documentEdits.sessionId, awaitingIds))
      : [];
  const editCountBySession = new Map<string, number>();
  for (const e of awaitingEdits)
    editCountBySession.set(e.sessionId, (editCountBySession.get(e.sessionId) ?? 0) + 1);

  const allDocs = await db.select({ id: documents.id }).from(documents);
  const allProducts = await db.select().from(products);

  // Request-time clock for a Server Component: this module renders once per
  // request (force-dynamic), so a single `now` snapshot is correct here.
  // eslint-disable-next-line react-hooks/purity -- per-request time source in an RSC
  const now = Date.now();
  const weekAgo = now - 7 * 86_400_000;
  const sessionsThisWeek = allSessions.filter((s) => s.createdAt.getTime() > weekAgo).length;
  const published = allSessions.filter((s) => s.status === "PUBLISHED");
  const rejected = allSessions.filter((s) => s.status === "REJECTED");
  const acceptance =
    published.length + rejected.length > 0
      ? Math.round((published.length / (published.length + rejected.length)) * 100)
      : 100;
  const publishHours = published
    .filter((s) => s.publishedAt)
    .map((s) => (s.publishedAt!.getTime() - s.createdAt.getTime()) / 3_600_000);
  const avgPublish = publishHours.length
    ? (publishHours.reduce((a, b) => a + b, 0) / publishHours.length).toFixed(1)
    : "—";

  // 14-day publish cadence sparkline
  const days: number[] = Array.from({ length: 14 }, () => 0);
  for (const s of published) {
    if (!s.publishedAt) continue;
    const d = Math.floor((now - s.publishedAt.getTime()) / 86_400_000);
    if (d >= 0 && d < 14) days[13 - d]++;
  }
  const maxDay = Math.max(1, ...days);
  const points = days
    .map((v, i) => `${(i / 13) * 100},${26 - (v / maxDay) * 22}`)
    .join(" ");

  const recentAudits = await db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      createdAt: auditEvents.createdAt,
      actorName: users.name,
      actorHue: users.hue,
    })
    .from(auditEvents)
    .leftJoin(users, eq(auditEvents.actorId, users.id))
    .orderBy(desc(auditEvents.createdAt))
    .limit(5);

  const lastByProduct = new Map<string, { title: string; head: string; at: Date }>();
  for (const s of allSessions) {
    if (!lastByProduct.has(s.productId))
      lastByProduct.set(s.productId, { title: s.title, head: s.headRevision, at: s.updatedAt });
  }

  const AUDIT_LABEL: Record<string, string> = {
    RUN_STARTED: "Pipeline run started",
    SIGNALS_EXTRACTED: "Signals extracted",
    SECTIONS_MAPPED: "Sections mapped",
    PROPOSAL_READY: "Proposal ready",
    EDIT_APPLIED: "Draft edited",
    APPROVED: "Session approved",
    REJECTED: "Session rejected",
    DOC_PUBLISHED: "Document published",
    PUBLISHED: "Session published",
    PULL_REQUEST_OPENED: "Documentation pull request opened",
    DOC_SYNC_SKIPPED: "Documentation snapshot sync skipped",
    POLICY_BLOCKED: "Publish blocked",
  };

  return (
    <div>
      <PageHeader
        kicker="nimbus systems · workspace"
        title="Documentation that keeps up with the code."
        sub="Docline watches every release, drafts doc updates in your house voice with evidence links, and holds them for human sign-off before a single word ships."
        actions={
          <Link
            href="/runs/new"
            className="inline-flex items-center gap-2 rounded-xl bg-mint px-4 py-2.5 text-[13.5px] font-semibold text-ink transition-all hover:brightness-110"
          >
            New pipeline run <ArrowRight size={15} />
          </Link>
        }
      />

      <Reveal delay={0.1} className="card mb-6 px-6 py-7">
        <PipelineFlow />
      </Reveal>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Pipeline sessions · 7d", value: <Counter value={sessionsThisWeek} /> },
          { label: "Proposal acceptance", value: <Counter value={acceptance} suffix="%" /> },
          { label: "Docs under management", value: <Counter value={allDocs.length} /> },
          { label: "Avg time to publish", value: <span className="tabular-nums">{avgPublish}h</span> },
        ].map((s, i) => (
          <Reveal key={s.label} delay={0.15 + i * 0.06}>
            <div className="card card-hover px-4 py-4">
              <div className="text-[24px] font-semibold tracking-tight text-snow">{s.value}</div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-fog">
                {s.label}
              </div>
            </div>
          </Reveal>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_300px]">
        <div className="space-y-5">
          {/* review queue */}
          <Reveal delay={0.25}>
            <div className="card">
              <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
                <span className="kicker !mb-0">Review queue</span>
                <span className="font-mono text-[10.5px] text-fog">
                  {awaiting.length} open
                </span>
              </div>
              <div className="divide-y divide-hairline">
                {awaiting.length === 0 && (
                  <p className="px-5 py-8 text-center text-[13px] text-fog">
                    Queue is clear. The next release event will land here.
                  </p>
                )}
                {awaiting.map((s) => (
                  <Link
                    key={s.id}
                    href={`/sessions/${s.id}`}
                    className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-white/[0.02]"
                  >
                    <span className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-amberish text-amberish" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium text-snow">{s.title}</div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-fog">
                        {s.productName} · {s.baseRevision} → {s.headRevision} ·{" "}
                        {editCountBySession.get(s.id) ?? 0} edits · {s.model}
                      </div>
                    </div>
                    <span className="font-mono text-[10.5px] text-fog">
                      {relativeTime(s.updatedAt)}
                    </span>
                    <ArrowUpRight
                      size={14}
                      className="text-fog opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  </Link>
                ))}
              </div>
            </div>
          </Reveal>

          {/* all sessions */}
          <Reveal delay={0.3}>
            <div className="card overflow-hidden">
              <div className="border-b border-hairline px-5 py-3.5">
                <span className="kicker !mb-0">Recent sessions</span>
              </div>
              <table className="w-full">
                <tbody className="divide-y divide-hairline">
                  {allSessions.slice(0, 9).map((s) => (
                    <tr key={s.id} className="group transition-colors hover:bg-white/[0.02]">
                      <td className="px-5 py-3">
                        <Link href={`/sessions/${s.id}`} className="block">
                          <div className="text-[13px] font-medium text-snow group-hover:text-mint">
                            {s.title}
                          </div>
                          <div className="mt-0.5 font-mono text-[10.5px] text-fog">
                            {s.productName} · {s.baseRevision} → {s.headRevision}
                          </div>
                        </Link>
                      </td>
                      <td className="hidden px-3 py-3 font-mono text-[10.5px] text-fog md:table-cell">
                        {s.model}
                      </td>
                      <td className="hidden px-3 py-3 font-mono text-[10.5px] text-fog sm:table-cell">
                        {relativeTime(s.updatedAt)}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <StatusChip status={s.status} size="sm" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>
        </div>

        {/* right rail */}
        <div className="space-y-5">
          <Reveal delay={0.25}>
            <div className="card p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="kicker !mb-0">Publish cadence</span>
                <span className="font-mono text-[10px] text-fog">14d</span>
              </div>
              <svg viewBox="0 0 100 28" className="h-16 w-full" preserveAspectRatio="none">
                <polyline
                  points={points}
                  fill="none"
                  stroke="#5eeaa0"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
              <div className="mt-2 flex justify-between font-mono text-[9.5px] text-fog">
                <span>2 weeks ago</span>
                <span>{published.length} shipped</span>
              </div>
            </div>
          </Reveal>

          <Reveal delay={0.3}>
            <div className="card p-4">
              <div className="kicker !mb-3">Drift watch</div>
              <div className="space-y-3">
                {allProducts.map((p) => {
                  const last = lastByProduct.get(p.id);
                  return (
                    <div key={p.id} className="flex items-center gap-3">
                      <span className="grid h-8 w-8 place-items-center rounded-lg border border-hairline bg-panel-2 font-mono text-[12px] text-mint">
                        {p.name[0]}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] font-medium text-snow">{p.name}</div>
                        <div className="truncate font-mono text-[10px] text-fog">
                          {last ? `synced to ${last.head}` : "no runs yet"}
                        </div>
                      </div>
                      <span className="font-mono text-[10px] text-fog">
                        {last ? relativeTime(last.at) : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </Reveal>

          <Reveal delay={0.35}>
            <div className="card p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="kicker !mb-0">Latest activity</span>
                <Link href="/activity" className="font-mono text-[10px] text-mint hover:underline">
                  all →
                </Link>
              </div>
              <div className="space-y-2.5">
                {recentAudits.map((a) => (
                  <div key={a.id} className="flex items-center gap-2">
                    {a.actorName ? (
                      <Avatar name={a.actorName} hue={a.actorHue ?? 200} size={18} />
                    ) : (
                      <span className="grid h-[18px] w-[18px] place-items-center rounded-full border border-hairline font-mono text-[9px] text-mint">
                        ⤿
                      </span>
                    )}
                    <span className="flex-1 truncate text-[12px] text-snow/80">
                      {AUDIT_LABEL[a.action] ?? a.action}
                    </span>
                    <span className="font-mono text-[9.5px] text-fog">
                      {relativeTime(a.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </div>
  );
}
