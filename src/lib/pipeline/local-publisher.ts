import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface LocalFileUpdate {
  path: string;
  beforeContent: string;
  afterContent: string;
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function publishLocalFiles(input: {
  repoPath: string;
  docsRoot: string;
  files: LocalFileUpdate[];
}): Promise<{ rollback: () => Promise<void>; commit: () => Promise<void> }> {
  if (!isAbsolute(input.repoPath)) throw new Error("Local documentation repository path must be absolute.");
  const repository = await realpath(input.repoPath);
  const root = resolve(repository, input.docsRoot || ".");
  if (!isWithin(repository, root)) throw new Error("Documentation root must remain inside the configured repository.");
  const realRoot = await realpath(/*turbopackIgnore: true*/ root);
  if (!isWithin(repository, realRoot)) throw new Error("Documentation root resolves outside the configured repository.");

  const staged: { target: string; temporary: string; backup: string; hadOriginal: boolean }[] = [];
  try {
    for (const file of input.files) {
      if (
        isAbsolute(file.path) ||
        file.path.includes("\\") ||
        file.path.split("/").includes("..")
      ) {
        throw new Error(`Unsafe documentation path: ${file.path}`);
      }
      const target = resolve(repository, file.path);
      if (!isWithin(realRoot, target)) throw new Error(`Documentation path is outside docs root: ${file.path}`);
      const parent = await realpath(dirname(target));
      if (!isWithin(realRoot, parent)) throw new Error(`Documentation path resolves outside docs root: ${file.path}`);
      const current = await readFile(target, "utf8");
      if (current.replace(/\r\n/g, "\n") !== file.beforeContent.replace(/\r\n/g, "\n")) {
        throw new Error(`Documentation file changed since review: ${file.path}`);
      }
      const temporary = `${target}.docline-${randomUUID()}.tmp`;
      const backup = `${target}.docline-${randomUUID()}.bak`;
      const handle = await open(temporary, "wx", 0o600);
      staged.push({ target, temporary, backup, hadOriginal: true });
      try {
        await handle.writeFile(file.afterContent, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    for (const file of staged) await rm(file.temporary, { force: true });
    throw error;
  }

  const installed: typeof staged = [];
  try {
    for (const file of staged) {
      await rename(file.target, file.backup);
      try {
        await rename(file.temporary, file.target);
      } catch (error) {
        await rename(file.backup, file.target);
        throw error;
      }
      installed.push(file);
    }
  } catch (error) {
    for (const file of installed.reverse()) {
      await rm(file.target, { force: true });
      await rename(file.backup, file.target);
    }
    for (const file of staged) await rm(file.temporary, { force: true });
    throw error;
  }

  return {
    rollback: async () => {
      for (const file of [...installed].reverse()) {
        await rm(file.target, { force: true });
        if (file.hadOriginal) await rename(file.backup, file.target);
      }
      for (const file of staged) await rm(file.temporary, { force: true });
    },
    commit: async () => {
      for (const file of staged) await rm(file.backup);
      for (const file of staged) await rm(file.temporary, { force: true });
    },
  };
}
