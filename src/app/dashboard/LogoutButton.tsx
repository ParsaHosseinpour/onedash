"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signOutAction } from "@/app/actions/auth";

/**
 * Logout is a server action: Supabase revokes the session and the SSR cookies
 * are cleared on the response. The client then returns to the public site.
 */
export default function LogoutButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState("");

  function handleLogout() {
    setErrorMessage("");

    startTransition(async () => {
      try {
        const result = await signOutAction();

        if (!result.ok) {
          setErrorMessage(
            result.message ?? "We couldn't log you out. Please try again."
          );
          return;
        }

        router.replace("/");
        router.refresh();
      } catch {
        setErrorMessage("We couldn't log you out. Please try again.");
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleLogout}
        disabled={isPending}
        className="text-sm rounded-lg border border-[color:var(--border)] px-4 py-2 hover:bg-[color:var(--background-elevated)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isPending ? "Logging out…" : "Log out"}
      </button>

      {errorMessage && (
        <p
          role="alert"
          aria-live="polite"
          className="text-xs text-[color:var(--danger)]"
        >
          {errorMessage}
        </p>
      )}
    </div>
  );
}
