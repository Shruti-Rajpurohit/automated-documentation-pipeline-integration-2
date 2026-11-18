import type { ReactNode } from "react";
import { Reveal } from "./ui";

export function PageHeader({
  kicker,
  title,
  sub,
  actions,
}: {
  kicker: string;
  title: string;
  sub?: string;
  actions?: ReactNode;
}) {
  return (
    <Reveal>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="kicker mb-2">{kicker}</div>
          <h1 className="text-[30px] font-semibold leading-none tracking-tight text-snow">
            {title}
          </h1>
          {sub && <p className="mt-2.5 max-w-xl text-[13.5px] leading-relaxed text-fog">{sub}</p>}
        </div>
        {actions}
      </div>
    </Reveal>
  );
}
