import { Check, Cloud, Cpu, KeyRound, ShieldCheck, Terminal, Webhook, X } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Reveal } from "@/components/ui";
import { CopyButton } from "@/components/copy-button";

export const dynamic = "force-dynamic";

const MATRIX: { action: string; WRITER: boolean; REVIEWER: boolean; APPROVER: boolean }[] = [
  { action: "Create pipeline run", WRITER: true, REVIEWER: true, APPROVER: true },
  { action: "Edit proposed drafts", WRITER: true, REVIEWER: true, APPROVER: false },
  { action: "Approve proposal", WRITER: false, REVIEWER: true, APPROVER: true },
  { action: "Reject with reason", WRITER: false, REVIEWER: true, APPROVER: true },
  { action: "Publish approved changes", WRITER: false, REVIEWER: true, APPROVER: true },
  { action: "Decide on your own run", WRITER: false, REVIEWER: false, APPROVER: false },
];

export default function SettingsPage() {
  const openrouter = Boolean(process.env.OPENROUTER_API_KEY);
  const backendUrl = process.env.PIPELINE_BACKEND_URL ?? "";
  const curl = `curl -X POST $HOST/api/runs \\
  -H "content-type: application/json" \\
  -H "authorization: Bearer $PIPELINE_API_TOKEN" \\
  -d '{
    "productId": "p-relay",
    "baseRevision": "v2.4.0",
    "headRevision": "v2.4.1",
    "changeSummary": "Describe the release in one paragraph.",
    "provider": "local",
    "model": "docline-local-1",
    "diffText": "<unified diff of the release>",
    "triggerType": "WEBHOOK"
  }'`;

  return (
    <div>
      <PageHeader
        kicker="workspace"
        title="Settings"
        sub="Drafting engines, review policy, and integration surface."
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Reveal delay={0.05}>
          <div className="card h-full p-5">
            <div className="mb-4 flex items-center gap-2">
              <Cpu size={15} className="text-mint" />
              <h2 className="text-[15px] font-semibold text-snow">Drafting engines</h2>
            </div>
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-4 rounded-xl border border-hairline bg-panel-2 px-4 py-3">
                <div>
                  <div className="text-[13px] font-medium text-snow">Local engine</div>
                  <p className="mt-0.5 max-w-sm text-[12px] leading-relaxed text-fog">
                    Deterministic signal extraction and tone-aligned drafting. Air-gapped
                    deploys run on this alone.
                  </p>
                </div>
                <span className="rounded-full border border-mint/30 bg-mint-dim px-2 py-0.5 font-mono text-[10px] text-mint">
                  enabled
                </span>
              </div>
              <div className="flex items-start justify-between gap-4 rounded-xl border border-hairline bg-panel-2 px-4 py-3">
                <div>
                  <div className="flex items-center gap-1.5 text-[13px] font-medium text-snow">
                    <Cloud size={13} className="text-fog" /> OpenRouter hosted models
                  </div>
                  <p className="mt-0.5 max-w-sm text-[12px] leading-relaxed text-fog">
                    Server-side key only — never exposed to the browser. Model output must
                    cite diff evidence and passes the same validator, or the run falls back
                    to the local engine.
                  </p>
                </div>
                <span
                  className={
                    openrouter
                      ? "rounded-full border border-mint/30 bg-mint-dim px-2 py-0.5 font-mono text-[10px] text-mint"
                      : "rounded-full border border-hairline-2 px-2 py-0.5 font-mono text-[10px] text-fog"
                  }
                >
                  {openrouter ? "key set" : "not set"}
                </span>
              </div>
              <div className="flex items-center gap-2 font-mono text-[10.5px] text-fog">
                <KeyRound size={11} />
                <span>OPENROUTER_API_KEY · read at request time on the server</span>
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="card h-full p-5">
            <div className="mb-4 flex items-center gap-2">
              <Webhook size={15} className="text-mint" />
              <h2 className="text-[15px] font-semibold text-snow">Programmatic trigger</h2>
            </div>
            <p className="mb-3 text-[12.5px] leading-relaxed text-fog">
              Wire this endpoint into a GitHub release action or cron job. It runs the same
              pipeline as the dashboard and returns the review session id.
            </p>
            <div className="relative">
              <pre className="overflow-x-auto rounded-xl border border-hairline bg-[#0a0c10] p-4 font-mono text-[10.5px] leading-[1.6] text-fog">
                {curl}
              </pre>
              <div className="absolute right-3 top-3">
                <CopyButton value={curl} />
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2 font-mono text-[10.5px] text-fog">
              <Terminal size={11} />
              <span>POST /api/runs → {"{ sessionId, status }"}</span>
            </div>

            <div className="mt-4 border-t border-hairline pt-4">
              <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-snow">
                <Webhook size={13} className="text-fog" /> GitHub webhook
              </div>
              <p className="text-[12px] leading-relaxed text-fog">
                Point a repository webhook at{" "}
                <code className="rounded bg-white/[0.05] px-1 py-px font-mono text-[10.5px] text-snow/80">
                  POST /api/webhooks/github
                </code>{" "}
                (push events). The server verifies{" "}
                <code className="rounded bg-white/[0.05] px-1 py-px font-mono text-[10.5px] text-snow/80">
                  X-Hub-Signature-256
                </code>{" "}
                against <span className="font-mono text-[10.5px]">GITHUB_WEBHOOK_SECRET</span>,
                resolves the compare diff itself, and queues a review session. Optional:{" "}
                <span className="font-mono text-[10.5px]">GITHUB_TOKEN</span> for private repos,{" "}
                <span className="font-mono text-[10.5px]">GITHUB_API_BASE</span> for Enterprise.
              </p>
            </div>

            <div className="mt-4 border-t border-hairline pt-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-[13px] font-medium text-snow">Python pipeline service</div>
                <span
                  className={
                    backendUrl
                      ? "rounded-full border border-mint/30 bg-mint-dim px-2 py-0.5 font-mono text-[10px] text-mint"
                      : "rounded-full border border-hairline-2 px-2 py-0.5 font-mono text-[10px] text-fog"
                  }
                >
                  {backendUrl ? "linked" : "not linked"}
                </span>
              </div>
              <p className="text-[12px] leading-relaxed text-fog">
                The FastAPI service in <span className="font-mono text-[10.5px]">backend/</span>{" "}
                runs alongside this app (git-native repos on disk, SQLite, Ollama/OpenRouter
                drafting). This server is its trusted proxy: requests to{" "}
                <code className="rounded bg-white/[0.05] px-1 py-px font-mono text-[10.5px] text-snow/80">
                  /api/backend/sessions
                </code>{" "}
                are forwarded with{" "}
                <span className="font-mono text-[10.5px]">X-Auth-Proxy-Secret</span> injected
                server-side. Link it with{" "}
                <span className="font-mono text-[10.5px]">PIPELINE_BACKEND_URL</span>
                {backendUrl ? " — configured (upstream address withheld from the UI)." : ""}
                . One-command deployment for both tiers:{" "}
                <span className="font-mono text-[10.5px]">docker compose up --build</span>.
              </p>
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.15}>
          <div className="card h-full p-5">
            <div className="mb-4 flex items-center gap-2">
              <ShieldCheck size={15} className="text-mint" />
              <h2 className="text-[15px] font-semibold text-snow">Review policy</h2>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-hairline-2">
                  <th className="py-2 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-fog">
                    Action
                  </th>
                  {["Writer", "Reviewer", "Approver"].map((r) => (
                    <th
                      key={r}
                      className="py-2 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-fog"
                    >
                      {r}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {MATRIX.map((row) => (
                  <tr key={row.action}>
                    <td className="py-2.5 text-[12.5px] text-snow/85">{row.action}</td>
                    {[row.WRITER, row.REVIEWER, row.APPROVER].map((ok, i) => (
                      <td key={i} className="py-2.5 text-center">
                        {ok ? (
                          <Check size={13} className="mx-auto text-mint" />
                        ) : (
                          <X size={13} className="mx-auto text-fog/40" />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[11.5px] leading-relaxed text-fog">
              In production, identity arrives from your SSO proxy. This demo workspace simulates
              roles from the sidebar switcher.
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.2}>
          <div className="card h-full p-5">
            <div className="mb-4 flex items-center gap-2">
              <ShieldCheck size={15} className="text-mint" />
              <h2 className="text-[15px] font-semibold text-snow">Publish guardrails</h2>
            </div>
            <ul className="space-y-3">
              {[
                ["Version-locked patches", "Each edit snapshots the document version at draft time. If the doc moved, publish is blocked instead of clobbering."],
                ["Evidence validation", "Every edit must cite diff lines like src/api/routes.ts:L41. Uncited or unverifiable proposals route to human investigation."],
                ["Preview is free", "Drafting never touches the docs tree. Only an approved session writes — and the write happens once, at publish."],
                ["Rejection corpus", "Rejection reasons persist with the session, diff, and proposal for evaluation runs and model training curation."],
              ].map(([t, d]) => (
                <li key={t} className="flex gap-3">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-[2px] bg-mint/80" />
                  <div>
                    <div className="text-[13px] font-medium text-snow">{t}</div>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-fog">{d}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </div>
  );
}
