"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  MONITOR_INTERVAL_HELP,
  MONITOR_METHODS,
  MONITOR_NAME_MAX_LENGTH,
  MONITOR_STATUS_HELP,
  MONITOR_TIMEOUT_HELP,
  MONITOR_URL_MAX_LENGTH,
  initialMonitorFormState,
  type MonitorFormState,
  type MonitorFormValues,
} from "@/lib/monitor-config";

export type MonitorFormAction = (
  state: MonitorFormState,
  formData: FormData
) => Promise<MonitorFormState>;

const INPUT_BASE =
  "w-full rounded-lg border bg-[color:var(--background-elevated)] px-3 py-2 text-sm text-foreground placeholder:text-[color:var(--foreground-muted)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)] disabled:cursor-not-allowed disabled:opacity-60";

function inputClass(hasError: boolean): string {
  return `${INPUT_BASE} ${
    hasError
      ? "border-[color:var(--danger)]"
      : "border-[color:var(--border)]"
  }`;
}

function fieldErrorId(field: string): string {
  return `monitor-${field}-error`;
}

function FieldError({
  field,
  message,
}: {
  field: string;
  message?: string;
}) {
  if (!message) return null;

  return (
    <p
      id={fieldErrorId(field)}
      className="mt-1.5 text-xs text-[color:var(--danger)]"
    >
      {message}
    </p>
  );
}

