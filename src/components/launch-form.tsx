"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Cloud, Cpu, GitBranch, LoaderCircle, Package, RefreshCw, Terminal } from "lucide-react";
import { cx } from "@/lib/time";

export interface LaunchProduct {
  id: string;
  name: string;
  tagline: string;
  defaultBranch: string;
  sourceRepoUrl: string;
  sourceRepoPath: string;
  defaultProvider: string;
  defaultModel: string;
}

type SourceMode = "local" | "github" | "manual";
type Provider = "local" | "ollama" | "openrouter";

function configuredProvider(value: string | undefined): Provider {
  return value === "ollama" || value === "openrouter" ? value : "local";
}

const STEPS = ["Parsing source diff", "Extracting signals", "Mapping documentation sections", "Drafting proposal", "Validating evidence"];
const card = "card card-hover rounded-xl p-4 text-left";
const input = "w-full rounded-lg border border-hairline bg-ink px-3 py-2 font-mono text-[12px] text-snow";

export function LaunchForm({
  products,
  openrouterAvailable,
}: {
  products: LaunchProduct[];
  openrouterAvailable: boolean;
}) {
  const router = useRouter();
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const product = products.find((item) => item.id === productId);
  const [productSettings, setProductSettings] = useState<{
    productId: string;
    source: SourceMode;
    provider: Provider;
    model: string;
  } | null>(null);
  const settings = productSettings && productSettings.productId === product?.id ? productSettings : {
    productId: product?.id ?? "",
    source: product?.sourceRepoPath ? "local" as const : product?.sourceRepoUrl ? "github" as const : "manual" as const,
    provider: configuredProvider(product?.defaultProvider),
    model: product?.defaultModel || "docline-local-1",
  };
  const { source, provider, model } = settings;
  function updateSettings(update: Partial<typeof settings>) {
    setProductSettings({ ...settings, ...update });
  }
  function setSource(value: SourceMode) {
    setError("");
    updateSettings({ source: value });
  }
  function switchProduct(value: string) {
    setError("");
    setProductId(value);
  }
  function setProvider(value: Provider, nextModel?: string) {
    updateSettings({ provider: value, ...(nextModel ? { model: nextModel } : {}) });
  }
  function setModel(value: string) {
    updateSettings({ model: value });
  }
  const [baseRevision, setBaseRevision] = useState("");
  const [headRevision, setHeadRevision] = useState("HEAD");
  const [changeSummary, setChangeSummary] = useState("");
  const [diffText, setDiffText] = useState("");
  const [refsResult, setRefsResult] = useState<{ key: string; refs: string[] }>({ key: "", refs: [] });
  const [models, setModels] = useState<string[]>([]);
  const [ollamaAvailable, setOllamaAvailable] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState(0);
  const refsKey = product ? `${product.id}:${source}` : "";
  const refs = refsResult.key === refsKey ? refsResult.refs : [];
  const loadingRefs = source !== "manual" && Boolean(product) && refsResult.key !== refsKey;

  useEffect(() => {
    fetch("/api/providers/models")
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Could not load model providers.");
        setModels(result.ollama.models ?? []);
        setOllamaAvailable(result.ollama.available === true);
      })
      .catch(() => {
        setModels([]);
        setOllamaAvailable(false);
      });
  }, []);

  const productIdForRefs = product?.id;
  useEffect(() => {
    if (source === "manual" || !productIdForRefs) return;
    let active = true;
    const key = `${productIdForRefs}:${source}`;
    fetch(`/api/products/${productIdForRefs}/git-refs?source=${source}`)
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Could not load repository refs.");
        if (active) {
          setRefsResult({ key, refs: result.refs ?? [] });
          setError("");
        }
      })
      .catch((reason) => {
        if (active) {
          setRefsResult({ key, refs: [] });
          setError(reason instanceof Error ? reason.message : "Could not load repository refs.");
        }
      });
    return () => { active = false; };
  }, [productIdForRefs, source]);

  async function resolveDiff() {
    if (!product) return;
    setError("");
    try {
      const response = await fetch(`/api/products/${product.id}/diff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source,
          baseRevision: baseRevision || product.defaultBranch || "main",
          headRevision: headRevision || "HEAD",
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not resolve diff.");
      setDiffText(result.diff);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not resolve diff.");
    }
  }

  async function submit() {
    if (!product || !diffText.trim()) {
      setError("Select a product and provide a non-empty unified diff.");
      return;
    }
    setError("");
    setRunning(true);
    setStep(0);
    const timer = setInterval(() => setStep((current) => Math.min(current + 1, STEPS.length - 1)), 650);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId,
          baseRevision: baseRevision || (source === "manual" ? "manual" : product.defaultBranch || "main"),
          headRevision: headRevision || (source === "manual" ? "manual" : "HEAD"),
          changeSummary,
          provider,
          model: provider === "local" ? "docline-local-1" : model,
          diffText,
          triggerType: "MANUAL",
          async: true,
        }),
      });
      const result = await response.json();
      if (!response.ok || typeof result.jobId !== "string") {
        throw new Error(result.error ?? "Could not queue pipeline run.");
      }
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const jobResponse = await fetch(`/api/jobs/${encodeURIComponent(result.jobId)}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
        const job = await jobResponse.json();
        if (!jobResponse.ok) throw new Error(job.error ?? "Could not check pipeline run status.");
        if (job.status === "COMPLETED") {
          if (typeof job.result?.sessionId !== "string") {
            throw new Error("Pipeline job completed without returning a session.");
          }
          router.push(`/sessions/${job.result.sessionId}`);
          return;
        }
        if (job.status === "FAILED") {
          throw new Error(job.lastError || "Pipeline run failed.");
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pipeline run failed.");
      setRunning(false);
    } finally {
      clearInterval(timer);
    }
  }

  if (running) {
    return (
      <div className="card mx-auto mt-16 max-w-lg p-8 text-center">
        <LoaderCircle size={22} className="mx-auto mb-4 animate-spin text-mint" />
        <div className="mb-5 text-[15px] font-medium text-snow">Pipeline running</div>
        <ol className="space-y-2.5 text-left">
          {STEPS.map((item, index) => (
            <li key={item} className={cx("font-mono text-[12px]", index <= step ? "text-mint" : "text-fog/50")}>{index + 1}. {item}</li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-5">
        <section>
          <div className="kicker mb-2">1 · Product</div>
          <div className="grid gap-3 sm:grid-cols-2">
            {products.map((item) => (
              <button key={item.id} onClick={() => { switchProduct(item.id); setBaseRevision(""); setHeadRevision("HEAD"); }} className={cx(card, productId === item.id && "border-mint/40 bg-mint-dim/40")}>
                <span className="flex items-center gap-2 text-[14px] font-medium text-snow"><Package size={14} />{item.name}</span>
                <span className="mt-1 block text-[12px] text-fog">{item.tagline}</span>
                <span className="mt-2 block truncate font-mono text-[10px] text-fog">{item.sourceRepoUrl || item.sourceRepoPath}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="kicker mb-2">2 · Source change</div>
          <div className="mb-3 flex flex-wrap gap-2">
            {([
              ["local", "Local Git"],
              ["github", "GitHub compare"],
              ["manual", "Paste diff"],
            ] as const).map(([value, label]) => (
              <button key={value} onClick={() => setSource(value)} className={cx("rounded-lg border px-3 py-2 text-[12px]", source === value ? "border-mint/40 bg-mint-dim/40 text-mint" : "border-hairline text-fog")}>{label}</button>
            ))}
          </div>
          {source !== "manual" && (
            <div className="card space-y-3 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-[11px] text-fog">Base revision
                  <input list="git-revisions" className={input} value={baseRevision} onChange={(event) => setBaseRevision(event.target.value)} placeholder={product?.defaultBranch || "HEAD~1, branch, tag or SHA"} />
                </label>
                <label className="text-[11px] text-fog">Head revision
                  <input list="git-revisions" className={input} value={headRevision} onChange={(event) => setHeadRevision(event.target.value)} placeholder="HEAD, branch, tag or SHA" />
                </label>
                <datalist id="git-revisions">{refs.map((ref) => <option key={ref} value={ref} />)}</datalist>
              </div>
              <button type="button" disabled={loadingRefs || !product} onClick={resolveDiff} className="inline-flex items-center gap-2 rounded-lg border border-hairline px-3 py-2 text-[12px] text-snow disabled:opacity-50">
                {loadingRefs ? <LoaderCircle size={13} className="animate-spin" /> : <RefreshCw size={13} />} Load diff preview
              </button>
              {source === "local" && !product?.sourceRepoPath && <p className="text-[11px] text-fog">Configure a local source checkout in Products, or use GitHub compare.</p>}
              {source === "github" && !product?.sourceRepoUrl && <p className="text-[11px] text-fog">Configure a source GitHub URL in Products.</p>}
            </div>
          )}
          {source === "manual" && (
            <textarea value={diffText} onChange={(event) => setDiffText(event.target.value)} rows={14} maxLength={250000} className={`${input} font-mono`} placeholder="Paste a unified diff, including diff --git and @@ hunk headers." />
          )}
          <label className="mt-3 block text-[11px] text-fog">Change summary / context
            <textarea value={changeSummary} onChange={(event) => setChangeSummary(event.target.value)} rows={2} maxLength={4000} className={`${input} mt-1`} />
          </label>
        </section>

        <section>
          <div className="kicker mb-2">3 · Drafting provider</div>
          <div className="grid gap-3 sm:grid-cols-3">
            <button onClick={() => setProvider("local", "docline-local-1")} className={cx(card, provider === "local" && "border-mint/40 bg-mint-dim/40")}><Cpu size={14} className="mb-2 text-mint" /><span className="block text-[13px] text-snow">Deterministic</span></button>
            <button disabled={!ollamaAvailable} onClick={() => setProvider("ollama", models[0] ?? "qwen2.5-coder:7b")} className={cx(card, provider === "ollama" && "border-mint/40 bg-mint-dim/40", !ollamaAvailable && "opacity-50")}><Terminal size={14} className="mb-2 text-mint" /><span className="block text-[13px] text-snow">Ollama {!ollamaAvailable && "(offline)"}</span></button>
            <button disabled={!openrouterAvailable} onClick={() => setProvider("openrouter", product?.defaultProvider === "openrouter" ? product.defaultModel : "google/gemini-2.5-flash")} className={cx(card, provider === "openrouter" && "border-mint/40 bg-mint-dim/40", !openrouterAvailable && "opacity-50")}><Cloud size={14} className="mb-2 text-mint" /><span className="block text-[13px] text-snow">OpenRouter {!openrouterAvailable && "(no key)"}</span></button>
          </div>
          {provider !== "local" && (
            <>
              {provider === "ollama" && models.length > 0 && (
                <select value={model} onChange={(event) => setModel(event.target.value)} className={`${input} mt-2`}>
                  {models.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              )}
              <input value={model} onChange={(event) => setModel(event.target.value)} className={`${input} mt-2`} placeholder={provider === "ollama" ? "custom Ollama model" : "provider/model"} />
            </>
          )}
        </section>
        {error && <p role="alert" className="text-[12px] text-coral">{error}</p>}
        <button onClick={submit} disabled={!product || !diffText.trim()} className="inline-flex items-center gap-2 rounded-xl bg-mint px-5 py-2.5 text-[14px] font-semibold text-ink disabled:opacity-40">Run pipeline <ArrowRight size={15} /></button>
      </div>

      <aside className="space-y-4">
        <div className="card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5"><GitBranch size={13} className="text-mint" /><span className="font-mono text-[11px] text-fog">diff preview · {baseRevision || "base"}…{headRevision || "head"}</span></div>
          <pre className="max-h-[440px] overflow-auto p-4 font-mono text-[10.5px] leading-[1.65] text-fog">{diffText.slice(0, 10000)}{diffText.length > 10000 ? "\n…" : ""}</pre>
        </div>
        <div className="card p-4 text-[12px] leading-relaxed text-fog">
          A run creates a review session, not a commit. Review the evidence-linked proposal before approval and publication.
        </div>
      </aside>
    </div>
  );
}
