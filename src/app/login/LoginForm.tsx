"use client";

import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase-client";

/**
 * LoginForm — interactive client component.
 *
 * Handles the actual login: takes email/password, calls Supabase Auth,
 * shows loading + error states.
 *
 * On success: redirects to /dashboard (server will detect the new session).
 */
export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("loading");
    setErrorMessage("");

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setStatus("error");
      setErrorMessage(
        error.message === "Invalid login credentials"
          ? "Wrong email or password. Try again."
          : error.message
      );
      return;
    }

    // Success — hard refresh so the server picks up the new auth cookie.
    window.location.href = "/dashboard";
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="email"
          className="block text-sm font-medium mb-1.5"
        >
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
        <label
          htmlFor="password"
          className="block text-sm font-medium mb-1.5"
        >
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={status === "loading"}
          placeholder="••••••••"
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
        {status === "loading" ? "Logging in…" : "Log in"}
      </button>
    </form>
  );
}