export default function MonitorForm({
  action,
  initialValues,
  mode,
  cancelHref,
}: {
  action: MonitorFormAction;
  initialValues: MonitorFormValues;
  mode: "create" | "edit";
  cancelHref: string;
}) {
  const [state, formAction, isPending] = useActionState(action, {
    ...initialMonitorFormState,
    values: initialValues,
  });

  // Uncontrolled fields keep what the user typed. When an action returns
  // values (for example after server validation), a fresh render uses them as
  // defaults, and the browser still preserves the submitted input on the same
  // mounted form.
  const values = state.values ?? initialValues;
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;
  const errorMessage = state.status === "error" ? state.message : undefined;

  return (
    <form
      action={formAction}
      aria-busy={isPending}
      className="space-y-6 rounded-2xl border border-[color:var(--border)] bg-[color:var(--background-elevated)] p-5 sm:p-6"
    >
      {errorMessage && (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
        >
          {errorMessage}
        </div>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="monitor-name" className="mb-1.5 block text-sm font-medium">
            Name
          </label>
          <input
            id="monitor-name"
            name="name"
            type="text"
            required
            maxLength={MONITOR_NAME_MAX_LENGTH}
            autoComplete="off"
            defaultValue={values.name}
            disabled={isPending}
            aria-invalid={Boolean(fieldErrors?.name)}
            aria-describedby={
              fieldErrors?.name ? fieldErrorId("name") : undefined
            }
            className={inputClass(Boolean(fieldErrors?.name))}
            placeholder="Production API"
          />
          <FieldError field="name" message={fieldErrors?.name} />
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="monitor-url" className="mb-1.5 block text-sm font-medium">
            URL
          </label>
          <input
            id="monitor-url"
            name="url"
            type="url"
            required
            maxLength={MONITOR_URL_MAX_LENGTH}
            autoComplete="url"
            spellCheck={false}
            defaultValue={values.url}
            disabled={isPending}
            aria-invalid={Boolean(fieldErrors?.url)}
            aria-describedby={
              fieldErrors?.url ? fieldErrorId("url") : "monitor-url-help"
            }
            className={inputClass(Boolean(fieldErrors?.url))}
            placeholder="https://api.example.com/health"
          />
          <p
            id="monitor-url-help"
            className="mt-1.5 text-xs text-[color:var(--foreground-muted)]"
          >
            HTTP or HTTPS only. Ports 80 and 443. Usernames and passwords in the
            URL are rejected. Localhost and obvious private addresses are
            blocked at configuration time; the Phase 4 checker will revalidate
            every resolved address.
          </p>
          <FieldError field="url" message={fieldErrors?.url} />
        </div>

        <div>
          <label
            htmlFor="monitor-method"
            className="mb-1.5 block text-sm font-medium"
          >
            Method
          </label>
          <select
            id="monitor-method"
            name="method"
            defaultValue={values.method}
            disabled={isPending}
            aria-invalid={Boolean(fieldErrors?.method)}
            aria-describedby={
              fieldErrors?.method ? fieldErrorId("method") : undefined
            }
            className={inputClass(Boolean(fieldErrors?.method))}
          >
            {MONITOR_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
          <FieldError field="method" message={fieldErrors?.method} />
        </div>

        <div>
          <label
            htmlFor="monitor-expected-status"
            className="mb-1.5 block text-sm font-medium"
          >
            Expected status
          </label>
          <input
            id="monitor-expected-status"
            name="expectedStatus"
            type="text"
            required
            inputMode="numeric"
            defaultValue={values.expectedStatus}
            disabled={isPending}
            aria-invalid={Boolean(fieldErrors?.expectedStatus)}
            aria-describedby={
              fieldErrors?.expectedStatus
                ? fieldErrorId("expectedStatus")
                : "monitor-status-help"
            }
            className={inputClass(Boolean(fieldErrors?.expectedStatus))}
            placeholder="200"
          />
          <p
            id="monitor-status-help"
            className="mt-1.5 text-xs text-[color:var(--foreground-muted)]"
          >
            {MONITOR_STATUS_HELP}
          </p>
          <FieldError
            field="expectedStatus"
            message={fieldErrors?.expectedStatus}
          />
        </div>

        <div>
          <label
            htmlFor="monitor-interval"
            className="mb-1.5 block text-sm font-medium"
          >
            Interval (minutes)
          </label>
          <input
            id="monitor-interval"
            name="intervalMinutes"
            type="number"
            required
            min="1"
            max="1440"
            step="any"
            defaultValue={values.intervalMinutes}
            disabled={isPending}
            aria-invalid={Boolean(fieldErrors?.intervalMinutes)}
            aria-describedby={
              fieldErrors?.intervalMinutes
                ? fieldErrorId("intervalMinutes")
                : "monitor-interval-help"
            }
            className={inputClass(Boolean(fieldErrors?.intervalMinutes))}
          />
          <p
            id="monitor-interval-help"
            className="mt-1.5 text-xs text-[color:var(--foreground-muted)]"
          >
            {MONITOR_INTERVAL_HELP}
          </p>
          <FieldError
            field="intervalMinutes"
            message={fieldErrors?.intervalMinutes}
          />
        </div>

        <div>
          <label
            htmlFor="monitor-timeout"
            className="mb-1.5 block text-sm font-medium"
          >
            Timeout (seconds)
          </label>
          <input
            id="monitor-timeout"
            name="timeoutSeconds"
            type="number"
            required
            min="1"
            max="60"
            step="1"
            defaultValue={values.timeoutSeconds}
            disabled={isPending}
            aria-invalid={Boolean(fieldErrors?.timeoutSeconds)}
            aria-describedby={
              fieldErrors?.timeoutSeconds
                ? fieldErrorId("timeoutSeconds")
                : "monitor-timeout-help"
            }
            className={inputClass(Boolean(fieldErrors?.timeoutSeconds))}
          />
          <p
            id="monitor-timeout-help"
            className="mt-1.5 text-xs text-[color:var(--foreground-muted)]"
          >
            {MONITOR_TIMEOUT_HELP}
          </p>
          <FieldError
            field="timeoutSeconds"
            message={fieldErrors?.timeoutSeconds}
          />
        </div>

        {mode === "create" && (
          <fieldset className="sm:col-span-2">
            <legend className="mb-1.5 block text-sm font-medium">
              Initial state
            </legend>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="initialState"
                  value="active"
                  defaultChecked={values.initialState === "active"}
                  disabled={isPending}
                />
                Active configuration
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="initialState"
                  value="paused"
                  defaultChecked={values.initialState === "paused"}
                  disabled={isPending}
                />
                Paused
              </label>
            </div>
            <p className="mt-1.5 text-xs text-[color:var(--foreground-muted)]">
              This flag is saved for the future scheduler. No checks run in this
              release.
            </p>
            <FieldError
              field="initialState"
              message={fieldErrors?.initialState}
            />
          </fieldset>
        )}
      </div>

      {mode === "edit" && (
        <p className="text-xs text-[color:var(--foreground-muted)]">
          Editing configuration does not change whether the monitor is paused.
          Use the pause/resume control on the monitor page.
        </p>
      )}

      <div className="flex flex-col-reverse gap-3 border-t border-[color:var(--border)] pt-5 sm:flex-row sm:justify-end">
        <Link
          href={cancelHref}
          className="rounded-lg border border-[color:var(--border)] px-4 py-2 text-center text-sm hover:bg-[color:var(--background)]"
        >
          Cancel
        </Link>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-[color:var(--accent)] px-4 py-2 text-sm font-semibold text-[#0a0e1a] transition-colors hover:bg-[color:var(--accent-dim)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending
            ? "Saving…"
            : mode === "create"
              ? "Create monitor"
              : "Save changes"}
        </button>
      </div>
    </form>
  );
}
