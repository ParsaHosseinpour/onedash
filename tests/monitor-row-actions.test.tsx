// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MonitorRowActions from "@/app/dashboard/components/MonitorRowActions";
import {
  deleteMonitorAction,
  setMonitorActiveAction,
} from "@/app/actions/monitors";
import { initialMonitorDeleteState } from "@/lib/monitor-config";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock("@/app/actions/monitors", () => ({
  deleteMonitorAction: vi.fn(),
  setMonitorActiveAction: vi.fn(),
}));

const MONITOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MONITOR_NAME = "Production API";

function renderActions(
  overrides: Partial<{
    isActive: boolean;
    canWrite: boolean;
  }> = {}
) {
  render(
    <MonitorRowActions
      monitorId={MONITOR_ID}
      monitorName={MONITOR_NAME}
      isActive={overrides.isActive ?? true}
      canWrite={overrides.canWrite ?? true}
    />
  );
}

async function openDeleteDialog() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Delete" }));
  return { user, dialog: screen.getByRole("dialog") };
}

beforeEach(() => {
  vi.mocked(setMonitorActiveAction).mockResolvedValue({ ok: true });
  vi.mocked(deleteMonitorAction).mockResolvedValue({ status: "success" });
});

describe("MonitorRowActions", () => {
  it("renders no mutation controls for viewers", () => {
    renderActions({ canWrite: false });

    expect(
      screen.getByText(/viewer role cannot change monitors/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Pause monitor" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("pauses with the current monitor id and refreshes the route", async () => {
    const user = userEvent.setup();
    renderActions({ isActive: true });

    await user.click(screen.getByRole("button", { name: "Pause monitor" }));

    expect(setMonitorActiveAction).toHaveBeenCalledWith(MONITOR_ID, false);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Monitor paused."
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("resumes a paused monitor", async () => {
    const user = userEvent.setup();
    renderActions({ isActive: false });

    await user.click(screen.getByRole("button", { name: "Resume monitor" }));

    expect(setMonitorActiveAction).toHaveBeenCalledWith(MONITOR_ID, true);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Monitor resumed."
    );
  });

  it("shows a safe failure message when toggling fails", async () => {
    vi.mocked(setMonitorActiveAction).mockResolvedValue({
      ok: false,
      message: "You do not have permission to change monitors.",
    });
    const user = userEvent.setup();
    renderActions();

    await user.click(screen.getByRole("button", { name: "Pause monitor" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /do not have permission/i
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("opens a deliberate delete dialog and focuses the confirmation input", async () => {
    renderActions();

    const { dialog } = await openDeleteDialog();

    expect(dialog).toHaveAccessibleName(`Delete “${MONITOR_NAME}”?`);
    const input = screen.getByLabelText("Monitor name");
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAttribute("placeholder", MONITOR_NAME);
  });

  it("closes the delete dialog on cancel and Escape", async () => {
    renderActions();

    const first = await openDeleteDialog();
    await first.user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const second = await openDeleteDialog();
    await second.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("submits the exact confirmation text to the bound delete action", async () => {
    const user = userEvent.setup();
    renderActions();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.type(screen.getByLabelText("Monitor name"), MONITOR_NAME);
    await user.click(screen.getByRole("button", { name: "Delete monitor" }));

    await waitFor(() =>
      expect(deleteMonitorAction).toHaveBeenCalledOnce()
    );
    const [monitorId, previousState, formData] = vi.mocked(deleteMonitorAction)
      .mock.calls[0];
    expect(monitorId).toBe(MONITOR_ID);
    expect(previousState).toEqual(initialMonitorDeleteState);
    expect(formData).toBeInstanceOf(FormData);
    expect((formData as FormData).get("confirmation")).toBe(MONITOR_NAME);
  });

  it("shows confirmation mismatch errors from the action", async () => {
    vi.mocked(deleteMonitorAction).mockResolvedValue({
      status: "error",
      message: "Type the monitor name exactly to confirm deletion.",
      fieldError: "The confirmation text does not match the monitor name.",
      confirmation: "wrong",
    });
    const user = userEvent.setup();
    renderActions();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.type(screen.getByLabelText("Monitor name"), "wrong");
    await user.click(screen.getByRole("button", { name: "Delete monitor" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /type the monitor name exactly/i
    );
    expect(
      screen.getByText(/confirmation text does not match/i)
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Monitor name")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
  });

  it("disables delete while the action is pending to prevent double submit", async () => {
    let resolveDelete!: (state: { status: "success" }) => void;
    vi.mocked(deleteMonitorAction).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }) as never
    );
    const user = userEvent.setup();
    renderActions();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.type(screen.getByLabelText("Monitor name"), MONITOR_NAME);
    await user.click(screen.getByRole("button", { name: "Delete monitor" }));

    const pendingButton = await screen.findByRole("button", {
      name: "Deleting…",
    });
    expect(pendingButton).toBeDisabled();
    expect(screen.getByLabelText("Monitor name")).toBeDisabled();

    resolveDelete({ status: "success" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Delete monitor" })
      ).toBeEnabled()
    );
  });
});
