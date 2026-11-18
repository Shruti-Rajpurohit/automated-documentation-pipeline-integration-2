import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  clearSessionCookieHeader,
  isSsoMode,
  resolveRequestActor,
  sessionCookieHeader,
} from "@/lib/identity";

export const dynamic = "force-dynamic";

/** GET: who am I? In demo mode also lists the workspace users you can assume. */
export async function GET(req: Request) {
  const actor = await resolveRequestActor(req);
  let demoUsers: { id: string; name: string; role: string }[] | undefined;
  const demoAllowed =
    !isSsoMode() &&
    (process.env.NODE_ENV !== "production" || process.env.DOCLINE_DEMO_MODE === "1");
  if (demoAllowed) {
    demoUsers = await db
      .select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .orderBy(asc(users.name));
  }
  return NextResponse.json({ actor, mode: isSsoMode() ? "sso" : "demo", demoUsers });
}

/** POST { userId }: sign in as an existing workspace user (demo mode only).
 *  The role is read from the users table — the request cannot pick one. */
export async function POST(req: Request) {
  if (isSsoMode()) {
    return NextResponse.json(
      { error: "Identity is managed by your SSO proxy in sso mode." },
      { status: 403 }
    );
  }
  if (process.env.NODE_ENV === "production" && process.env.DOCLINE_DEMO_MODE !== "1") {
    return NextResponse.json(
      { error: "The demo identity picker is disabled. Configure DOCLINE_AUTH_MODE=sso, or set DOCLINE_DEMO_MODE=1 only for evaluation deployments." },
      { status: 403 }
    );
  }
  let userId = "";
  try {
    const body = (await req.json()) as { userId?: unknown };
    if (typeof body.userId === "string") userId = body.userId;
  } catch {
    /* fall through */
  }
  const rows = await db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users);
  const user = rows.find((u) => u.id === userId);
  if (!user) {
    return NextResponse.json({ error: "Unknown user." }, { status: 401 });
  }
  return NextResponse.json(
    { actor: user },
    { headers: { "set-cookie": sessionCookieHeader(user.id) } }
  );
}

export async function DELETE() {
  return NextResponse.json(
    { ok: true },
    { headers: { "set-cookie": clearSessionCookieHeader() } }
  );
}
