"use client";

import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase-client";

/**
 * SignupForm — interactive client component.
 *
 * Calls supabase.auth.signUp(), which:
 *   1. Creates a user account in Supabase Auth
 *   2. Sends a confirmation email to the user
 *   3. The user must click the email link to verify their email
 *   4. After clicking, they're redirected to /auth/callback → /dashboard
 *
 * Note: the user is NOT logged in immediately after signup. They must
 * confirm their email first. This prevents spam/fake signups.
 */
export default function SignupForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<
    "idle" | "loading" | "error" | "success"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("loading");
    setErrorMessage("");

    // Basic password length check (Supabase default minimum is 6)
    if (password.length < 6) {
      setStatus("error");
      setErrorMessage("Password must be at least 6 characters.");
      return;
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Where to send the user after they click the email confirmation link.
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setStatus("error");
      setErrorMessage(error.message);
      return;
    }

    // Success — show the "check your email" message.
    setStatus("success");
  }

  // -------- SUCCESS STATE --------
  if (status === "success") {
    return (
      <div className="rounded-xl border border-[color:var(--accent)] bg-[color:var(--background-elevated)] p-6 text-center">
        <div className="text-4xl mb-2">📬</div>
        <p className="font-semibold text-lg">Check your email</p>
        <p className="mt-2 text-sm text-[color:var(--foreground-muted)]">
          We sent a confirmation link to{" "}
          <span className="text-foreground font-medium">{email}</span>.
          Click it to activate your account.
        </p>
        <p className="mt-3 text-xs text-[color:var(--foreground-muted)]">
          (Check your spam folder if you don&apos;t see it within a minute.)
        </p>
      </div>
    );
  }

  // -------- FORM STATE --------
  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium mb-1.5">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={status === "loading"}
          placeholder="you@example.com"
          className="w-full rounded-lg border border-[color:var(--border)] bg-[color:var(--background-elevated)] px-4 py-2.5 text-foreground placeholder:text-[color:var(--foreground-muted)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)] disabled:opacity-50"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium mb-1.5">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={status === "loading"}
          placeholder="At least 6 characters"
          className="w-full rounded-lg border border-[color:var(--border)] bg-[color:var(--background-elevated)] px-4 py-2.5 text-foreground placeholder:text-[color:var(--foreground-muted)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)] disabled:opacity-50"
        />
      </div>

      {status === "error" && (
        <p className="text-sm text-[color:var(--danger)]">{errorMessage}</p>
      )}

      <button
        type="submit"
        disabled={status === "loading"}
        className="w-full rounded-lg bg-[color:var(--accent)] px-4 py-2.5 font-semibold text-[#0a0e1a] hover:bg-[color:var(--accent-dim)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {status === "loading" ? "Creating account…" : "Create free account"}
      </button>
    </form>
  );
}
