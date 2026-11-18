"use client";

import { useMemo } from "react";
import { diffLines } from "diff";

interface Row {
  kind: "add" | "del" | "ctx";
  text: string;
  oldN: number | null;
  newN: number | null;
}

export function DiffViewer({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => {
    const parts = diffLines(before, after);
    const out: Row[] = [];
    let oldN = 1;
    let newN = 1;
    for (const part of parts) {
      const lines = part.value.replace(/\n$/, "").split("\n");
      for (const text of lines) {
        if (part.added) {
          out.push({ kind: "add", text, oldN: null, newN: newN++ });
        } else if (part.removed) {
          out.push({ kind: "del", text, oldN: oldN++, newN: null });
        } else {
          out.push({ kind: "ctx", text, oldN: oldN++, newN: newN++ });
        }
      }
    }
    return out;
  }, [before, after]);

  const added = rows.filter((r) => r.kind === "add").length;
  const removed = rows.filter((r) => r.kind === "del").length;

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-[#0a0c10]">
      <div className="flex items-center gap-3 border-b border-hairline px-4 py-2">
        <span className="font-mono text-[10.5px] text-fog">
          <span className="text-mint">+{added}</span>
          {"  "}
          <span className="text-coral">−{removed}</span>
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.12em] text-fog">
          proposed patch
        </span>
      </div>
      <div className="max-h-[520px] overflow-auto py-2 font-mono text-[11.5px] leading-[1.7]">
        <table className="w-full border-collapse">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.kind === "add" ? "diff-add" : r.kind === "del" ? "diff-del" : ""}>
                <td className="w-10 select-none pr-2 text-right align-top text-[10px] text-white/25">
                  {r.oldN ?? ""}
                </td>
                <td className="w-10 select-none pr-2 text-right align-top text-[10px] text-white/25">
                  {r.newN ?? ""}
                </td>
                <td className="w-5 select-none pl-1 align-top">
                  <span className={r.kind === "add" ? "text-mint" : r.kind === "del" ? "text-coral" : "text-white/20"}>
                    {r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}
                  </span>
                </td>
                <td className={cxCell(r.kind)}>{r.text || " "}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function cxCell(kind: Row["kind"]) {
  return kind === "ctx"
    ? "whitespace-pre-wrap pr-4 diff-ctx"
    : "whitespace-pre-wrap pr-4";
}
