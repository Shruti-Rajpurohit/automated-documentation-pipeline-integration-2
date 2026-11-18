"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { cx } from "@/lib/time";

export const STATUS: Record<
  string,
  { label: string; classes: string; dot: string; pulse?: boolean }
> = {
  AWAITING_REVIEW: {
    label: "Awaiting review",
    classes: "bg-amberish/12 text-amberish border-amberish/25",
    dot: "bg-amberish",
    pulse: true,
  },
  APPROVED: {
    label: "Approved",
    classes: "bg-mint-dim text-mint border-mint/25",
    dot: "bg-mint",
  },
  PUBLISHED: {
    label: "Published",
    classes: "bg-sky/12 text-sky border-sky/25",
    dot: "bg-sky",
  },
  PR_OPEN: {
    label: "Pull request created",
    classes: "bg-sky/12 text-sky border-sky/25",
    dot: "bg-sky",
  },
  REJECTED: {
    label: "Rejected",
    classes: "bg-coral/12 text-coral border-coral/25",
    dot: "bg-coral",
  },
  NO_UPDATE: {
    label: "No update",
    classes: "bg-white/[0.05] text-fog border-hairline-2",
    dot: "bg-fog",
  },
  NEEDS_INVESTIGATION: {
    label: "Needs investigation",
    classes: "bg-coral/12 text-coral border-coral/25",
    dot: "bg-coral",
    pulse: true,
  },
};

const FALLBACK_STATUS = { label: "Unknown state", classes: "border-hairline-2 text-fog", dot: "bg-fog", pulse: false };

export function StatusChip({ status, size = "md" }: { status: string; size?: "sm" | "md" }) {
  const s = STATUS[status] ?? { ...FALLBACK_STATUS, label: status.replaceAll("_", " ").toLowerCase() };
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border font-medium",
        size === "sm" ? "px-2 py-px text-[10.5px]" : "px-2.5 py-[3px] text-[11.5px]",
        s.classes
      )}
    >
      <span className={cx("relative h-[6px] w-[6px] rounded-full", s.dot, s.pulse && "pulse-dot")} />
      {s.label}
    </span>
  );
}

export function Avatar({ name, hue, size = 26 }: { name: string; hue: number; size?: number }) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white/90"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `linear-gradient(135deg, hsl(${hue} 55% 38%), hsl(${hue + 30} 50% 28%))`,
      }}
    >
      {initials}
    </span>
  );
}

export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

export function Counter({ value, suffix = "" }: { value: number; suffix?: string }) {
  const [display, setDisplay] = useState(0);
  const raf = useRef<number>(0);
  useEffect(() => {
    const start = performance.now();
    const dur = 900;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(value * eased));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);
  return (
    <span className="tabular-nums">
      {display}
      {suffix}
    </span>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[0.82em]", className)}>{children}</span>;
}

export function Kicker({ children }: { children: ReactNode }) {
  return <div className="kicker mb-2 flex items-center gap-2">{children}</div>;
}
