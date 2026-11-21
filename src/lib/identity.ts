import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

/**
 * Server-side identity. Two modes:
 *
 * - demo (default): the sidebar picker calls POST /api/identity with a user
 *   id; the server looks the user up (role comes from the DATABASE, never
 *   from the request) and issues an HMAC-signed HttpOnly session cookie.
 *   Every mutating route resolves the actor from that cookie. A caller
 *   cannot escalate by adding a field to a request — there is no field.
 *
 * - sso (DOCLINE_AUTH_MODE=sso): identity arrives from the customer's SSO
 *   proxy as X-Authenticated-User (email) + X-Auth-Proxy-Secret, validated
 *   against SSO_PROXY_SECRET with a constant-time compare — the same trust
 *   model used for workspace role assignment. The demo picker is disabled.
 *
 * Unauthenticated calls to mutating routes get 401. Read routes stay open.
 */

export const SESSION_COOKIE = "docline_session";
const SESSION_TTL_MS = 12 * 3_600_000;

let warned = false;
function sessionSecret(): string {
  const fromEnv = process.env.DOCLINE_SESSION_SECRET;
  if (process.env.NODE_ENV === "production") {
    if (!fromEnv || fromEnv.length < 32 || fromEnv.toLowerCase().includes("replace-with")) {
      throw new Error("DOCLINE_SESSION_SECRET must be a non-placeholder secret of at least 32 characters in production.");
    }
  }
  if (fromEnv) return fromEnv;
  if (!warned) {
    warned = true;
    console.warn(
      "[docline] DOCLINE_SESSION_SECRET is not set — using an insecure built-in development secret. Set it before deploying."
    );
  }
  return "docline-insecure-dev-secret";
}

export function isSsoMode(): boolean {
  return process.env.DOCLINE_AUTH_MODE === "sso";
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("hex");
}

export function encodeSessionCookie(userId: string): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function decodeSessionCookie(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length < 3) return null;
  const sig = parts.pop()!;
  const exp = parts.pop()!;
  const userId = parts.join(".");
  const payload = `${userId}.${exp}`;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return null;
  return userId;
}

export interface Actor {
  id: string;
  name: string;
  role: string;
  email: string;
}

async function fetchUserBy(where: "id" | "email", value: string): Promise<Actor | null> {
  const rows = await db
    .select({ id: users.id, name: users.name, role: users.role, email: users.email })
    .from(users)
    .where(where === "id" ? eq(users.id, value) : eq(users.email, value));
  const u = rows[0];
  return u ? { id: u.id, name: u.name, role: u.role, email: u.email } : null;
}

/** Resolve the acting user for the request, or null. Never trusts the body. */
export async function resolveRequestActor(req: Request): Promise<Actor | null> {
  if (isSsoMode()) {
    const secret = process.env.SSO_PROXY_SECRET;
    const presented = req.headers.get("x-auth-proxy-secret");
    const email = req.headers.get("x-authenticated-user");
    if (!secret || !presented || !email) return null;
    if (
      process.env.NODE_ENV === "production" &&
      (secret.length < 32 || secret.toLowerCase().includes("replace-with"))
    ) {
      throw new Error("SSO_PROXY_SECRET must be a non-placeholder secret of at least 32 characters in production.");
    }
    const a = Buffer.from(presented);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return fetchUserBy("email", email.trim().toLowerCase());
  }
  const cookieHeader = req.headers.get("cookie") ?? "";
  const raw = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  let encoded: string | null = null;
  if (raw) {
    try {
      encoded = decodeURIComponent(raw.slice(SESSION_COOKIE.length + 1));
    } catch {
      encoded = null; // malformed cookie encoding -> treated as absent
    }
  }
  const userId = decodeSessionCookie(encoded);
  if (!userId) return null;
  return fetchUserBy("id", userId);
}

/**
 * Machine identity for CI/API callers: Authorization: Bearer PIPELINE_API_TOKEN
 * authenticates as the workspace bot (SYSTEM role: can create runs, never
 * approve). Configured by ops; compared in constant time.
 */
export async function resolveMachineActor(req: Request): Promise<Actor | null> {
  const token = process.env.PIPELINE_API_TOKEN;
  if (!token) return null;
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const presented = auth.slice(7).trim();
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const rows = await db
    .select({ id: users.id, name: users.name, role: users.role, email: users.email })
    .from(users)
    .where(eq(users.id, "u-bot"));
  return rows[0] ?? null;
}

export function sessionCookieHeader(userId: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(
    encodeSessionCookie(userId)
  )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
