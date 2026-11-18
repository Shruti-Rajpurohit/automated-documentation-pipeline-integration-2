"use client";

import { useMemo, useState } from "react";
import { BookOpen, FileText, Quote, Search } from "lucide-react";
import { Markdown } from "./markdown";
import { cx, relativeTime } from "@/lib/time";

export interface DocRecord {
  id: string;
  productId: string;
  path: string;
  title: string;
  docKind: string;
  content: string;
  version: number;
  updatedAt: string;
}

export interface ToneRecord {
  productId: string;
  voice: string;
  person: string;
  formality: number;
  rules: string[];
  samples: string[];
}

export function DocsBrowser({
  products,
  docs,
  tones,
}: {
  products: { id: string; name: string; tagline: string }[];
  docs: DocRecord[];
  tones: ToneRecord[];
}) {
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const productDocs = docs.filter((d) => d.productId === productId);
  const filtered = useMemo(
    () =>
      productDocs.filter(
        (d) =>
          d.title.toLowerCase().includes(query.toLowerCase()) ||
          d.path.toLowerCase().includes(query.toLowerCase())
      ),
    [productDocs, query]
  );
  const [docId, setDocId] = useState<string | null>(null);
  const current = filtered.find((d) => d.id === docId) ?? filtered[0] ?? null;
  const tone = tones.find((t) => t.productId === productId);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl border border-hairline bg-panel p-1">
          {products.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setProductId(p.id);
                setDocId(null);
              }}
              className={cx(
                "rounded-lg px-3.5 py-1.5 text-[13px] transition-colors",
                productId === p.id ? "bg-white/[0.07] text-snow" : "text-fog hover:text-snow/80"
              )}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-fog" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter docs…"
            className="w-56 rounded-xl border border-hairline bg-panel py-2 pl-8 pr-3 text-[12.5px] text-snow placeholder:text-fog/60 focus:border-mint/40"
          />
        </div>
      </div>

      {tone && (
        <div className="card mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
          <div>
            <div className="kicker mb-1">House voice</div>
            <div className="text-[14px] font-medium text-snow">{tone.voice}</div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {tone.rules.map((r) => (
              <span
                key={r}
                className="rounded-full border border-hairline bg-white/[0.03] px-2.5 py-1 text-[11px] text-snow/75"
              >
                {r}
              </span>
            ))}
          </div>
          <div className="ml-auto hidden items-start gap-2 xl:flex">
            {tone.samples.slice(0, 1).map((s) => (
              <div key={s} className="flex max-w-[320px] items-start gap-2 text-[12px] italic text-fog">
                <Quote size={11} className="mt-0.5 shrink-0 text-mint/70" />
                {s}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[290px_1fr]">
        <div className="space-y-1.5">
          {filtered.map((d) => (
            <button
              key={d.id}
              onClick={() => setDocId(d.id)}
              className={cx(
                "card card-hover flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left",
                current?.id === d.id && "border-mint/35 bg-mint-dim/30"
              )}
            >
              <FileText
                size={15}
                className={current?.id === d.id ? "text-mint" : "text-fog"}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-snow">{d.title}</div>
                <div className="truncate font-mono text-[10.5px] text-fog">{d.path} · {d.docKind}</div>
              </div>
              <div className="text-right font-mono text-[10px] text-fog">
                <div>v{d.version}</div>
                <div>{relativeTime(d.updatedAt)}</div>
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="card p-6 text-center text-[12.5px] text-fog">
              No documents match “{query}”.
            </div>
          )}
        </div>

        <div className="card overflow-hidden">
          {current ? (
            <>
              <div className="flex items-center gap-3 border-b border-hairline px-6 py-3">
                <BookOpen size={14} className="text-mint" />
                <span className="font-mono text-[12px] text-snow/90">{current.path}</span>
                <span className="ml-auto font-mono text-[10.5px] text-fog">
                  v{current.version} · updated {relativeTime(current.updatedAt)}
                </span>
              </div>
              <div className="px-7 py-6">
                <Markdown content={current.content} />
              </div>
            </>
          ) : (
            <div className="p-10 text-center text-[13px] text-fog">Select a document.</div>
          )}
        </div>
      </div>
    </div>
  );
}
