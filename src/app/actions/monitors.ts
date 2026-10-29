"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  initialMonitorDeleteState,
  initialMonitorFormState,
  isMonitorId,
  type MonitorDeleteState,
  type MonitorFormState,
  type MonitorFormValues,
  type MonitorToggleResult,
} from "@/lib/monitor-config";
import {
  MONITOR_SERVICE_MESSAGES,
  createMonitor,
  deleteMonitor,
  setMonitorActive,
  updateMonitor,
  type MonitorServiceFailure,
} from "@/lib/monitor-service";
import { validateMonitorForm } from "@/lib/monitor-validation";
import { ConfigurationError } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

const UNAVAILABLE_MESSAGE = MONITOR_SERVICE_MESSAGES.unavailable;

function readMonitorId(value: unknown): string | null {
  const id = typeof value === "string" ? value.trim() : "";
  return isMonitorId(id) ? id : null;
}

function rawFromFormData(formData: FormData) {
  return {
    name: formData.get("name"),
    url: formData.get("url"),
    method: formData.get("method"),
    expectedStatus: formData.get("expectedStatus"),
    intervalMinutes: formData.get("intervalMinutes"),
    timeoutSeconds: formData.get("timeoutSeconds"),
    initialState: formData.get("initialState"),
  };
}

function formValuesFromFormData(formData: FormData): MonitorFormValues {
  return validateMonitorForm(rawFromFormData(formData)).values;
}

function formFailure(
  result: MonitorServiceFailure,
  fallbackValues: MonitorFormValues
): MonitorFormState {
  return {
    status: "error",
    message: result.message,
    fieldErrors: result.fieldErrors,
    values: result.values ?? fallbackValues,
  };
}

async function getActionClient(): Promise<SupabaseClient | null> {
  try {
    return await createClient();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error("Monitor action is unavailable.", error.message);
    } else {
      console.error("Could not create the monitor action client.", {
        name: error instanceof Error ? error.name : "unknown",
      });
    }

    return null;
  }
}

function unexpectedFormFailure(values: MonitorFormValues): MonitorFormState {
  return {
    status: "error",
    message: UNAVAILABLE_MESSAGE,
    values,
  };
}

export async function createMonitorAction(
  _previousState: MonitorFormState = initialMonitorFormState,
  formData: FormData
): Promise<MonitorFormState> {
  void _previousState;

  // Authoritative auth. requireUser redirects on an invalid session, so it is
  // intentionally outside the try/catch below.
  const user = await requireUser();
  const values = formValuesFromFormData(formData);

  const supabase = await getActionClient();
  if (!supabase) {
    return unexpectedFormFailure(values);
  }

  let result;
  try {
    result = await createMonitor(supabase, user.id, rawFromFormData(formData));
  } catch (error) {
    console.error("Create monitor action failed unexpectedly.", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return unexpectedFormFailure(values);
  }

  if (!result.ok) {
    return formFailure(result, values);
  }

  revalidatePath("/dashboard");
  redirect(`/dashboard/monitors/${result.data.id}?created=1`);
}

export async function updateMonitorAction(
  monitorId: string,
  _previousState: MonitorFormState = initialMonitorFormState,
  formData: FormData
): Promise<MonitorFormState> {
  void _previousState;

  const user = await requireUser();
  const values = formValuesFromFormData(formData);
  const id = readMonitorId(monitorId);

  if (!id) {
    return {
      status: "error",
      message: MONITOR_SERVICE_MESSAGES.notFound,
      values,
    };
  }

  const supabase = await getActionClient();
  if (!supabase) {
    return unexpectedFormFailure(values);
  }

  let result;
  try {
    result = await updateMonitor(
      supabase,
      user.id,
      id,
      rawFromFormData(formData)
    );
  } catch (error) {
    console.error("Update monitor action failed unexpectedly.", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return unexpectedFormFailure(values);
  }

  if (!result.ok) {
    return formFailure(result, values);
  }

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/monitors/${id}`);
  redirect(`/dashboard/monitors/${id}?updated=1`);
}

export async function setMonitorActiveAction(
  monitorId: string,
  isActive: boolean
): Promise<MonitorToggleResult> {
  const user = await requireUser();
  const id = readMonitorId(monitorId);

  if (!id || typeof isActive !== "boolean") {
    return { ok: false, message: MONITOR_SERVICE_MESSAGES.notFound };
  }

  const supabase = await getActionClient();
  if (!supabase) {
    return { ok: false, message: UNAVAILABLE_MESSAGE };
  }

  try {
    const result = await setMonitorActive(supabase, user.id, id, isActive);

    if (!result.ok) {
      return { ok: false, message: result.message };
    }

    revalidatePath("/dashboard");
    revalidatePath(`/dashboard/monitors/${id}`);

    return {
      ok: true,
      message: isActive ? "Monitor resumed." : "Monitor paused.",
    };
  } catch (error) {
    console.error("Set monitor active action failed unexpectedly.", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false, message: UNAVAILABLE_MESSAGE };
  }
}

export async function deleteMonitorAction(
  monitorId: string,
  _previousState: MonitorDeleteState = initialMonitorDeleteState,
  formData: FormData
): Promise<MonitorDeleteState> {
  void _previousState;

  const user = await requireUser();
  const id = readMonitorId(monitorId);
  const rawConfirmation = formData.get("confirmation");
  const confirmation =
    typeof rawConfirmation === "string" ? rawConfirmation : "";

  if (!id) {
    return {
      status: "error",
      message: MONITOR_SERVICE_MESSAGES.notFound,
      confirmation,
    };
  }

  const supabase = await getActionClient();
  if (!supabase) {
    return {
      status: "error",
      message: UNAVAILABLE_MESSAGE,
      confirmation,
    };
  }

  let result;
  try {
    result = await deleteMonitor(supabase, user.id, id, confirmation);
  } catch (error) {
    console.error("Delete monitor action failed unexpectedly.", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return {
      status: "error",
      message: UNAVAILABLE_MESSAGE,
      confirmation,
    };
  }

  if (!result.ok) {
    return {
      status: "error",
      message: result.message,
      fieldError: result.fieldErrors?.confirmation,
      confirmation,
    };
  }

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/monitors/${id}`);
  redirect("/dashboard?deleted=1");
}
