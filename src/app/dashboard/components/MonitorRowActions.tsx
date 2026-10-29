"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  deleteMonitorAction,
  setMonitorActiveAction,
} from "@/app/actions/monitors";
import {
  initialMonitorDeleteState,
  type MonitorDeleteState,
} from "@/lib/monitor-config";

const SECONDARY_BUTTON =
  "rounded-lg border border-[color:var(--border)] px-3 py-1.5 text-sm transition-colors hover:bg-[color:var(--background)] disabled:cursor-not-allowed disabled:opacity-50";

export default function MonitorRowActions({
  monitorId,
  monitorName,
  isActive,
  canWrite,
}: {
  monitorId: string;
  monitorName: string;
  isActive: boolean;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [toggleMessage, setToggleMessage] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [isToggling, startToggle] = useTransition();
  const confirmationRef = useRef<HTMLInputElement>(null);

  const deleteAction = useMemo(
    () => deleteMonitorAction.bind(null, monitorId),
    [monitorId]
  );
  const [deleteState, deleteFormAction, isDeleting] = useActionState<
    MonitorDeleteState,
    FormData
  >(deleteAction, initialMonitorDeleteState);

  useEffect(() => {
    if (deleteOpen) {
      confirmationRef.current?.focus();
    }
  }, [deleteOpen]);

  if (!canWrite) {
    return (
      <p className="text-xs text-[color:var(--foreground-muted)]">
        Read-only: your viewer role cannot change monitors.
      </p>
    );
  }

  function handleToggle() {
    setToggleMessage(null);

    startToggle(async () => {
      try {
        const result = await setMonitorActiveAction(monitorId, !isActive);

        if (!result.ok) {
          setToggleMessage({
            ok: false,
            text: result.message ?? "The monitor could not be updated.",
          });
          return;
        }

        setToggleMessage({
          ok: true,
          text:
            result.message ??
            (isActive ? "Monitor paused." : "Monitor resumed."),
        });
        router.refresh();
      } catch {
        setToggleMessage({
          ok: false,
          text: "The monitor could not be updated. Please try again.",
        });
      }
    });
  }

  return (
    <div className="flex flex-col items-stretch gap-2 sm:items-end">
      <div className="flex flex-wrap gap-2">
        <Link
          href={`/dashboard/monitors/${monitorId}/edit`}
          className={SECONDARY_BUTTON}
        >
          Edit
        </Link>
        <button
          type="button"
          onClick={handleToggle}
          disabled={isToggling}
          className={SECONDARY_BUTTON}
        >
          {isToggling
            ? "Saving…"
            : isActive
              ? "Pause monitor"
              : "Resume monitor"}
        </button>
        <button
          type="button"
          onClick={() => {
            setToggleMessage(null);
            setDeleteOpen(true);
          }}
          className="rounded-lg border border-[color:var(--danger)]/60 px-3 py-1.5 text-sm text-[color:var(--danger)] transition-colors hover:bg-[color:var(--danger)]/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Delete
        </button>
      </div>

      {toggleMessage && (
        <p
          role={toggleMessage.ok ? "status" : "alert"}
          aria-live="polite"
          className={
            toggleMessage.ok
              ? "text-xs text-[color:var(--accent)]"
              : "text-xs text-[color:var(--danger)]"
          }
        >
          {toggleMessage.text}
        </p>
      )}

      {deleteOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`delete-title-${monitorId}`}
          aria-describedby={`delete-description-${monitorId}`}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !isDeleting) {
              setDeleteOpen(false);
            }
          }}
          className="w-full rounded-xl border border-[color:var(--danger)]/50 bg-[color:var(--background)] p-4 text-left sm:max-w-md"
        >
          <h3
            id={`delete-title-${monitorId}`}
            className="font-semibold text-foreground"
          >
            Delete “{monitorName}”?
          </h3>
          <p
            id={`delete-description-${monitorId}`}
            className="mt-1 text-sm text-[color:var(--foreground-muted)]"
          >
            This permanently removes the monitor configuration and its stored
            state. This cannot be undone. Type the exact monitor name to
            confirm.
          </p>

          <form action={deleteFormAction} className="mt-4 space-y-3">
            <div>
              <label
                htmlFor={`delete-confirmation-${monitorId}`}
                className="mb-1.5 block text-sm font-medium"
              >
                Monitor name
              </label>
              <input
                ref={confirmationRef}
                id={`delete-confirmation-${monitorId}`}
                name="confirmation"
                type="text"
                required
                autoComplete="off"
                defaultValue={deleteState.confirmation ?? ""}
                disabled={isDeleting}
                aria-invalid={Boolean(deleteState.fieldError)}
                aria-describedby={
                  deleteState.fieldError
                    ? `delete-confirmation-error-${monitorId}`
                    : undefined
                }
                className="w-full rounded-lg border border-[color:var(--border)] bg-[color:var(--background-elevated)] px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-[color:var(--danger)] disabled:opacity-60"
                placeholder={monitorName}
              />
              {deleteState.fieldError && (
                <p
                  id={`delete-confirmation-error-${monitorId}`}
                  className="mt-1.5 text-xs text-[color:var(--danger)]"
                >
                  {deleteState.fieldError}
                </p>
              )}
            </div>

            {deleteState.status === "error" && deleteState.message && (
              <p
                role="alert"
                aria-live="polite"
                className="text-sm text-[color:var(--danger)]"
              >
                {deleteState.message}
              </p>
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setDeleteOpen(false)}
                disabled={isDeleting}
                className={SECONDARY_BUTTON}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isDeleting}
                className="rounded-lg bg-[color:var(--danger)] px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDeleting ? "Deleting…" : "Delete monitor"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
