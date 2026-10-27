"use client";

import { useState, type FormEvent } from "react";

type Status = "idle" | "loading" | "success" | "error";

type WaitlistResponse = {
  ok?: boolean;
  message?: string;
  alreadyJoined?: boolean;
};

/**
 * Waitlist form.
 *
 * Submissions go through /api/waitlist so validation, rate limiting, and
 * error handling happen server-side. The form never talks to the database
 * directly. A queue position is deliberately not shown: the app cannot
 * guarantee one.
 */
export default function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [alreadyJoined, setAlreadyJoined] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (status === "loading") {
      return;
    }

    setStatus("loading");
    setMessage("");

    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          website,
          source: "landing_page",
        }),
      });

      const data = (await response
        .json()
        .catch(() => null)) as WaitlistResponse | null;

      if (!response.ok || !data?.ok) {
        setStatus("error");
        setMessage(
          typeof data?.message === "string" && data.message
            ? data.message
            : "Something went wrong. Please try again."
        );
        return;
      }

      setAlreadyJoined(Boolean(data.alreadyJoined));
      setMessage(
        typeof data.message === "string" && data.message
          ? data.message
          : "You're on the list! We'll email you when early access opens."
      );
      setStatus("success");
    } catch {
      setStatus("error");
      setMessage(
        "We couldn't reach the server. Check your connection and try again."
      );
    }
  }

  if (status === "success") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-8 rounded-xl border border-[color:var(--accent)] bg-[color:var(--background-elevated)] p-6 text-center"
      >
        <div className="text-4xl mb-2">🎉</div>
        <p className="font-semibold text-lg">
          {alreadyJoined ? "You're already on the list!" : "You're on the list!"}
        </p>
        <p className="mt-1 text-[color:var(--foreground-muted)]">
          {message}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-8">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col sm:flex-row gap-3 justify-center"
      >
        <input
          type="email"
          name="email"
          required
          maxLength={254}
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={status === "loading"}
          placeholder="you@example.com"
          aria-label="Email address"
          className="rounded-lg border border-[color:var(--border)] bg-[color:var(--background-elevated)] px-4 py-3 text-foreground placeholder:text-[color:var(--foreground-muted)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)] flex-1 max-w-sm disabled:opacity-50"
        />

        {/* Honeypot: hidden from humans, tempting to naive bots. */}
        <div className="hidden" aria-hidden="true">
          <label htmlFor="waitlist-website">Website</label>
          <input
            id="waitlist-website"
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
          />
        </div>

        <button
          type="submit"
          disabled={status === "loading"}
          className="rounded-lg bg-[color:var(--accent)] px-6 py-3 font-semibold text-[#0a0e1a] hover:bg-[color:var(--accent-dim)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {status === "loading" ? "Saving…" : "Reserve my spot"}
        </button>
      </form>

      {status === "error" && (
        <p
          role="alert"
          aria-live="polite"
          className="mt-3 text-sm text-[color:var(--danger)]"
        >
          {message}
        </p>
      )}
    </div>
  );
}
