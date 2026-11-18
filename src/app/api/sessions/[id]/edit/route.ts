import { NextResponse } from "next/server";
import { editDraft } from "@/lib/actions";
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
      editId?: string;
      content?: string;
    };
    if (!body.editId || typeof body.content !== "string") {
      return NextResponse.json({ ok: false, error: "editId and content are required." }, { status: 400 });
    }
    if (body.content.length > 100_000) {
      return NextResponse.json({ ok: false, error: "Draft too large." }, { status: 413 });
    }
    const result = await editDraft({
      sessionId: id,
      editId: body.editId,
      content: body.content,
      actor,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Edit failed" },
      { status: 500 }
    );
  }
}
