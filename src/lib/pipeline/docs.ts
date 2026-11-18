import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".adoc"]);

export type DocumentKind = "api" | "developer" | "user" | "blog" | "other";

export function classifyDocumentKind(path: string): DocumentKind {
  const value = path.toLowerCase();
  if (/(^|\/)(api|reference|openapi)(\/|[-_.]|$)/.test(value)) return "api";
  if (/(^|\/)(developer|setup|sdk|contributing)(\/|[-_.]|$)/.test(value)) return "developer";
  if (/(^|\/)(user|guide|tutorial)(\/|[-_.]|$)/.test(value)) return "user";
  if (/(^|\/)(blog|changelog|release|releases)(\/|[-_.]|$)/.test(value)) return "blog";
  return "other";
}

export function isDocumentationFile(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return DOC_EXTENSIONS.has(extension);
}

export function documentTitle(path: string, content: string): string {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  return heading || basename(path).replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
}

export function resolveRepositoryPath(path: string): string {
  if (!isAbsolute(path)) throw new Error("Repository paths must be absolute.");
  const candidate = resolve(path);
  const configuredRoots = (process.env.REPOSITORY_ROOTS ?? `${process.cwd()}/repos`)
    .split(",")
    .map((root) => resolve(root.trim()))
    .filter(Boolean);
  if (!configuredRoots.some((root) => {
    const subpath = relative(root, candidate);
    return subpath === "" || (!subpath.startsWith(`..${sep}`) && subpath !== ".." && !isAbsolute(subpath));
  })) {
    throw new Error("Repository path must be inside one of the configured REPOSITORY_ROOTS.");
  }
  return candidate;
}

export function normalizeDocsRoot(root: string): string {
  const normalized = root.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (normalized.split("/").includes("..")) throw new Error("Documentation root cannot contain '..'.");
  return normalized === "." ? "" : normalized;
}

