import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { Bot } from "lucide-react";
import { db } from "@/db";
import { auditEvents, sessions, users } from "@/db/schema";
import { ensureSeed } from "@/lib/seed";
import { PageHeader } from "@/components/page-header";
import { Avatar, Reveal, StatusChip } from "@/components/ui";
import { relativeTime, fullTime } from "@/lib/time";

export const dynamic = "force-dynamic";

const ACTION_LABELS: Record<string, string> = {
  RUN_STARTED: "started a pipeline run",
  SIGNALS_EXTRACTED: "extracted signals from the source diff",
  SECTIONS_MAPPED: "mapped documentation sections",
  PROPOSAL_READY: "prepared a review proposal",
  EDIT_APPLIED: "edited a draft",
  APPROVED: "approved a proposal",
  REJECTED: "rejected a proposal",
  DOC_PUBLISHED: "published a document",
  PUBLISHED: "published a session",
  POLICY_BLOCKED: "publish blocked by policy",
  PULL_REQUEST_OPENED: "opened a documentation pull request",
  DOC_SYNC_SKIPPED: "could not sync the merged docs snapshot",
};

function detailChips(detail: Record<string, unknown>): string[] {
  const chips: string[] = [];
  if (typeof detail.trigger === "string") chips.push(detail.trigger.toLowerCase());
  if (typeof detail.base === "string" && typeof detail.head === "string")
    chips.push(`${detail.base} → ${detail.head}`);
  if (Array.isArray(detail.signals)) chips.push(`${detail.signals.length} signals`);
  if (typeof detail.files === "number") chips.push(`${detail.files} files`);
  if (Array.isArray(detail.edits)) chips.push(`${detail.edits.length} edits`);
  if (typeof detail.edits === "number") chips.push(`${detail.edits} edits`);
  if (typeof detail.docPath === "string") chips.push(detail.docPath);
  if (typeof detail.section === "string") chips.push(`§ ${detail.section}`);
  if (typeof detail.deltaChars === "number")
    chips.push(`${detail.deltaChars >= 0 ? "+" : ""}${detail.deltaChars} chars`);
  if (typeof detail.status === "string") chips.push(`status ${detail.status.toLowerCase()}`);
  if (detail.llm === true) chips.push("llm draft");
  if (detail.llm === false) chips.push("local engine");
  if (typeof detail.reason === "string") chips.push(`reason recorded`);
  if (typeof detail.fromVersion === "number")
    chips.push(`v${detail.fromVersion} → v${detail.toVersion}`);
  if (typeof detail.note === "string") chips.push("fell back to local");
  return chips.slice(0, 5);
}

export default async function ActivityPage() {
  await ensureSeed();

  const rows = await db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      detail: auditEvents.detail,
      createdAt: auditEvents.createdAt,
      actorName: users.name,
      actorHue: users.hue,
      sessionId: auditEvents.sessionId,
      sessionTitle: sessions.title,
      sessionStatus: sessions.status,
    })
    .from(auditEvents)
    .leftJoin(users, eq(auditEvents.actorId, users.id))
    .leftJoin(sessions, eq(auditEvents.sessionId, sessions.id))
    .orderBy(desc(auditEvents.createdAt))
    .limit(60);

  return (
    <div>
      <PageHeader
        kicker="audit trail"
        title="Activity"
        sub="Every run, draft edit, decision, and publish — persisted with actor and timestamp. This feed is the audit surface enterprises ask about first."
      />
      <Reveal delay={0.1}>
        <div className="card">
          <ol className="relative divide-y divide-hairline">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3.5 px-5 py-3.5">
                {r.actorName ? (
                  <Avatar name={r.actorName} hue={r.actorHue ?? 200} size={26} />
                ) : (
                  <span className="grid h-[26px] w-[26px] place-items-center rounded-full border border-mint/25 bg-mint-dim">
                    <Bot size={13} className="text-mint" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-snow/90">
                    <span className="font-medium">{r.actorName ?? "Docline"}</span>{" "}
                    <span className="text-fog">{ACTION_LABELS[r.action] ?? r.action}</span>
                    {r.sessionId && (
                      <>
                        {" "}
                        <span className="text-fog">on</span>{" "}
                        <Link
                          href={`/sessions/${r.sessionId}`}
                          className="text-snow hover:text-mint"
                        >
                          {r.sessionTitle ?? "session"}
                        </Link>
                      </>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {detailChips(r.detail).map((c) => (
                      <span
                        key={c}
                        className="rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-fog"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
                {r.sessionStatus && <StatusChip status={r.sessionStatus} size="sm" />}
                <span
                  className="w-16 shrink-0 text-right font-mono text-[10px] text-fog"
                  title={fullTime(r.createdAt)}
                >
                  {relativeTime(r.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </Reveal>
    </div>
  );
}
