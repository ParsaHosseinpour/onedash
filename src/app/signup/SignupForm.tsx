"use client";

import { useActionState } from "react";
import { signUpAction } from "@/app/actions/auth";
import {
  initialSignupState,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@/lib/auth-validation";

/**
 * Signup form. The password policy is enforced again inside the server action,
 * so bypassing the browser cannot create an account with a weak password.
 */
export default function SignupForm() {
  const [state, formAction, isPending] = useActionState(
    signUpAction,
    initialSignupState
  );

  if (state.status === "success") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-xl border border-[color:var(--accent)] bg-[color:var(--background-elevated)] p-6 text-center"
      >
        <div className="text-4xl mb-2">📬</div>
        <p className="font-semibold text-lg">Check your email</p>
        <p className="mt-2 text-sm text-[color:var(--foreground-muted)]">
          {state.message}
        </p>
        <p className="mt-3 text-xs text-[color:var(--foreground-muted)]">
          Email: <span className="text-foreground font-medium">{state.email}</span>
        </p>
        <p className="mt-2 text-xs text-[color:var(--foreground-muted)]">
          (Check your spam folder if you don&apos;t see it within a minute.)
        </p>
      </div>
    );
  }

  const errorMessage = state.status === "error" ? state.message : null;

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium mb-1.5">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
          defaultValue={state.status === "error" ? state.email ?? "" : ""}
          disabled={isPending}
          placeholder="you@example.com"
          aria-invalid={Boolean(errorMessage)}
          aria-describedby={errorMessage ? "signup-error" : undefined}
          className="w-full rounded-lg border border-[color:var(--border)] bg-[color:var(--background-elevated)] px-4 py-2.5 text-foreground placeholder:text-[color:var(--foreground-muted)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)] disabled:opacity-50"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium mb-1.5">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
          disabled={isPending}
          placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
          aria-invalid={Boolean(errorMessage)}
          aria-describedby={`password-hint${
            errorMessage ? " signup-error" : ""
          }`}
          className="w-full rounded-lg border border-[color:var(--border)] bg-[color:var(--background-elevated)] px-4 py-2.5 text-foreground placeholder:text-[color:var(--foreground-muted)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)] disabled:opacity-50"
        />
        <p
          id="password-hint"
          className="mt-1.5 text-xs text-[color:var(--foreground-muted)]"
        >
          Use {PASSWORD_MIN_LENGTH}–{PASSWORD_MAX_LENGTH} characters, including
          at least one letter and one number.
        </p>
      </div>

      {errorMessage && (
        <p
          id="signup-error"
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
        {isPending ? "Creating account…" : "Create free account"}
      </button>
    </form>
  );
}
