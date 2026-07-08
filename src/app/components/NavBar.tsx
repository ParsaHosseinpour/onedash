"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase-client";

/**
 * NavBar — the marketing site navigation bar.
 *
 * Smart feature: it shows DIFFERENT buttons based on login state.
 *   - Logged out: "Log in" + "Join waitlist"
 *   - Logged in:  "Dashboard" + "Log out"
 *
 * Because auth state lives in the browser (cookie + Supabase session),
 * we use a client component + useEffect + onAuthStateChange to react
 * to login/logout in real time.
 */
export default function NavBar() {
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    // Check current auth state on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      setLoggedIn(!!session);
    });

    // Subscribe to future auth changes (login, logout, token refresh)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setLoggedIn(!!session);
    });

    // Cleanup subscription when component unmounts
    return () => subscription.unsubscribe();
  }, []);

  return (
    <nav className="border-b border-[color:var(--border)] backdrop-blur-sm">
      <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[color:var(--accent)] text-[#0a0e1a] font-bold text-sm">
            1
          </div>
          <span className="font-semibold tracking-tight">OneDash</span>
        </Link>

        <div className="flex items-center gap-4 text-sm">
          <Link
            href="#features"
            className="text-[color:var(--foreground-muted)] hover:text-[color:var(--foreground)] transition-colors hidden sm:inline"
          >
            Features
          </Link>
          <Link
            href="#pricing"
            className="text-[color:var(--foreground-muted)] hover:text-[color:var(--foreground)] transition-colors hidden sm:inline"
          >
            Pricing
          </Link>

          {loggedIn ? (
            <Link
              href="/dashboard"
              className="rounded-lg bg-[color:var(--accent)] px-4 py-2 font-medium text-[#0a0e1a] hover:bg-[color:var(--accent-dim)] transition-colors"
            >
              Dashboard →
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="text-[color:var(--foreground-muted)] hover:text-[color:var(--foreground)] transition-colors"
              >
                Log in
              </Link>
              <Link
                href="#waitlist"
                className="rounded-lg bg-[color:var(--accent)] px-4 py-2 font-medium text-[#0a0e1a] hover:bg-[color:var(--accent-dim)] transition-colors"
              >
                Join waitlist
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
