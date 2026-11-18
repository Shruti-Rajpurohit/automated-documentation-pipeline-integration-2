"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Cloud,
  Cpu,
  GitBranch,
  LoaderCircle,
  Package,
  Terminal,
} from "lucide-react";
import { cx } from "@/lib/time";

export interface LaunchProduct {
  id: string;
  name: string;
  tagline: string;
  repoUrl: string;
}

export interface LaunchFixture {
  id: string;
  productId: string;
  label: string;
  description: string;
  baseRevision: string;
  headRevision: string;
  changeSummary: string;
  diff: string;
}

const STEPS = [
  "Parsing source diff",
  "Extracting signals",
  "Mapping documentation sections",
  "Drafting in the house voice",
  "Validating evidence links",
];

export function LaunchForm({
  products,
  fixtures,
  openrouterAvailable,
}: {
  products: LaunchProduct[];
  fixtures: LaunchFixture[];
  openrouterAvailable: boolean;
}) {
  const router = useRouter();
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const productFixtures = fixtures.filter((f) => f.productId === productId);
  const [fixtureId, setFixtureId] = useState<string>(productFixtures[0]?.id ?? "");
  const fixture = fixtures.find((f) => f.id === fixtureId) ?? productFixtures[0];

  const [baseRev, setBaseRev] = useState(fixture?.baseRevision ?? "");
  const [headRev, setHeadRev] = useState(fixture?.headRevision ?? "");
  const [summary, setSummary] = useState(fixture?.changeSummary ?? "");
  const [provider, setProvider] = useState<"local" | "openrouter">("local");
  const [model, setModel] = useState("google/gemini-2.5-flash");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset the dependent fields when the selected product changes.
  // Render-phase adjustment (React-sanctioned) instead of an effect,
  // so the form never paints a stale product/fixture combination.
  const [prevProductId, setPrevProductId] = useState(productId);
  if (prevProductId !== productId) {
    setPrevProductId(productId);
    const fx = fixtures.filter((f) => f.productId === productId)[0];
    setFixtureId(fx?.id ?? "");
    setBaseRev(fx?.baseRevision ?? "");
    setHeadRev(fx?.headRevision ?? "");
    setSummary(fx?.changeSummary ?? "");
  }

  function pickFixture(id: string) {
    setFixtureId(id);
    const fx = fixtures.find((f) => f.id === id);
    if (fx) {
      setBaseRev(fx.baseRevision);
      setHeadRev(fx.headRevision);
      setSummary(fx.changeSummary);
    }
  }

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  async function submit() {
    if (!fixture) return;
    setError(null);
    setRunning(true);
    setStep(0);
    timer.current = setInterval(
      () => setStep((s) => Math.min(s + 1, STEPS.length - 1)),
      650
    );
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId,
          baseRevision: baseRev,
          headRevision: headRev,
          changeSummary: summary,
          provider,
          model: provider === "openrouter" ? model : "docline-local-1",
          diffText: fixture.diff,
          triggerType: "MANUAL",
          title: fixture.label,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.sessionId) throw new Error(json.error ?? "Run failed");
      setTimeout(() => router.push(`/sessions/${json.sessionId}`), 500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed.");
      setRunning(false);
      if (timer.current) clearInterval(timer.current);
    }
  }

  if (running) {
    return (
      <div className="card mx-auto mt-16 max-w-lg p-8 text-center">
        <LoaderCircle size={22} className="mx-auto mb-4 animate-spin text-mint" />
        <div className="mb-5 text-[15px] font-medium text-snow">Pipeline running</div>
        <ol className="space-y-2.5 text-left">
          {STEPS.map((s, i) => (
            <li
              key={s}
              className={cx(
                "flex items-center gap-2.5 font-mono text-[12px] transition-colors duration-300",
                i < step ? "text-mint" : i === step ? "text-snow" : "text-fog/50"
              )}
            >
              <span
                className={cx(
                  "grid h-4 w-4 place-items-center rounded-full border text-[9px]",
                  i < step
                    ? "border-mint/50 bg-mint-dim"
                    : i === step
                      ? "border-mint/60"
                      : "border-hairline-2"
                )}
              >
                {i < step ? "✓" : i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-5">
        {/* product */}
        <section>
          <div className="kicker mb-2">1 · Product</div>
          <div className="grid grid-cols-2 gap-3">
            {products.map((p) => (
              <button
                key={p.id}
                onClick={() => setProductId(p.id)}
                className={cx(
                  "card card-hover rounded-xl p-4 text-left",
                  productId === p.id && "border-mint/40 bg-mint-dim/40"
                )}
              >
                <div className="flex items-center gap-2 text-[14px] font-medium text-snow">
                  <Package size={14} className={productId === p.id ? "text-mint" : "text-fog"} />
                  {p.name}
                </div>
                <div className="mt-1 text-[12px] text-fog">{p.tagline}</div>
                <div className="mt-2 flex items-center gap-1 font-mono text-[10px] text-fog/80">
                  <GitBranch size={10} /> {p.repoUrl}
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* release event */}
        <section>
          <div className="kicker mb-2">2 · Release event</div>
          <div className="space-y-2">
            {productFixtures.map((f) => (
              <button
                key={f.id}
                onClick={() => pickFixture(f.id)}
                className={cx(
                  "card card-hover w-full rounded-xl p-4 text-left",
                  fixtureId === f.id && "border-mint/40 bg-mint-dim/40"
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[13.5px] font-medium text-snow">{f.label}</span>
                  <span className="font-mono text-[10.5px] text-fog">
                    {f.baseRevision} → {f.headRevision}
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-fog">{f.description}</p>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11.5px] text-fog/80">
            Demo events carry real unified diffs. In production this input arrives from a GitHub
            webhook or release action.
          </p>
        </section>

        {/* revisions + summary */}
        <section>
          <div className="kicker mb-2">3 · Range & context</div>
          <div className="card space-y-3 rounded-xl p-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-[11px] text-fog">Base revision</span>
                <input
                  value={baseRev}
                  onChange={(e) => setBaseRev(e.target.value)}
                  className="w-full rounded-lg border border-hairline bg-ink px-3 py-2 font-mono text-[12.5px] text-snow focus:border-mint/40"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-fog">Head revision</span>
                <input
                  value={headRev}
                  onChange={(e) => setHeadRev(e.target.value)}
                  className="w-full rounded-lg border border-hairline bg-ink px-3 py-2 font-mono text-[12.5px] text-snow focus:border-mint/40"
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-[11px] text-fog">
                Change summary <span className="text-fog/60">(verified against the diff — not taken on faith)</span>
              </span>
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={3}
                maxLength={4000}
                className="w-full rounded-lg border border-hairline bg-ink px-3 py-2 text-[12.5px] leading-relaxed text-snow focus:border-mint/40"
              />
            </label>
          </div>
        </section>

        {/* provider */}
        <section>
          <div className="kicker mb-2">4 · Drafting engine</div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setProvider("local")}
              className={cx(
                "card card-hover rounded-xl p-4 text-left",
                provider === "local" && "border-mint/40 bg-mint-dim/40"
              )}
            >
              <div className="flex items-center gap-2 text-[13.5px] font-medium text-snow">
                <Cpu size={14} className={provider === "local" ? "text-mint" : "text-fog"} />
                Local engine
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-fog">
                Deterministic, evidence-linked drafting. No data leaves the workspace.
              </p>
            </button>
            <button
              onClick={() => openrouterAvailable && setProvider("openrouter")}
              disabled={!openrouterAvailable}
              className={cx(
                "card card-hover rounded-xl p-4 text-left disabled:cursor-not-allowed disabled:opacity-45",
                provider === "openrouter" && "border-mint/40 bg-mint-dim/40"
              )}
            >
              <div className="flex items-center gap-2 text-[13.5px] font-medium text-snow">
                <Cloud size={14} className={provider === "openrouter" ? "text-mint" : "text-fog"} />
                OpenRouter LLM
                {!openrouterAvailable && (
                  <span className="rounded-full border border-hairline px-1.5 py-px font-mono text-[9px] text-fog">
                    key not set
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-fog">
                {openrouterAvailable
                  ? "Server-side key detected. Output is validated; invalid proposals fall back to local."
                  : "Set OPENROUTER_API_KEY on the server to enable hosted models."}
              </p>
            </button>
          </div>
          {provider === "openrouter" && (
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="mt-2 w-full rounded-lg border border-hairline bg-ink px-3 py-2 font-mono text-[12.5px] text-snow focus:border-mint/40"
              placeholder="provider/model"
            />
          )}
        </section>

        {error && (
          <div className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-[12.5px] text-coral">
            {error}
          </div>
        )}

        <button
          onClick={submit}
          disabled={!fixture}
          className="inline-flex items-center gap-2 rounded-xl bg-mint px-5 py-2.5 text-[14px] font-semibold text-ink transition-all hover:brightness-110 disabled:opacity-40"
        >
          Run pipeline <ArrowRight size={15} />
        </button>
      </div>

      {/* side: diff preview */}
      <aside className="space-y-4">
        <div className="card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5">
            <Terminal size={13} className="text-mint" />
            <span className="font-mono text-[11px] text-fog">
              {fixture ? `release diff · ${fixture.baseRevision}…${fixture.headRevision}` : "no event"}
            </span>
          </div>
          <pre className="max-h-[440px] overflow-auto p-4 font-mono text-[10.5px] leading-[1.65] text-fog">
            {fixture?.diff.slice(0, 2600) ?? ""}
            {fixture && fixture.diff.length > 2600 ? "\n…" : ""}
          </pre>
        </div>
        <div className="card p-4 text-[12px] leading-relaxed text-fog">
          <span className="text-snow/85">What happens next.</span> The run produces a review
          session, not a commit. A reviewer reads evidence-linked patches, edits the draft if
          needed, and only then can an approver publish to the docs tree.
        </div>
      </aside>
    </div>
  );
}
