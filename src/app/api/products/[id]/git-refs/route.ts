import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { products } from "@/db/schema";
import { resolveRequestActor } from "@/lib/identity";
import { resolveRepositoryPath } from "@/lib/pipeline/docs";

export const dynamic = "force-dynamic";
const execFileAsync = promisify(execFile);

function githubRepository(value: string) {
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(value);
  const url = new URL(ssh ? `https://${ssh[1]}/${ssh[2]}` : value.includes("://") ? value : `https://${value}`);
  const parts = url.pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("Source GitHub URL must include an owner and repository.");
  if (!process.env.GITHUB_API_BASE && url.hostname !== "github.com") {
    throw new Error("Set GITHUB_API_BASE to use GitHub Enterprise repositories.");
  }
  return {
    owner: parts.at(-2)!,
    name: parts.at(-1)!,
    api: process.env.GITHUB_API_BASE?.replace(/\/+$/, "") || "https://api.github.com",
  };
}

async function githubList<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Could not read GitHub revisions (${response.status}).`);
  return response.json() as Promise<T>;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await resolveRequestActor(req))) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await params;
  const [product] = await db.select().from(products).where(eq(products.id, id));
  if (!product) return NextResponse.json({ error: "Product not found." }, { status: 404 });
  try {
    const requestedSource = new URL(req.url).searchParams.get("source");
    if (requestedSource && requestedSource !== "local" && requestedSource !== "github") {
      return NextResponse.json({ error: "source must be local or github." }, { status: 400 });
    }
    const useLocal = requestedSource === "local" ||
      (!requestedSource && Boolean(product.sourceRepoPath));
    if (useLocal) {
      if (!product.sourceRepoPath) {
        return NextResponse.json({ error: "Configure a local source checkout." }, { status: 422 });
      }
      const repo = resolveRepositoryPath(product.sourceRepoPath);
      const [{ stdout: refs }, { stdout: commits }] = await Promise.all([
        execFileAsync("git", ["-C", repo, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/tags"], { timeout: 15_000, maxBuffer: 1_000_000 }),
        execFileAsync("git", ["-C", repo, "log", "-10", "--format=%h%x09%s"], { timeout: 15_000, maxBuffer: 1_000_000 }),
      ]);
      return NextResponse.json({
        refs: refs.split("\n").filter(Boolean),
        commits: commits.split("\n").filter(Boolean).map((line) => {
          const [revision, ...subject] = line.split("\t");
          return { revision, subject: subject.join("\t") };
        }),
      });
    }
    if (!product.sourceRepoUrl) return NextResponse.json({ error: "Configure a source GitHub URL." }, { status: 422 });
    const { owner, name, api } = githubRepository(product.sourceRepoUrl);
    const root = `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const [branches, tags, commits] = await Promise.all([
      githubList<{ name: string }[]>(`${root}/branches?per_page=100`),
      githubList<{ name: string }[]>(`${root}/tags?per_page=100`),
      githubList<{ sha: string; commit: { message: string } }[]>(`${root}/commits?per_page=10`),
    ]);
    return NextResponse.json({
      refs: [...branches.map((item) => item.name), ...tags.map((item) => item.name)],
      commits: commits.map((item) => ({ revision: item.sha, subject: item.commit.message.split("\n")[0] })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read repository revisions." }, { status: 422 });
  }
}
