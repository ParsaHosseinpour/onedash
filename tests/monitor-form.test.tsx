// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import MonitorForm from "@/app/dashboard/components/MonitorForm";
import {
  emptyMonitorFormValues,
  type MonitorFormState,
  type MonitorFormValues,
} from "@/lib/monitor-config";

const values: MonitorFormValues = {
  ...emptyMonitorFormValues,
  name: "Production API",
  url: "https://api.example.com/health",
};

function renderForm(
  overrides: Partial<{
    action: (
      state: MonitorFormState,
      formData: FormData
    ) => Promise<MonitorFormState>;
    initialValues: MonitorFormValues;
    mode: "create" | "edit";
  }> = {}
) {
  const action =
    overrides.action ??
    vi.fn(async () => ({ status: "idle" as const }));

  render(
    <MonitorForm
      action={action}
      initialValues={overrides.initialValues ?? values}
      mode={overrides.mode ?? "create"}
      cancelHref="/dashboard"
    />
  );

  return { action };
}

describe("MonitorForm", () => {
  it("renders the first-release configuration fields", () => {
    renderForm();

    expect(screen.getByLabelText("Name")).toHaveValue("Production API");
    expect(screen.getByLabelText("URL")).toHaveValue(
      "https://api.example.com/health"
    );
    expect(screen.getByLabelText("Method")).toHaveValue("GET");
    expect(screen.getByLabelText("Expected status")).toHaveValue("200");
    expect(screen.getByLabelText("Interval (minutes)")).toHaveValue(5);
    expect(screen.getByLabelText("Timeout (seconds)")).toHaveValue(10);
    expect(
      screen.getByRole("button", { name: "Create monitor" })
    ).toBeEnabled();
  });

  it("offers only GET and HEAD", () => {
    renderForm();

    const options = screen
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["GET", "HEAD"]);
  });

  it("shows the initial state choice only when creating", () => {
    const { unmount } = render(
      <MonitorForm
        action={vi.fn(async () => ({ status: "idle" as const }))}
        initialValues={values}
        mode="create"
        cancelHref="/dashboard"
      />
    );

    expect(screen.getByText("Initial state")).toBeInTheDocument();
    expect(
      screen.getByText(/no checks run in this release/i)
    ).toBeInTheDocument();
    unmount();

    renderForm({ mode: "edit" });
    expect(screen.queryByText("Initial state")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save changes" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not change whether the monitor is paused/i)
    ).toBeInTheDocument();
  });

  it("shows server field errors and marks the field invalid", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async () => ({
      status: "error" as const,
      message: "Check the highlighted fields and try again.",
      fieldErrors: {
        url: "This host is not allowed. Use a public HTTP/HTTPS endpoint.",
        timeoutSeconds: "Timeout must be shorter than the check interval.",
      },
      values: { ...values, url: "http://127.0.0.1/health" },
    }));

    renderForm({ action });

    await user.click(screen.getByRole("button", { name: "Create monitor" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /check the highlighted fields/i
    );
    expect(screen.getByLabelText("URL")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(
      screen.getByText(/this host is not allowed/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/timeout must be shorter/i)
    ).toBeInTheDocument();
    expect(action).toHaveBeenCalledOnce();
  });

  it("disables the submit button while the action is pending", async () => {
    const user = userEvent.setup();
    let resolveAction!: (state: MonitorFormState) => void;
    const action = vi.fn(
      () =>
        new Promise<MonitorFormState>((resolve) => {
          resolveAction = resolve;
        })
    );

    renderForm({ action });

    await user.click(screen.getByRole("button", { name: "Create monitor" }));

    const pendingButton = await screen.findByRole("button", {
      name: "Saving…",
    });
    expect(pendingButton).toBeDisabled();

    await act(async () => {
      resolveAction({ status: "idle" });
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Create monitor" })
      ).toBeEnabled();
    });
  });
});
