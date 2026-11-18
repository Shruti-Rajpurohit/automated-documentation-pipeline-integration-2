import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { documents, products } from "@/db/schema";
import { resolveRequestActor } from "@/lib/identity";
import {
  classifyDocumentKind,
  documentTitle,
  isDocumentationFile,
  normalizeDocsRoot,
  resolveRepositoryPath,
} from "@/lib/pipeline/docs";

export const dynamic = "force-dynamic";
const MAX_FILES = 1000;
const MAX_FILE_BYTES = 1_000_000;

type SyncFile = { path: string; content: string };

function repoDetails(value: string) {
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(value);
  const url = new URL(ssh ? `https://${ssh[1]}/${ssh[2]}` : value.includes("://") ? value : `https://${value}`);
  const parts = url.pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("Documentation GitHub URL must include an owner and repository.");
  if (!process.env.GITHUB_API_BASE && url.hostname !== "github.com") {
    throw new Error("Set GITHUB_API_BASE to use GitHub Enterprise documentation repositories.");
  }
  return {
    owner: parts.at(-2)!,
    name: parts.at(-1)!,
    api: (process.env.GITHUB_API_BASE?.replace(/\/+$/, "") || "https://api.github.com"),
  };
}

async function githubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub documentation sync failed (${response.status}).`);
  return response.json() as Promise<T>;
}

async function readLocalFiles(repositoryPath: string, root: string): Promise<SyncFile[]> {
  const docsDirectory = resolve(repositoryPath, root);
  const files: SyncFile[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && isDocumentationFile(path)) {
        if (files.length >= MAX_FILES) throw new Error(`Documentation sync is limited to ${MAX_FILES} files.`);
        const content = await readFile(path);
        if (content.byteLength > MAX_FILE_BYTES) {
          throw new Error(`Documentation file exceeds the 1 MB sync limit: ${relative(repositoryPath, path)}`);
        }
        files.push({ path: relative(repositoryPath, path).split("\\").join("/"), content: content.toString("utf8") });
      }
    }
  }
  await walk(docsDirectory);
  return files;
}

async function readGitHubFiles(repoUrl: string, docsRoot: string): Promise<SyncFile[]> {
  const { owner, name, api } = repoDetails(repoUrl);
  const repositoryApi = `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const metadata = await githubJson<{ default_branch: string }>(repositoryApi);
  const tree = await githubJson<{ truncated: boolean; tree: { path: string; type: string; size?: number }[] }>(
    `${repositoryApi}/git/trees/${encodeURIComponent(metadata.default_branch)}?recursive=1`
  );
  if (tree.truncated) throw new Error("GitHub truncated the repository tree. Sync a smaller docs root or use a local checkout.");
  const root = docsRoot.replace(/\/+$/, "");
  const candidates = tree.tree.filter((item) =>
    item.type === "blob" &&
    isDocumentationFile(item.path) &&
    (!root || item.path.startsWith(`${root}/`))
  );
  if (candidates.some((item) => (item.size ?? 0) > MAX_FILE_BYTES)) {
  throw new Error("A documentation file exceeds the 1 MB sync limit.");
  }
  if (candidates.length > MAX_FILES) throw new Error(`Documentation sync is limited to ${MAX_FILES} files.`);
  const files: SyncFile[] = [];
  for (const item of candidates) {
    const response = await fetch(`${repositoryApi}/contents/${item.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(metadata.default_branch)}`, {
      headers: {
        accept: "application/vnd.github+json",
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`GitHub could not read documentation file ${item.path} (${response.status}).`);
    const file = await response.json() as { content?: string; encoding?: string };
    if (file.encoding !== "base64" || typeof file.content !== "string") {
      throw new Error(`GitHub returned an unsupported encoding for ${item.path}.`);
    }
    const content = Buffer.from(file.content.replace(/\n/g, ""), "base64");
    if (content.byteLength > MAX_FILE_BYTES) throw new Error(`Documentation file exceeds the 1 MB sync limit: ${item.path}`);
    files.push({ path: item.path, content: content.toString("utf8") });
  }
  return files;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await resolveRequestActor(req))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const { id } = await params;
  const [product] = await db.select().from(products).where(eq(products.id, id));
  if (!product) return NextResponse.json({ error: "Product not found." }, { status: 404 });

  try {
    const root = normalizeDocsRoot(product.docsRoot);
    let files: SyncFile[];
    if (product.docsRepoPath || product.sourceRepoPath) {
      const repositoryPath = resolveRepositoryPath(product.docsRepoPath || product.sourceRepoPath);
      files = await readLocalFiles(repositoryPath, root);
    } else if (product.docsRepoUrl || product.sourceRepoUrl) {
      files = await readGitHubFiles(product.docsRepoUrl || product.sourceRepoUrl, root);
    } else {
      throw new Error("Configure docsRepoPath or docsRepoUrl before syncing documentation.");
    }
    const syncedAt = new Date();
    await db.transaction(async (tx) => {
      for (const file of files) {
        const [existing] = await tx.select().from(documents)
          .where(and(eq(documents.productId, product.id), eq(documents.path, file.path)));
        if (!existing) {
          await tx.insert(documents).values({
            id: crypto.randomUUID(),
            productId: product.id,
            path: file.path,
            title: documentTitle(file.path, file.content),
            format: file.path.slice(file.path.lastIndexOf(".") + 1).toLowerCase(),
            docKind: classifyDocumentKind(file.path),
            content: file.content,
            version: 1,
            createdAt: syncedAt,
            updatedAt: syncedAt,
          });
        } else if (existing.content !== file.content) {
          await tx.update(documents).set({
            title: documentTitle(file.path, file.content),
            format: file.path.slice(file.path.lastIndexOf(".") + 1).toLowerCase(),
            docKind: classifyDocumentKind(file.path),
            content: file.content,
            version: existing.version + 1,
            updatedAt: syncedAt,
          }).where(eq(documents.id, existing.id));
        }
      }
    });
    return NextResponse.json({ synced: files.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Documentation sync failed." },
      { status: 422 }
    );
  }
}
