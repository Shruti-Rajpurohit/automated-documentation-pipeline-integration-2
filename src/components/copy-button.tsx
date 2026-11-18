"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="inline-flex items-center gap-1 rounded-md border border-hairline px-2 py-1 text-[11px] text-fog transition-colors hover:border-hairline-2 hover:text-snow"
    >
      {copied ? <Check size={11} className="text-mint" /> : <Copy size={11} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
