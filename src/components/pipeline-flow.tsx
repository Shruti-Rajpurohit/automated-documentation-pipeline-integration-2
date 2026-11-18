"use client";

import { motion } from "framer-motion";
import {
  GitCommitHorizontal,
  ScanSearch,
  PenLine,
  ShieldCheck,
  Rocket,
} from "lucide-react";

const STAGES = [
  { icon: GitCommitHorizontal, label: "Detect", note: "release diff" },
  { icon: ScanSearch, label: "Retrieve", note: "map sections" },
  { icon: PenLine, label: "Draft", note: "house voice" },
  { icon: ShieldCheck, label: "Review", note: "human gate" },
  { icon: Rocket, label: "Publish", note: "docs tree" },
];

export function PipelineFlow() {
  return (
    <div className="relative">
      <svg
        className="absolute left-0 right-0 top-[26px] h-px w-full"
        preserveAspectRatio="none"
        aria-hidden
      >
        <line
          x1="26"
          y1="0.5"
          x2="100%"
          y2="0.5"
          stroke="rgba(94,234,160,0.35)"
          strokeWidth="1"
          className="flow-dash"
        />
      </svg>
      <div className="relative grid grid-cols-5">
        {STAGES.map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 + i * 0.12, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-col items-center gap-1.5 text-center"
          >
            <div className="grid h-[52px] w-[52px] place-items-center rounded-2xl border border-hairline bg-panel shadow-[0_0_30px_rgba(94,234,160,0.06)]">
              <s.icon size={19} strokeWidth={1.7} className="text-mint" />
            </div>
            <div className="text-[12.5px] font-medium text-snow">{s.label}</div>
            <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-fog">
              {s.note}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
