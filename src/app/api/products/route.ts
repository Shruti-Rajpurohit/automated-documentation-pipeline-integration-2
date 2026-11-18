import { NextResponse } from "next/server";
import { db } from "@/db";
import { products, toneProfiles } from "@/db/schema";
import { resolveRequestActor } from "@/lib/identity";
import { readRequestBodyText } from "@/lib/request-body";
import { normalizeDocsRoot } from "@/lib/pipeline/docs";

export const dynamic = "force-dynamic";

type ProductInput = {
  name?: unknown;
  slug?: unknown;
  tagline?: unknown;
  sourceRepoUrl?: unknown;
  sourceRepoPath?: unknown;
  docsRepoUrl?: unknown;
  docsRepoPath?: unknown;
  docsRoot?: unknown;
  defaultBranch?: unknown;
  publishMode?: unknown;
  defaultProvider?: unknown;
  defaultModel?: unknown;
  voice?: unknown;
  rules?: unknown;
};

const publishModes = new Set(["github_pr", "local_disk", "database"]);
const providers = new Set(["local", "ollama", "openrouter"]);
const MAX_PRODUCT_BODY_BYTES = 64_000;

export class ProductBodyTooLarge extends Error {}

function parseProduct(body: ProductInput) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const slug = typeof body.slug === "string" && body.slug.trim()
    ? body.slug.trim().toLowerCase()
    : name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const sourceRepoUrl = typeof body.sourceRepoUrl === "string" ? body.sourceRepoUrl.trim() : "";
  const sourceRepoPath = typeof body.sourceRepoPath === "string" ? body.sourceRepoPath.trim() : "";
  const docsRepoUrl = typeof body.docsRepoUrl === "string" ? body.docsRepoUrl.trim() : "";
  const docsRepoPath = typeof body.docsRepoPath === "string" ? body.docsRepoPath.trim() : "";
  const publishMode = typeof body.publishMode === "string" ? body.publishMode : "database";
  const defaultProvider = typeof body.defaultProvider === "string" ? body.defaultProvider : "local";
  const defaultModel = typeof body.defaultModel === "string" ? body.defaultModel.trim() : "docline-local-1";
  const tagline = typeof body.tagline === "string" ? body.tagline.trim() : "";
  const docsRoot = typeof body.docsRoot === "string" ? normalizeDocsRoot(body.docsRoot) : "";
  const defaultBranch = typeof body.defaultBranch === "string" && body.defaultBranch.trim()
    ? body.defaultBranch.trim()
    : "main";
  const voice = typeof body.voice === "string" && body.voice.trim() ? body.voice.trim() : "Direct and plain";
  const rules: string[] = [];
  if (Array.isArray(body.rules)) {
    for (const rule of body.rules) {
      if (typeof rule !== "string") throw new Error("Writing rules must be strings.");
      if (rule.trim()) rules.push(rule.trim());
    }
  }
  if (!name || name.length > 120 || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
    throw new Error("Provide a product name and a slug containing only lowercase letters, numbers, and hyphens.");
  }
  if (!sourceRepoUrl && !sourceRepoPath && !docsRepoUrl && !docsRepoPath) {
    throw new Error("Configure at least one source or documentation repository.");
  }
  if (sourceRepoUrl.length > 2000 || docsRepoUrl.length > 2000) {
    throw new Error("Repository URLs must not exceed 2,000 characters.");
  }
  if (sourceRepoPath.length > 4096 || docsRepoPath.length > 4096) {
    throw new Error("Repository paths must not exceed 4,096 characters.");
  }
  if (
    tagline.length > 500 ||
    voice.length > 500 ||
    rules.length > 30 ||
    rules.some((rule) => rule.length > 500)
  ) {
    throw new Error("Tagline, style, or writing rules exceed their length limits.");
  }
  if (docsRoot.length > 512 || defaultBranch.length > 200 || /[\u0000-\u001f]/.test(defaultBranch)) {
    throw new Error("Documentation root or default branch is invalid or too long.");
  }
  if (!publishModes.has(publishMode)) throw new Error("publishMode must be github_pr, local_disk, or database.");
  if (publishMode === "github_pr" && !docsRepoUrl && !sourceRepoUrl) {
    throw new Error("Configure a documentation or source GitHub URL for pull-request publishing.");
  }
  if (publishMode === "local_disk" && !docsRepoPath && !sourceRepoPath) {
    throw new Error("Configure a documentation or source local checkout path for local publishing.");
  }
  if (!providers.has(defaultProvider)) throw new Error("defaultProvider must be local, ollama, or openrouter.");
  if (!defaultModel || defaultModel.length > 200) throw new Error("Provide a valid default model.");
  return {
    name,
    slug,
    tagline,
    sourceRepoUrl,
    sourceRepoPath,
    docsRepoUrl,
    docsRepoPath,
    docsRoot,
    defaultBranch,
    publishMode,
    defaultProvider,
    defaultModel,
    voice,
    rules,
  };
}

export async function readProductInput(req: Request) {
  const rawBody = await readRequestBodyText(req, MAX_PRODUCT_BODY_BYTES);
  if (rawBody === null) throw new ProductBodyTooLarge();
  const body: unknown = JSON.parse(rawBody);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parseProduct(body as ProductInput);
}

export async function GET(req: Request) {
  if (!(await resolveRequestActor(req))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const rows = await db.select().from(products).orderBy(products.name);
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  if (!(await resolveRequestActor(req))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  let input;
  try {
    input = await readProductInput(req);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid product configuration." },
      { status: error instanceof ProductBodyTooLarge ? 413 : 400 }
    );
  }

  const id = crypto.randomUUID();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(products).values({
        id,
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
      });
      await tx.insert(toneProfiles).values({
        id: crypto.randomUUID(),
        productId: id,
        voice: input.voice,
        rules: input.rules,
      });
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505") {
      return NextResponse.json({ error: "A product with this slug already exists." }, { status: 409 });
    }
    throw error;
  }
  return NextResponse.json({ id }, { status: 201 });
}

export { parseProduct };
