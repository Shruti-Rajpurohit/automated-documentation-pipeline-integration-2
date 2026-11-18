import { db } from "@/db";
import { documents, products, toneProfiles } from "@/db/schema";
import { ensureSeed } from "@/lib/seed";
import { PageHeader } from "@/components/page-header";
import { DocsBrowser } from "@/components/docs-browser";

export const dynamic = "force-dynamic";

export default async function DocsPage() {
  await ensureSeed();
  const [productRows, docRows, toneRows] = await Promise.all([
    db.select().from(products),
    db.select().from(documents),
    db.select().from(toneProfiles),
  ]);

  return (
    <div>
      <PageHeader
        kicker="corpus · house voice"
        title="Documentation corpus"
        sub="The source of truth the pipeline reads — and the tree it writes to after approval. Every publish bumps the document version, so stale proposals are blocked instead of overwritten."
      />
      <DocsBrowser
        products={productRows.map((p) => ({ id: p.id, name: p.name, tagline: p.tagline }))}
        docs={docRows
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((d) => ({
            id: d.id,
            productId: d.productId,
            path: d.path,
            title: d.title,
            content: d.content,
            version: d.version,
            updatedAt: d.updatedAt.toISOString(),
          }))}
        tones={toneRows.map((t) => ({
          productId: t.productId,
          voice: t.voice,
          person: t.person,
          formality: t.formality,
          rules: t.rules,
          samples: t.samples,
        }))}
      />
    </div>
  );
}
