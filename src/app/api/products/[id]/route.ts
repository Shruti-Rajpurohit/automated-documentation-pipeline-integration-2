import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { products, toneProfiles } from "@/db/schema";
import { resolveRequestActor } from "@/lib/identity";
import { ProductBodyTooLarge, readProductInput } from "../route";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await resolveRequestActor(req))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const { id } = await params;
  let input;
  try {
    input = await readProductInput(req);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid product configuration." },
      { status: error instanceof ProductBodyTooLarge ? 413 : 400 }
    );
  }
  let updated: boolean;
  try {
    updated = await db.transaction(async (tx) => {
      const result = await tx.update(products).set({
        name: input.name,
        slug: input.slug,
        tagline: input.tagline,
        sourceRepoUrl: input.sourceRepoUrl,
        sourceRepoPath: input.sourceRepoPath,
        docsRepoUrl: input.docsRepoUrl,
        docsRepoPath: input.docsRepoPath,
        docsRoot: input.docsRoot,
        defaultBranch: input.defaultBranch,
        publishMode: input.publishMode,
        defaultProvider: input.defaultProvider,
        defaultModel: input.defaultModel,
      }).where(eq(products.id, id)).returning({ id: products.id });
      if (!result[0]) return false;
      const [tone] = await tx.select({ id: toneProfiles.id }).from(toneProfiles).where(eq(toneProfiles.productId, id));
      if (tone) {
        await tx.update(toneProfiles).set({ voice: input.voice, rules: input.rules })
          .where(and(eq(toneProfiles.productId, id), eq(toneProfiles.id, tone.id)));
      } else {
        await tx.insert(toneProfiles).values({
          id: crypto.randomUUID(),
          productId: id,
          voice: input.voice,
          rules: input.rules,
        });
      }
      return true;
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505") {
      return NextResponse.json({ error: "A product with this slug already exists." }, { status: 409 });
    }
    throw error;
  }
  if (!updated) return NextResponse.json({ error: "Product not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
