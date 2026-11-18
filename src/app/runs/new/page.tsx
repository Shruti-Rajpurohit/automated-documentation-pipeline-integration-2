import { db } from "@/db";
import { products } from "@/db/schema";
import { ensureSeed } from "@/lib/seed";
import { FIXTURES } from "@/lib/fixtures";
import { PageHeader } from "@/components/page-header";
import { LaunchForm } from "@/components/launch-form";

export const dynamic = "force-dynamic";

export default async function NewRunPage() {
  await ensureSeed();
  const productRows = await db.select().from(products);

  return (
    <div>
      <PageHeader
        kicker="pipeline · manual trigger"
        title="New pipeline run"
        sub="Pick a product and a release event. Docline reads the diff, finds the doc sections that own the topic, and drafts updates in your voice — nothing publishes without sign-off."
      />
      <LaunchForm
        products={productRows.map((p) => ({
          id: p.id,
          name: p.name,
          tagline: p.tagline,
          repoUrl: p.repoUrl,
        }))}
        fixtures={FIXTURES}
        openrouterAvailable={Boolean(process.env.OPENROUTER_API_KEY)}
      />
    </div>
  );
}
