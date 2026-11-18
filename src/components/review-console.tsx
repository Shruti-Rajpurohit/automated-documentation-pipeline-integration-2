"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  FileText,
  ListChecks,
  LoaderCircle,
  Pencil,
  Rocket,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { DiffViewer } from "./diff-viewer";
import { Avatar, StatusChip } from "./ui";
import { useRole } from "./shell";
import { cx, fullTime, relativeTime } from "@/lib/time";

export interface ConsoleEdit {
  id: string;
  action: string;
  docPath: string;
  sectionHeading: string;
  before: string;
  after: string;
  evidence: string[];
  docVersion: number;
  currentVersion: number;
}

export interface ConsoleAudit {
  id: string;
  action: string;
  actorName: string | null;
  actorHue: number;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ConsoleSession {
  id: string;
  title: string;
  status: string;
  triggerType: string;
  baseRevision: string;
  headRevision: string;
  changeSummary: string;
  provider: string;
  model: string;
  llm: boolean;
  impactStatement: string;
  uncertainties: string[];
  testsToRun: string[];
  rejectionReason: string | null;
  pullRequestUrl: string | null;
  productName: string;
  productSlug: string;
  createdAt: string;
  publishedAt: string | null;
  createdByName: string | null;
  reviewedByName: string | null;
}

const AUDIT_LABEL: Record<string, string> = {
  RUN_STARTED: "Pipeline run started",
  SIGNALS_EXTRACTED: "Signals extracted from diff",
  SECTIONS_MAPPED: "Documentation sections mapped",
  PROPOSAL_READY: "Proposal ready for review",
  EDIT_APPLIED: "Draft edited",
  APPROVED: "Approved for release",
  REJECTED: "Rejected with reason",
  DOC_PUBLISHED: "Document published",
  PUBLISHED: "Session published",
  PULL_REQUEST_OPENED: "Documentation pull request opened",
  DOC_SYNC_SKIPPED: "Documentation snapshot sync skipped",
  POLICY_BLOCKED: "Publish blocked by policy",
};

export function ReviewConsole({
  session,
  edits,
  audits,
}: {
  session: ConsoleSession;
  edits: ConsoleEdit[];
  audits: ConsoleAudit[];
}) {
  const { role } = useRole();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState("");

  const canDecide = role === "REVIEWER" || role === "APPROVER";
  const stale = edits.some((e) => e.currentVersion !== e.docVersion);

  async function act(action: "approve" | "reject" | "publish", payload?: string) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${session.id}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason: payload }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Action failed.");
        return;
      }
      setRejecting(false);
      router.refresh();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit(editId: string) {
    setBusy(editId);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${session.id}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ editId, content: editBuffer }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Edit failed.");
        return;
      }
      setDrafts((d) => ({ ...d, [editId]: editBuffer }));
      setEditing(null);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const status = session.status;
  const canEdit = (role === "WRITER" || role === "REVIEWER") && status === "AWAITING_REVIEW";

  return (
    <div>
      <Link
        href="/"
        className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-fog transition-colors hover:text-snow"
      >
        <ArrowLeft size={13} /> Sessions
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2.5">
            <StatusChip status={status} />
            <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-fog">
              {session.productName} · {session.triggerType.toLowerCase()} trigger
            </span>
          </div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-snow">
            {session.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[11px] text-fog">
            <span className="rounded-md border border-hairline bg-panel px-2 py-0.5">
              {session.baseRevision}
            </span>
            <span className="text-mint">→</span>
            <span className="rounded-md border border-hairline bg-panel px-2 py-0.5 text-snow/90">
              {session.headRevision}
            </span>
            <span className="rounded-md border border-hairline bg-panel px-2 py-0.5">
              {session.model}
            </span>
            <span className="text-white/35">{relativeTime(session.createdAt)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {status === "AWAITING_REVIEW" && (
            <>
              <button
                onClick={() => act("approve")}
                disabled={!canDecide || busy !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-mint/30 bg-mint-dim px-3.5 py-2 text-[13px] font-medium text-mint transition-all hover:bg-mint/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === "approve" ? <LoaderCircle size={14} className="animate-spin" /> : <Check size={14} />}
                Approve
              </button>
              <button
                onClick={() => setRejecting((v) => !v)}
                disabled={!canDecide || busy !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-coral/30 px-3.5 py-2 text-[13px] font-medium text-coral transition-colors hover:bg-coral/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X size={14} /> Reject
              </button>
            </>
          )}
          {status === "APPROVED" && (
            <button
              onClick={() => act("publish")}
              disabled={!canDecide || busy !== null || stale}
              className="inline-flex items-center gap-1.5 rounded-lg bg-mint px-4 py-2 text-[13px] font-semibold text-ink transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "publish" ? <LoaderCircle size={14} className="animate-spin" /> : <Rocket size={14} />}
              Publish approved changes
            </button>
          )}
        </div>
      </div>

      {!canDecide && ["AWAITING_REVIEW", "APPROVED"].includes(status) && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-hairline bg-panel px-3 py-2 text-[12px] text-fog">
          <ShieldCheck size={13} className="text-amberish" />
          {role === null
            ? "You’re signed out. Pick a Reviewer or Approver identity in the sidebar to decide on this proposal."
            : role === "WRITER"
              ? "You’re signed in as a writer. Switch to Reviewer or Approver in the sidebar to decide on this proposal."
              : "Your role cannot decide on this proposal."}
        </div>
      )}
      {status === "APPROVED" && stale && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-amberish/30 bg-amberish/10 px-3 py-2 text-[12px] text-amberish">
          <TriangleAlert size={13} />
          A target document changed since this preview. Publish is blocked — re-run the pipeline to refresh the proposal.
        </div>
      )}
      {status === "REJECTED" && session.rejectionReason && (
        <div className="mt-3 rounded-xl border border-coral/25 bg-coral/[0.07] px-4 py-3">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-coral">
            Rejection reason{session.reviewedByName ? ` · ${session.reviewedByName}` : ""}
          </div>
          <p className="text-[13px] leading-relaxed text-snow/85">{session.rejectionReason}</p>
        </div>
      )}
      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-[12.5px] text-coral">
          <CircleAlert size={13} /> {error}
        </div>
      )}

      {rejecting && status === "AWAITING_REVIEW" && (
        <div className="mt-4 rounded-xl border border-coral/25 bg-panel p-4">
          <div className="mb-2 text-[12.5px] font-medium text-snow">
            Rejection reason <span className="text-fog">— stored with the session for the eval corpus</span>
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="What is wrong with this draft? Be specific — this feeds the evaluation set."
            className="w-full rounded-lg border border-hairline bg-ink p-3 text-[13px] text-snow placeholder:text-fog/60 focus:border-coral/40"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={() => setRejecting(false)}
              className="rounded-lg px-3 py-1.5 text-[12.5px] text-fog hover:text-snow"
            >
              Cancel
            </button>
            <button
              onClick={() => act("reject", reason)}
              disabled={!reason.trim() || busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border border-coral/40 bg-coral/10 px-3 py-1.5 text-[12.5px] font-medium text-coral disabled:opacity-40"
            >
              {busy === "reject" && <LoaderCircle size={13} className="animate-spin" />}
              Confirm rejection
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        {/* main column: proposed edits */}
        <div className="space-y-4">
          {edits.length === 0 && (
            <div className="card p-8 text-center">
              <CircleAlert size={20} className="mx-auto mb-2 text-fog" />
              <p className="text-[14px] text-snow/85">
                {status === "NO_UPDATE"
                  ? "The pipeline found nothing worth documenting in this diff."
                  : "No reviewable patch was produced."}
              </p>
              <p className="mt-1 text-[12.5px] text-fog">
                {status === "NO_UPDATE"
                  ? "No documentation section mapped to the detected signals."
                  : "The proposal failed validation and was routed to human investigation."}
              </p>
            </div>
          )}

          {edits.map((edit) => {
            const after = drafts[edit.id] ?? edit.after;
            const isEditing = editing === edit.id;
            return (
              <section key={edit.id} className="card overflow-hidden">
                <header className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-2.5">
                  <FileText size={14} className="text-mint" />
                  <span className="font-mono text-[12px] text-snow/90">{edit.docPath}</span>
                  <span className="rounded-full border border-hairline px-2 py-px text-[10.5px] text-fog">
                    {edit.action} · § {edit.sectionHeading}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] text-fog">
                    {edit.evidence.map((ev) => (
                      <span key={ev} className="rounded bg-white/[0.05] px-1.5 py-0.5">
                        {ev}
                      </span>
                    ))}
                    <span className="rounded bg-white/[0.05] px-1.5 py-0.5">doc v{edit.docVersion} @draft</span>
                  </span>
                  {canEdit && !isEditing && (
                    <button
                      onClick={() => {
                        setEditing(edit.id);
                        setEditBuffer(drafts[edit.id] ?? edit.after);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-hairline px-2 py-1 text-[11px] text-fog transition-colors hover:border-hairline-2 hover:text-snow"
                    >
                      <Pencil size={11} /> Edit draft
                    </button>
                  )}
                </header>

                {isEditing ? (
                  <div className="p-4">
                    <textarea
                      value={editBuffer}
                      onChange={(e) => setEditBuffer(e.target.value)}
                      rows={Math.min(24, editBuffer.split("\n").length + 2)}
                      className="w-full rounded-lg border border-mint/25 bg-ink p-3 font-mono text-[11.5px] leading-[1.7] text-snow focus:border-mint/50"
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        onClick={() => setEditing(null)}
                        className="rounded-lg px-3 py-1.5 text-[12.5px] text-fog hover:text-snow"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => saveEdit(edit.id)}
                        disabled={busy === edit.id}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-mint px-3 py-1.5 text-[12.5px] font-semibold text-ink disabled:opacity-40"
                      >
                        {busy === edit.id && <LoaderCircle size={12} className="animate-spin" />}
                        Save draft
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="p-3">
                    <DiffViewer before={edit.before} after={after} />
                  </div>
                )}
              </section>
            );
          })}
        </div>

        {/* right rail: run report */}
        <aside className="space-y-4">
          <div className="card p-4">
            <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-fog">
              <Sparkles size={11} className="text-mint" /> Run report
            </div>
            <p className="text-[13px] leading-relaxed text-snow/90">{session.impactStatement}</p>
            {session.changeSummary && (
              <p className="mt-2 border-t border-hairline pt-2 text-[12px] leading-relaxed text-fog">
                {session.changeSummary}
              </p>
            )}
            <div className="mt-3 flex items-center gap-2 border-t border-hairline pt-3 font-mono text-[10.5px] text-fog">
              <span className="rounded bg-white/[0.05] px-1.5 py-0.5">
                {session.llm ? `llm · ${session.provider}` : "local engine"}
              </span>
              <span className="rounded bg-white/[0.05] px-1.5 py-0.5">evidence-linked</span>
            </div>
          </div>

          {session.uncertainties.length > 0 && (
            <div className="card border-amberish/20 p-4">
              <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-amberish">
                <TriangleAlert size={11} /> Uncertainties
              </div>
              <ul className="space-y-2">
                {session.uncertainties.map((u, i) => (
                  <li key={i} className="text-[12.5px] leading-relaxed text-snow/80">
                    {u}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {session.testsToRun.length > 0 && (
            <div className="card p-4">
              <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-fog">
                <ListChecks size={11} /> Suggested checks
              </div>
              <ul className="space-y-1.5">
                {session.testsToRun.map((t, i) => (
                  <li key={i} className="flex items-start gap-2 text-[12.5px] leading-relaxed text-snow/75">
                    <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-mint/70" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="card p-4">
            <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-fog">
              Run timeline
            </div>
            <ol className="relative space-y-3 border-l border-hairline pl-4">
              {audits.map((a) => (
                <li key={a.id} className="relative">
                  <span className="absolute -left-[21px] top-[5px] h-[7px] w-[7px] rounded-full border border-hairline-2 bg-panel" />
                  <div className="flex items-center gap-1.5 text-[12px] text-snow/85">
                    {a.actorName && <Avatar name={a.actorName} hue={a.actorHue} size={16} />}
                    {AUDIT_LABEL[a.action] ?? a.action}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-fog" title={fullTime(a.createdAt)}>
                    {relativeTime(a.createdAt)}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>

      {status === "PUBLISHED" && session.publishedAt && (
        <div className="mt-6 flex items-center gap-2 rounded-xl border border-sky/25 bg-sky/[0.07] px-4 py-3 text-[13px] text-sky">
          <Rocket size={14} /> Published {relativeTime(session.publishedAt)} — the docs tree now carries these
          changes.
        </div>
      )}
      {(status === "PR_OPEN" || status === "PUBLISHED") && session.pullRequestUrl && (
        <div className="mt-6 rounded-xl border border-sky/25 bg-sky/[0.07] px-4 py-3 text-[13px] text-sky">
          Documentation changes are ready for the normal repository review workflow.{" "}
          <a
            href={session.pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            View pull request
          </a>
        </div>
      )}
    </div>
  );
}
