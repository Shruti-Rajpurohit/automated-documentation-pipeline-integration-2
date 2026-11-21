"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, LoaderCircle } from "lucide-react";

interface ActiveJob {
  id: string;
  status: string;
  result: { stage?: string } | null;
  productId: string | null;
  productName: string | null;
  createdAt: string;
  lastError: string | null;
}

interface CompletedJob {
  id: string;
  productName: string;
  sessionId: string;
}

export function ActiveJobs() {
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const [completed, setCompleted] = useState<CompletedJob[]>([]);
  const seenActive = useRef(new Map<string, ActiveJob>());

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch("/api/jobs", {
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return;
        const result = await response.json() as { jobs?: ActiveJob[] };
        if (!active || !Array.isArray(result.jobs)) return;
        const nextJobs = result.jobs;
        setJobs(nextJobs);
        const currentIds = new Set(nextJobs.map((job) => job.id));
        const finished = [...seenActive.current.values()].filter((job) => !currentIds.has(job.id));
        seenActive.current = new Map(
          nextJobs
            .filter((job) => job.status === "QUEUED" || job.status === "RUNNING")
            .map((job) => [job.id, job])
        );
        for (const previous of finished) {
          const statusResponse = await fetch(`/api/jobs/${encodeURIComponent(previous.id)}`, {
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
          });
          if (!statusResponse.ok) continue;
          const status = await statusResponse.json();
          if (status.status === "COMPLETED" && typeof status.result?.sessionId === "string" && active) {
            setCompleted((items) => [
              { id: previous.id, productName: previous.productName ?? "Product", sessionId: status.result.sessionId },
              ...items.filter((item) => item.id !== previous.id),
            ].slice(0, 5));
          }
        }
      } catch {
        // Transient polling failures are retried on the next interval.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  if (jobs.length === 0 && completed.length === 0) return null;

  return (
    <section className="card mb-5 overflow-hidden" aria-live="polite">
      <header className="border-b border-hairline px-5 py-3">
        <h2 className="kicker !mb-0">Active pipeline runs</h2>
      </header>
      <div className="divide-y divide-hairline">
        {jobs.map((job) => (
          <div key={job.id} className="flex items-start gap-3 px-5 py-3">
            {job.status === "RUNNING"
              ? <LoaderCircle size={14} className="mt-0.5 animate-spin text-mint" />
              : <span className="mt-1 h-2 w-2 rounded-full bg-amberish" />}
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-snow">
                {job.productName || "Pipeline"} · {job.status.toLowerCase()}
              </div>
              <div className="mt-0.5 truncate font-mono text-[10.5px] text-fog">
                {job.result?.stage || (job.status === "FAILED" ? job.lastError : "Waiting for worker")}
              </div>
            </div>
          </div>
        ))}
        {completed.map((job) => (
          <Link
            key={job.id}
            href={`/sessions/${job.sessionId}`}
            className="flex items-center justify-between gap-3 px-5 py-3 text-[12px] text-mint hover:bg-white/[0.02]"
          >
            <span>{job.productName} run completed · Open review session</span>
            <ArrowUpRight size={13} />
          </Link>
        ))}
      </div>
    </section>
  );
}
