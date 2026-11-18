import { db } from "@/db";
import { users } from "@/db/schema";

const globalBootstrap = globalThis as typeof globalThis & {
  __doclineWorkspaceBootstrap?: Promise<void>;
};

async function bootstrapWorkspace(): Promise<void> {
  if (process.env.NODE_ENV === "production" && process.env.DOCLINE_DEMO_MODE !== "1") {
    return;
  }

  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length > 0) return;

  await db.insert(users).values([
    { id: "u-writer", name: "Writer", email: "writer@localhost", role: "WRITER", hue: 265 },
    { id: "u-reviewer", name: "Reviewer", email: "reviewer@localhost", role: "REVIEWER", hue: 210 },
    { id: "u-approver", name: "Approver", email: "approver@localhost", role: "APPROVER", hue: 145 },
    { id: "u-system", name: "Pipeline", email: "system@localhost", role: "SYSTEM", hue: 160 },
  ]).onConflictDoNothing();
}

export function ensureWorkspaceBootstrap(): Promise<void> {
  globalBootstrap.__doclineWorkspaceBootstrap ??= bootstrapWorkspace().catch((error) => {
    console.error("Docline workspace bootstrap failed:", error);
    globalBootstrap.__doclineWorkspaceBootstrap = undefined;
    throw error;
  });
  return globalBootstrap.__doclineWorkspaceBootstrap;
}
