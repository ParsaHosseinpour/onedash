"use client";

import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase-client";

/**
 * WaitlistForm — the real, working email capture form.
 *
 * Replaces the v0.1 placeholder. When someone submits their email:
 *   1. We validate it's actually an email
 *   2. We insert it into the `waitlist` Supabase table
 *   3. We show a success state ("You're #N on the list!")
 *   4. If anything fails, we show a friendly error
 *
 * This is a "client component" (note "use client" at top) because it
 * has interactive state — buttons the user clicks, loading spinners, etc.
 * Static pages don't need JavaScript; interactive ones do.
 */
type Status = "idle" | "loading" | "success" | "error";

export default function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [position, setPosition] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); // stop the page from reloading

    setStatus("loading");
    setErrorMessage("");

    // Insert the email into Supabase.
    // RLS only allows INSERTs from anonymous users — they can't read or delete.
    const { error } = await supabase.from("waitlist").insert({ email });

    if (error) {
      // Supabase returns code 23505 for "unique constraint violation"
      // = that email is already on the waitlist. Treat it kindly.
      if (error.code === "23505") {
        setStatus("error");
        setErrorMessage("You're already on the list! 🎉");
      } else {
        setStatus("error");
        setErrorMessage("Something went wrong. Please try again.");
      }
      return;
    }

    // Fetch the current waitlist count using the safe SQL function.
    // RLS blocks direct SELECT on the table, but waitlist_count()
    // runs as the table owner (SECURITY DEFINER) so it can count rows.
    const { data } = await supabase.rpc("waitlist_count");

    setPosition(data ?? null);
    setStatus("success");
  }

  // -------- SUCCESS STATE --------
  if (status === "success") {
    return (
      <div className="mt-8 rounded-xl border border-[color:var(--accent)] bg-[color:var(--background-elevated)] p-6 text-center">
        <div className="text-4xl mb-2">🎉</div>
        <p className="font-semibold text-lg">You&apos;re on the list!</p>
        {position && (
          <p className="mt-1 text-[color:var(--foreground-muted)]">
            You&apos;re #{position} in line. We&apos;ll email you when
            it&apos;s your turn.
          </p>
        )}
      </div>
    );
  }

  // -------- FORM STATE (idle / loading / error) --------
  return (
    <div className="mt-8">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col sm:flex-row gap-3 justify-center"
      >
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={status === "loading"}
          placeholder="you@example.com"
          className="rounded-lg border border-[color:var(--border)] bg-[color:var(--background-elevated)] px-4 py-3 text-foreground placeholder:text-[color:var(--foreground-muted)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)] flex-1 max-w-sm disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={status === "loading"}
          className="rounded-lg bg-[color:var(--accent)] px-6 py-3 font-semibold text-[#0a0e1a] hover:bg-[color:var(--accent-dim)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {status === "loading" ? "Saving…" : "Reserve my spot"}
        </button>
      </form>

      {status === "error" && (
        <p className="mt-3 text-sm text-[color:var(--danger)]">{errorMessage}</p>
      )}
    </div>
  );
}
