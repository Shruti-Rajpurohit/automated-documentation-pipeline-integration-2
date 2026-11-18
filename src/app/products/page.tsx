import { db } from "@/db";
import { products, toneProfiles } from "@/db/schema";
import { ensureWorkspaceBootstrap } from "@/lib/seed";
import { PageHeader } from "@/components/page-header";
import { ProductManager } from "@/components/product-manager";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  await ensureWorkspaceBootstrap();
  const [productRows, tones] = await Promise.all([
    db.select().from(products).orderBy(products.name),
    db.select().from(toneProfiles),
  ]);
  return (
    <div>
      <PageHeader
        kicker="workspace configuration"
        title="Products and repositories"
        sub="Connect source and documentation repositories, set drafting defaults, and sync documentation into the review corpus."
      />
      <ProductManager products={productRows.map((product) => {
        const tone = tones.find((item) => item.productId === product.id);
        return {
          ...product,
          voice: tone?.voice ?? "Direct and plain",
          rules: tone?.rules ?? [],
        };
      })} />
    </div>
  );
}
