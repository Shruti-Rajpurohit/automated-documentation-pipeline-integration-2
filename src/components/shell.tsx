"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpen,
  History,
  LayoutDashboard,
  Rocket,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { cx } from "@/lib/time";

export type Role = "WRITER" | "REVIEWER" | "APPROVER";

export interface IdentityUser {
  id: string;
  name: string;
  role: string;
}

const ROLE_ORDER: Role[] = ["WRITER", "REVIEWER", "APPROVER"];
const ROLE_LABEL: Record<Role, string> = {
  WRITER: "Writer",
  REVIEWER: "Reviewer",
  APPROVER: "Approver",
};

const RoleContext = createContext<{
  /** Signed-in workspace identity (server-issued cookie); null when signed out. */
  actor: IdentityUser | null;
  role: Role | null;
  demoUsers: IdentityUser[];
  mode: "demo" | "sso";
  loading: boolean;
  signIn: (userId: string) => Promise<void>;
  signOut: () => Promise<void>;
}>({
  actor: null,
  role: null,
  demoUsers: [],
  mode: "demo",
  loading: true,
  signIn: async () => {},
  signOut: async () => {},
});

export const useRole = () => useContext(RoleContext);

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/runs/new", label: "New run", icon: Rocket },
  { href: "/docs", label: "Documentation", icon: BookOpen },
  { href: "/activity", label: "Activity", icon: History },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
        <rect x="1" y="1" width="24" height="24" rx="6" fill="#0d0f14" stroke="rgba(255,255,255,0.14)" />
        <path d="M8 8.5h6.2L18 12.3v.2" stroke="#5eeaa0" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        <path d="M18 12.5v3.2c0 1-.8 1.8-1.8 1.8H8" stroke="rgba(255,255,255,0.45)" strokeWidth="1.4" strokeLinecap="round" fill="none" />
        <circle cx="8" cy="17.5" r="1.4" fill="#5eeaa0" />
        <circle cx="8" cy="8.5" r="1.4" fill="#e9ebf1" />
      </svg>
      <div className="leading-tight">
        <div className="text-[13.5px] font-semibold tracking-tight text-snow">Docline</div>
        <div className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-fog">
          doc pipeline
        </div>
      </div>
    </div>
  );
}

export function Shell({
  children,
  pendingCount,
}: {
  children: ReactNode;
  pendingCount: number;
}) {
  const pathname = usePathname();
  const [actor, setActor] = useState<IdentityUser | null>(null);
  const [demoUsers, setDemoUsers] = useState<IdentityUser[]>([]);
  const [mode, setMode] = useState<"demo" | "sso">("demo");
  const [loading, setLoading] = useState(true);

  // Identity comes from the server-issued HttpOnly session cookie — the
  // browser cannot mint or escalate a role; it can only ask to be signed in
  // as an existing workspace user.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/identity")
      .then((r) => r.json())
      .then((data: { actor: IdentityUser | null; mode: "demo" | "sso"; demoUsers?: IdentityUser[] }) => {
        if (cancelled) return;
        setActor(data.actor);
        setMode(data.mode ?? "demo");
        setDemoUsers(data.demoUsers ?? []);
        setLoading(false);
      })
      .catch(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = async (userId: string) => {
    const res = await fetch("/api/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (res.ok) {
      const data = (await res.json()) as { actor: IdentityUser };
      setActor(data.actor);
    }
  };

  const signOut = async () => {
    await fetch("/api/identity", { method: "DELETE" });
    setActor(null);
  };

  const role = (actor?.role as Role | null) ?? null;

  return (
    <RoleContext.Provider value={{ actor, role, demoUsers, mode, loading, signIn, signOut }}>
      <div className="min-h-screen bg-ink">
        <aside className="fixed inset-y-0 left-0 z-30 flex w-[228px] flex-col border-r border-hairline bg-panel">
          <div className="px-4 pt-5 pb-4 border-b border-hairline">
            <Logo />
          </div>
          <nav className="flex-1 space-y-0.5 px-2.5 py-3">
            {NAV.map((item) => {
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              const showBadge = item.href === "/" && pendingCount > 0;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cx(
                    "group flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition-colors",
                    active
                      ? "bg-white/[0.06] text-snow"
                      : "text-fog hover:bg-white/[0.03] hover:text-snow/90"
                  )}
                >
                  <item.icon
                    size={15}
                    strokeWidth={1.8}
                    className={active ? "text-mint" : "text-fog group-hover:text-snow/80"}
                  />
                  <span className="flex-1">{item.label}</span>
                  {showBadge && (
                    <span className="rounded-full bg-amberish/15 px-1.5 py-px font-mono text-[10px] text-amberish">
                      {pendingCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          <div className="border-t border-hairline p-3">
            <div className="mb-2 flex items-center gap-1.5 px-1">
              <ShieldCheck size={12} className="text-fog" />
              <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-fog">
                {mode === "sso" ? "SSO identity" : "Sign in as"}
              </span>
            </div>
            <div className="rounded-xl border border-hairline bg-panel-2 p-1">
              {ROLE_ORDER.map((r) => {
                const candidates = demoUsers.filter((u) => u.role === r);
                const user =
                  candidates.find((u) => u.id === actor?.id) ?? candidates[0] ?? null;
                const active = actor?.role === r;
                return (
                  <button
                    key={r}
                    disabled={mode === "sso" || loading || !user}
                    onClick={() => user && signIn(user.id)}
                    className={cx(
                      "flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors",
                      active
                        ? "bg-white/[0.07] text-snow"
                        : "text-fog hover:text-snow/80",
                      (mode === "sso" || !user) && "cursor-not-allowed opacity-60"
                    )}
                  >
                    <span>{ROLE_LABEL[r]}</span>
                    <span className="font-mono text-[10px] text-fog">
                      {user ? user.name.split(" ")[0] : "—"}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-3 px-1 pb-1">
              {actor ? (
                <>
                  <div className="text-[12px] font-medium text-snow/90">{actor.name}</div>
                  <div className="font-mono text-[10px] text-fog">
                    {actor.role.toLowerCase()} · signed session
                  </div>
                </>
              ) : (
                <>
                  <div className="text-[12px] font-medium text-snow/90">Not signed in</div>
                  <div className="font-mono text-[10px] text-fog">
                    {loading ? "checking session…" : "pick an identity above"}
                  </div>
                </>
              )}
            </div>
          </div>
        </aside>

        <div className="relative pl-[228px]">
          <div className="dotgrid pointer-events-none absolute inset-x-0 top-0 h-[420px]" />
          <div className="glow-mint pointer-events-none absolute inset-x-0 top-0 h-[340px]" />
          <main className="relative mx-auto min-h-screen max-w-[1180px] px-8 pb-24 pt-8">
            {children}
          </main>
        </div>
      </div>
    </RoleContext.Provider>
  );
}
