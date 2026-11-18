import { db } from "@/db";
import { products } from "@/db/schema";
import { ensureWorkspaceBootstrap } from "@/lib/seed";
import { PageHeader } from "@/components/page-header";
import { LaunchForm } from "@/components/launch-form";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function NewRunPage() {
  await ensureWorkspaceBootstrap();
  const productRows = await db.select().from(products);
  if (productRows.length === 0) {
    return (
      <div>
        <PageHeader kicker="pipeline · manual trigger" title="New pipeline run" sub="Configure a product repository before starting a run." />
        <div className="card p-8 text-center">
          <p className="mb-4 text-[13px] text-fog">No products configured yet.</p>
          <Link href="/products" className="rounded-lg bg-mint px-4 py-2 text-[12px] font-semibold text-ink">Add your first product</Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        kicker="pipeline · manual trigger"
        title="New pipeline run"
        sub="Choose a configured product, resolve a local or GitHub diff, or paste a unified diff. Nothing publishes without sign-off."
      />
      <LaunchForm
        products={productRows.map((p) => ({
          id: p.id,
          name: p.name,
          tagline: p.tagline,
          defaultBranch: p.defaultBranch,
          sourceRepoUrl: p.sourceRepoUrl,
          sourceRepoPath: p.sourceRepoPath,
          defaultProvider: p.defaultProvider,
          defaultModel: p.defaultModel,
        }))}
        openrouterAvailable={Boolean(process.env.OPENROUTER_API_KEY)}
      />
    </div>
  );
}
