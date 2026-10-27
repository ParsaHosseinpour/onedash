"use client";

import { useActionState } from "react";
import { signInAction } from "@/app/actions/auth";
import { initialLoginState } from "@/lib/auth-validation";

/**
 * Login form. Credentials are submitted to a server action so the Supabase
 * session cookies are written by the server and remain readable by the
 * dashboard on the very next request.
 */
export default function LoginForm({ nextPath }: { nextPath: string }) {
  const [state, formAction, isPending] = useActionState(
    signInAction,
    initialLoginState
  );

  const errorMessage = state.status === "error" ? state.message : null;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="next" value={nextPath} />

      <div>
        <label
          htmlFor="email"
          className="block text-sm font-medium mb-1.5"
        >
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={state.status === "error" ? state.email ?? "" : ""}
          disabled={isPending}
          placeholder="you@example.com"
          aria-invalid={Boolean(errorMessage)}
          aria-describedby={errorMessage ? "login-error" : undefined}
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
          name="password"
          type="password"
          required
          autoComplete="current-password"
          disabled={isPending}
          placeholder="••••••••"
          aria-invalid={Boolean(errorMessage)}
          aria-describedby={errorMessage ? "login-error" : undefined}
          className="w-full rounded-lg border border-[color:var(--border)] bg-[color:var(--background-elevated)] px-4 py-2.5 text-foreground placeholder:text-[color:var(--foreground-muted)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)] disabled:opacity-50"
        />
      </div>

      {errorMessage && (
        <p
          id="login-error"
          role="alert"
          aria-live="polite"
          className="text-sm text-[color:var(--danger)]"
        >
          {errorMessage}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-lg bg-[color:var(--accent)] px-4 py-2.5 font-semibold text-[#0a0e1a] hover:bg-[color:var(--accent-dim)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isPending ? "Logging in…" : "Log in"}
      </button>
    </form>
  );
}
