"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Save } from "lucide-react";

export interface ManagedProduct {
  id: string;
  name: string;
  slug: string;
  tagline: string;
  sourceRepoUrl: string;
  sourceRepoPath: string;
  docsRepoUrl: string;
  docsRepoPath: string;
  docsRoot: string;
  defaultBranch: string;
  publishMode: string;
  defaultProvider: string;
  defaultModel: string;
  voice: string;
  rules: string[];
}

const EMPTY: Omit<ManagedProduct, "id"> = {
  name: "",
  slug: "",
  tagline: "",
  sourceRepoUrl: "",
  sourceRepoPath: "",
  docsRepoUrl: "",
  docsRepoPath: "",
  docsRoot: "",
  defaultBranch: "main",
  publishMode: "database",
  defaultProvider: "local",
  defaultModel: "docline-local-1",
  voice: "Direct and plain",
  rules: [],
};

const fieldClass = "w-full rounded-lg border border-hairline bg-ink px-3 py-2 text-[12.5px] text-snow";

export function ProductManager({ products }: { products: ManagedProduct[] }) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState("");
  const selected = products.find((product) => product.id === selectedId);
  const [form, setForm] = useState<Omit<ManagedProduct, "id">>(EMPTY);
  const [rulesText, setRulesText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function choose(id: string) {
    setSelectedId(id);
    const product = products.find((item) => item.id === id);
    if (!product) {
      setForm(EMPTY);
      setRulesText("");
      return;
    }
    const { id: _id, rules, ...fields } = product;
    setForm({ ...fields, rules });
    setRulesText(rules.join("\n"));
  }

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(selected ? `/api/products/${selected.id}` : "/api/products", {
        method: selected ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          rules: rulesText.split("\n").map((rule) => rule.trim()).filter(Boolean),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not save product.");
      setMessage(selected ? "Product settings saved." : "Product created.");
      if (!selected) {
        setSelectedId(result.id);
        setForm({ ...form });
      }
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save product.");
    } finally {
      setBusy(false);
    }
  }

  async function syncDocs() {
    if (!selected) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/products/${selected.id}/sync-docs`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Documentation sync failed.");
      setMessage(`Synced ${result.synced} documentation files.`);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Documentation sync failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
      <aside className="card h-fit p-4">
        <h2 className="mb-3 text-[14px] font-semibold text-snow">Products</h2>
        <div className="space-y-1">
          {products.map((product) => (
            <button
              key={product.id}
              onClick={() => choose(product.id)}
              className={`w-full rounded-lg px-3 py-2 text-left text-[13px] ${selectedId === product.id ? "bg-white/[0.08] text-snow" : "text-fog hover:bg-white/[0.04]"}`}
            >
              {product.name}
            </button>
          ))}
          <button
            onClick={() => choose("")}
            className="w-full rounded-lg border border-dashed border-hairline px-3 py-2 text-left text-[12px] text-mint"
          >
            + Add product
          </button>
        </div>
      </aside>

      <form onSubmit={submit} className="card space-y-4 p-5">
        <h2 className="text-[15px] font-semibold text-snow">
          {selected ? `Configure ${selected.name}` : "Add a product"}
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-[11px] text-fog">Product name
            <input required className={fieldClass} value={form.name} onChange={(event) => set("name", event.target.value)} />
          </label>
          <label className="text-[11px] text-fog">Slug
            <input className={fieldClass} value={form.slug} onChange={(event) => set("slug", event.target.value)} placeholder="derived from name if empty" />
          </label>
          <label className="text-[11px] text-fog">Tagline
            <input className={fieldClass} value={form.tagline} onChange={(event) => set("tagline", event.target.value)} />
          </label>
          <label className="text-[11px] text-fog">Default branch
            <input className={fieldClass} value={form.defaultBranch} onChange={(event) => set("defaultBranch", event.target.value)} />
          </label>
          <label className="text-[11px] text-fog">Source GitHub URL
            <input className={fieldClass} value={form.sourceRepoUrl} onChange={(event) => set("sourceRepoUrl", event.target.value)} placeholder="https://github.com/org/project" />
          </label>
          <label className="text-[11px] text-fog">Source local checkout
            <input className={fieldClass} value={form.sourceRepoPath} onChange={(event) => set("sourceRepoPath", event.target.value)} placeholder="/absolute/path/to/source" />
          </label>
          <label className="text-[11px] text-fog">Docs GitHub URL (optional if same as source)
            <input className={fieldClass} value={form.docsRepoUrl} onChange={(event) => set("docsRepoUrl", event.target.value)} placeholder="https://github.com/org/project-docs" />
          </label>
          <label className="text-[11px] text-fog">Docs local checkout
            <input className={fieldClass} value={form.docsRepoPath} onChange={(event) => set("docsRepoPath", event.target.value)} placeholder="/absolute/path/to/docs" />
          </label>
          <label className="text-[11px] text-fog">Docs root (blank for repository root)
            <input className={fieldClass} value={form.docsRoot} onChange={(event) => set("docsRoot", event.target.value)} placeholder="docs" />
          </label>
          <label className="text-[11px] text-fog">Publish mode
            <select className={fieldClass} value={form.publishMode} onChange={(event) => set("publishMode", event.target.value)}>
              <option value="database">Database (local testing)</option>
              <option value="local_disk">Local disk</option>
              <option value="github_pr">GitHub pull request</option>
            </select>
          </label>
          <label className="text-[11px] text-fog">Default provider
            <select className={fieldClass} value={form.defaultProvider} onChange={(event) => set("defaultProvider", event.target.value)}>
              <option value="local">Deterministic</option>
              <option value="ollama">Ollama</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </label>
          <label className="text-[11px] text-fog">Default model
            <input className={fieldClass} value={form.defaultModel} onChange={(event) => set("defaultModel", event.target.value)} />
          </label>
        </div>
        <label className="block text-[11px] text-fog">Tone / style
          <input className={fieldClass} value={form.voice} onChange={(event) => set("voice", event.target.value)} />
        </label>
        <label className="block text-[11px] text-fog">Writing rules (one per line)
          <textarea rows={3} className={fieldClass} value={rulesText} onChange={(event) => setRulesText(event.target.value)} />
        </label>
        {error && <p role="alert" className="text-[12px] text-coral">{error}</p>}
        {message && <p role="status" className="text-[12px] text-mint">{message}</p>}
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-mint px-4 py-2 text-[12px] font-semibold text-ink disabled:opacity-50">
            <Save size={13} /> {busy ? "Saving…" : selected ? "Save product" : "Create product"}
          </button>
          {selected && (
            <button type="button" disabled={busy} onClick={syncDocs} className="inline-flex items-center gap-2 rounded-lg border border-hairline px-4 py-2 text-[12px] text-snow disabled:opacity-50">
              <RefreshCw size={13} /> Sync documentation
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
