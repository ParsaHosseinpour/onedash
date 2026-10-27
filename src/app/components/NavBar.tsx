"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

/**
 * Marketing navigation.
 *
 * Auth state is read from the same cookie-based Supabase session the server
 * uses. `getUser()` validates with the Auth server rather than trusting a
 * cached JWT. If Supabase is not configured, the page still renders and the
 * navigation stays in its logged-out state.
 */
export default function NavBar() {
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "Supabase is not configured; the navigation will show the logged-out state."
        );
      }
      return;
    }

    let active = true;
    let subscription: { unsubscribe: () => void } | undefined;

    try {
      const supabase = getSupabaseBrowserClient();

      supabase.auth
        .getUser()
        .then(({ data }) => {
          if (active) {
            setLoggedIn(Boolean(data.user));
          }
        })
        .catch(() => {
          if (active) {
            setLoggedIn(false);
          }
        });

      const { data } = supabase.auth.onAuthStateChange(
        (_event, session) => {
          if (active) {
            setLoggedIn(Boolean(session));
          }
        }
      );

      subscription = data.subscription;
    } catch (error) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("Could not initialize the Supabase browser client.", error);
      }
    }

    return () => {
      active = false;
      subscription?.unsubscribe();
    };
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
