"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase-client";

/**
 * LogoutButton — signs the user out.
 *
 * Calls supabase.auth.signOut() which:
 *   1. Deletes the auth cookie (locally + tells Supabase to revoke the session)
 *   2. Returns to a logged-out state
 *
 * After sign out, we hard-refresh to "/" so the server re-renders without
 * the auth cookie, showing the public landing page.
 */
export default function LogoutButton() {
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    await supabase.auth.signOut();
    // Hard refresh so server components re-evaluate auth state.
    window.location.href = "/";
  }

  return (
    <button
      onClick={handleLogout}
      disabled={loading}
      className="text-sm rounded-lg border border-[color:var(--border)] px-4 py-2 hover:bg-[color:var(--background-elevated)] transition-colors disabled:opacity-50"
    >
      {loading ? "Logging out…" : "Log out"}
    </button>
  );
}
