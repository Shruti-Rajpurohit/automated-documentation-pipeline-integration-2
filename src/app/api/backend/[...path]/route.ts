import { NextResponse } from "next/server";
import { resolveMachineActor, resolveRequestActor } from "@/lib/identity";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Trusted-proxy bridge to the Python pipeline service (backend/).
 *
 * The FastAPI service is designed to sit behind a trusted proxy that strips
 * client-supplied identity and injects its own (see backend/README.md). This
 * route IS that proxy for the unified product:
 *
 *   browser / CI --> Next.js ----> FastAPI
 *                    (this route)  X-Authenticated-User-ID
 *                                  X-Auth-Proxy-Secret  (server-only)
 *
 * The secret never reaches the client bundle; it is read from the server
 * environment at request time. Callers must hold a Docline session cookie
 * (or SSO proxy identity in sso mode): the backend user id is derived from
 * the AUTHENTICATED user's database role via BACKEND_USER_MAP. There is no
 * client-selectable role and no default.
 *
 * Env:
 *   PIPELINE_BACKEND_URL  e.g. http://127.0.0.1:8000 - unset => 503 "not linked"
 *   AUTH_PROXY_SECRET     shared with the FastAPI process (required)
 *   BACKEND_USER_MAP      JSON, default {"WRITER":1,"REVIEWER":2,"APPROVER":3}
 */

const ALLOWED_PREFIXES = new Set(["sessions", "jobs", "healthz"]);
const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
]);

type Role = "WRITER" | "REVIEWER" | "APPROVER";

function backendUserId(role: Role): string {
  const fallback: Record<Role, number> = { WRITER: 1, REVIEWER: 2, APPROVER: 3 };
  try {
    const raw = process.env.BACKEND_USER_MAP;
    if (raw) {
      const map = JSON.parse(raw) as Record<string, unknown>;
      const v = map[role];
      if (typeof v === "number" && Number.isInteger(v) && v > 0) return String(v);
    }
  } catch {
    // fall through to defaults
  }
  return String(fallback[role]);
}

type ActorWithEmail = { id: string; name: string; role: string; email?: string };

async function forward(req: Request, segments: string[]) {
  const base = process.env.PIPELINE_BACKEND_URL?.replace(/\/+$/, "");
  if (!base) {
    return NextResponse.json(
      {
        error:
          "Python backend is not linked. Set PIPELINE_BACKEND_URL (e.g. http://127.0.0.1:8000) and AUTH_PROXY_SECRET on the Next.js server.",
      },
      { status: 503 }
    );
  }
  const secret = process.env.AUTH_PROXY_SECRET;
  if (
    !secret ||
    (process.env.NODE_ENV === "production" &&
      (secret.length < 32 || secret.toLowerCase().includes("replace-with")))
  ) {
    return NextResponse.json(
      { error: "AUTH_PROXY_SECRET must be a non-placeholder secret of at least 32 characters on the Next.js server." },
      { status: 503 }
    );
  }

  const prefix = segments[0] ?? "";
  if (!ALLOWED_PREFIXES.has(prefix)) {
    return NextResponse.json(
      { error: `Bridge allows: ${[...ALLOWED_PREFIXES].join(", ")}.` },
      { status: 404 }
    );
  }

  const actor = (await resolveMachineActor(req)) ?? (await resolveRequestActor(req));
  if (!actor) {
    return NextResponse.json(
      { error: "Authentication required. Sign in; the bridge derives backend identity from your session." },
      { status: 401 }
    );
  }
  // Only workspace member roles cross the bridge. SYSTEM and anything
  // unrecognized are refused rather than quietly promoted to Reviewer.
  if (actor.role !== "WRITER" && actor.role !== "REVIEWER" && actor.role !== "APPROVER") {
    return NextResponse.json(
      { error: `Role ${actor.role} may not use the pipeline bridge.` },
      { status: 403 }
    );
  }
  const role: Role = actor.role;
  const actorEmailRef = { current: (actor as ActorWithEmail).email ?? `${role.toLowerCase()}@example.com` };

  const url = new URL(req.url);
  const target = `${base}/${segments.join("/")}${url.search}`;

  const headers: Record<string, string> = {
    "X-Authenticated-User-ID": backendUserId(role),
    "X-Authenticated-User-Email": actorEmailRef.current,
    "X-Auth-Proxy-Secret": secret,
  };
  for (const [k, v] of req.headers) {
    const key = k.toLowerCase();
    if (!HOP_BY_HOP.has(key) && !key.startsWith("x-docline-") && key !== "cookie") {
      if (key === "content-type" || key === "accept") headers[key] = v;
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 285_000);
  try {
    const hasBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? await req.text() : undefined,
      signal: ctrl.signal,
      // @ts-expect-error Node fetch requires duplex for streamed bodies
      duplex: "half",
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return NextResponse.json(
      {
        error: aborted
          ? `Backend at ${base} did not answer within its processing window. The run may still complete server-side — list sessions to check.`
          : `Backend at ${base} is unreachable.${e instanceof Error ? ` (${e.message})` : ""}`,
      },
      { status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> }
) {
  return forward(req, (await ctx.params).path);
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> }
) {
  return forward(req, (await ctx.params).path);
}
