"use client";

import { Lock } from "lucide-react";
import { useRole } from "./shell";

export function AuthWall() {
  const { demoUsers, signIn, loading } = useRole();
  return (
    <div className="mx-auto mt-24 max-w-md">
      <div className="card p-8 text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-hairline bg-panel-2">
          <Lock size={18} className="text-mint" />
        </div>
        <h1 className="text-[17px] font-semibold text-snow">Sign in required</h1>
        <p className="mt-2 text-[12.5px] leading-relaxed text-fog">
          The workspace contains source diffs, documentation drafts, and the audit
          trail. Pick a workspace identity to continue — roles are enforced by the
          server from your signed session.
        </p>
        <div className="mt-5 space-y-1.5 text-left">
          {demoUsers
            .filter((u) => u.role !== "SYSTEM")
            .map((u) => (
              <button
                key={u.id}
                onClick={() => signIn(u.id).then(() => window.location.reload())}
                className="flex w-full items-center justify-between rounded-lg border border-hairline bg-panel-2 px-3 py-2 text-[12.5px] text-fog transition-colors hover:border-hairline-2 hover:text-snow"
              >
                <span>{u.name}</span>
                <span className="font-mono text-[10px] uppercase tracking-wider">{u.role}</span>
              </button>
            ))}
          {loading && <div className="text-center font-mono text-[11px] text-fog">loading…</div>}
        </div>
      </div>
    </div>
  );
}
