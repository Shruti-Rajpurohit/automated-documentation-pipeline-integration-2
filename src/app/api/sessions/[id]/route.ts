import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditEvents, documentEdits, sessions } from "@/db/schema";
import { resolveRequestActor } from "@/lib/identity";

export const dynamic = "force-dynamic";

const DELETABLE_STATUSES = [
  "NEEDS_INVESTIGATION",
  "NO_UPDATE",
  "REJECTED",
  "AWAITING_REVIEW",
];

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await resolveRequestActor(req))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const { id } = await params;
  try {
    const deleted = await db.transaction(async (tx) => {
      const [session] = await tx
        .select({ id: sessions.id, status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, id))
        .for("update");
      if (!session) return { error: "Session not found.", status: 404 };
      if (!DELETABLE_STATUSES.includes(session.status)) {
        return {
          error: `Sessions with status ${session.status} cannot be deleted.`,
          status: 409,
        };
      }
      await tx.delete(documentEdits).where(eq(documentEdits.sessionId, id));
      await tx.delete(auditEvents).where(eq(auditEvents.sessionId, id));
      await tx.delete(sessions).where(eq(sessions.id, id));
      return { status: 204 };
    });
    if ("error" in deleted) {
      return NextResponse.json({ error: deleted.error }, { status: deleted.status });
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("[docline] session deletion failed", {
      sessionId: id,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ error: "Could not delete session." }, { status: 500 });
  }
}
