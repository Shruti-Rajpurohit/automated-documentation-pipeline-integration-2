import { NextResponse } from "next/server";
import { decide } from "@/lib/actions";
import { resolveRequestActor } from "@/lib/identity";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const actor = await resolveRequestActor(req);
    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "Authentication required. Choose an identity in the sidebar." },
        { status: 401 }
      );
    }
    const body = (await req.json()) as {
      action?: string;
      reason?: string;
    };
    if (!body.action || !["approve", "reject", "publish"].includes(body.action)) {
      return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
    }
    const result = await decide({
      sessionId: id,
      action: body.action as "approve" | "reject" | "publish",
      actor,
      reason: body.reason,
    });
    if (!result.ok) {
      const status = result.error?.includes("changed since") ? 409 : 400;
      return NextResponse.json(result, { status });
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Action failed" },
      { status: 500 }
    );
  }
}
