import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import { cookies, headers } from "next/headers";
import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { ensureWorkspaceBootstrap } from "@/lib/seed";
import {
  decodeSessionCookie,
  isSsoMode,
  resolveRequestActor,
  SESSION_COOKIE,
} from "@/lib/identity";
import { Shell } from "@/components/shell";
import { AuthWall } from "@/components/auth-wall";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jbmono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jbmono" });

export const metadata: Metadata = {
  title: "Docline — Documentation that ships itself, with your sign-off",
  description:
    "Docline watches product releases, drafts documentation updates in your house voice, and ships them only after human approval.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  await ensureWorkspaceBootstrap();
  const [pending] = await db
    .select({ n: count() })
    .from(sessions)
    .where(eq(sessions.status, "AWAITING_REVIEW"));

  // Pages carry source diffs, drafts, and the audit trail: everything sits
  // behind an authenticated session (demo cookie picker or verified SSO).
  let authed = false;
  if (isSsoMode()) {
    const requestHeaders = await headers();
    authed = Boolean(
      await resolveRequestActor(new Request("http://docline.internal", { headers: requestHeaders }))
    );
  } else {
    try {
      const jar = await cookies();
      const raw = jar.get(SESSION_COOKIE)?.value;
      const userId = raw ? decodeSessionCookie(decodeURIComponent(raw)) : null;
      if (userId) {
        const rows = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId));
        authed = Boolean(rows[0]);
      }
    } catch {
      authed = false;
    }
  }

  return (
    <html lang="en" className={`${inter.variable} ${jbmono.variable}`}>
      <body className="antialiased">
        <Shell pendingCount={pending?.n ?? 0}>{authed ? children : <AuthWall />}</Shell>
      </body>
    </html>
  );
}
