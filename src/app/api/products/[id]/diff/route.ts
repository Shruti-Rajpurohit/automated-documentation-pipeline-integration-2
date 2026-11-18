import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { products } from "@/db/schema";
import { resolveRequestActor } from "@/lib/identity";
import { resolveRepositoryPath } from "@/lib/pipeline/docs";
import { readRequestBodyText } from "@/lib/request-body";

export const dynamic = "force-dynamic";
const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 250_000;

function validRevision(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.startsWith("-") &&
    /^[A-Za-z0-9._/@^~+-]+$/.test(value);
}

function githubRepository(value: string) {
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(value);
  const url = new URL(ssh ? `https://${ssh[1]}/${ssh[2]}` : value.includes("://") ? value : `https://${value}`);
  const parts = url.pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("Source GitHub URL must include an owner and repository.");
  if (!process.env.GITHUB_API_BASE && url.hostname !== "github.com") throw new Error("Set GITHUB_API_BASE for GitHub Enterprise.");
  return {
    owner: parts.at(-2)!,
    name: parts.at(-1)!,
    api: process.env.GITHUB_API_BASE?.replace(/\/+$/, "") || "https://api.github.com",
  };
}

async function githubDiff(productUrl: string, base: string, head: string): Promise<string> {
  const { owner, name, api } = githubRepository(productUrl);
  const response = await fetch(
    `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    {
      headers: {
        accept: "application/vnd.github.diff",
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(20_000),
    }
  );
  if (!response.ok) throw new Error(`GitHub compare failed (${response.status}).`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub returned an empty diff.");
  const decoder = new TextDecoder();
  let diff = "";
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DIFF_BYTES) {
      await reader.cancel();
      throw new Error(`Diff exceeds the ${MAX_DIFF_BYTES}-byte limit.`);
    }
    diff += decoder.decode(value, { stream: true });
  }
  diff += decoder.decode();
  return diff;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await resolveRequestActor(req))) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await params;
  const [product] = await db.select().from(products).where(eq(products.id, id));
  if (!product) return NextResponse.json({ error: "Product not found." }, { status: 404 });
  const rawBody = await readRequestBodyText(req, 8_000);
  if (rawBody === null) {
    return NextResponse.json({ error: "Request body exceeds 8000 bytes." }, { status: 413 });
  }
  let body: { baseRevision?: unknown; headRevision?: unknown; source?: unknown };
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
    }
    body = parsed as typeof body;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!validRevision(body.baseRevision) || !validRevision(body.headRevision)) {
    return NextResponse.json({ error: "Provide valid baseRevision and headRevision values." }, { status: 400 });
  }
  if (body.source !== undefined && body.source !== "local" && body.source !== "github") {
    return NextResponse.json({ error: "source must be local or github." }, { status: 400 });
  }
  const source = body.source === "local" ? "local" : "github";
  try {
    let diff: string;
    if (source === "local") {
      if (!product.sourceRepoPath) throw new Error("Configure sourceRepoPath to compare local Git revisions.");
      const repo = resolveRepositoryPath(product.sourceRepoPath);
      const result = await execFileAsync("git", ["-C", repo, "diff", "--no-ext-diff", "--unified=3", body.baseRevision, body.headRevision, "--"], {
        timeout: 30_000,
        maxBuffer: MAX_DIFF_BYTES + 1,
        encoding: "buffer",
      });
      if (result.stdout.byteLength > MAX_DIFF_BYTES) throw new Error(`Diff exceeds the ${MAX_DIFF_BYTES}-byte limit.`);
      diff = result.stdout.toString("utf8");
    } else {
      if (!product.sourceRepoUrl) throw new Error("Configure sourceRepoUrl to compare GitHub revisions.");
      diff = await githubDiff(product.sourceRepoUrl, body.baseRevision, body.headRevision);
    }
    return NextResponse.json({ diff, bytes: Buffer.byteLength(diff, "utf8") });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not resolve diff." }, { status: 422 });
  }
}
