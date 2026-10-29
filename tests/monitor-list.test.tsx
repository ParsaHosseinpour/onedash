// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MonitorList from "@/app/dashboard/components/MonitorList";
import type { MonitorSummary } from "@/lib/monitor-config";

vi.mock("@/app/dashboard/components/MonitorRowActions", () => ({
  default: ({
    monitorId,
    canWrite,
  }: {
    monitorId: string;
    canWrite: boolean;
  }) => (
    <p data-testid={`actions-${monitorId}`}>
      actions canWrite={String(canWrite)}
    </p>
  ),
}));

const checkedMonitor: MonitorSummary = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Production API",
  url: "https://api.example.com/health",
  method: "GET",
  expectedStatusCodes: [200, 201, 202, 204],
  intervalSeconds: 300,
  timeoutSeconds: 10,
  isActive: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  lastCheckedAt: "2026-10-28T12:34:00.000Z",
};

const uncheckedMonitor: MonitorSummary = {
  ...checkedMonitor,
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Staging API",
  url: "https://staging.example.com/health",
  expectedStatusCodes: [204],
  intervalSeconds: 3600,
  timeoutSeconds: 30,
  isActive: false,
  lastCheckedAt: null,
};

describe("MonitorList", () => {
  it("lists configuration without inventing check results", () => {
    render(<MonitorList monitors={[checkedMonitor, uncheckedMonitor]} canWrite />);

    expect(
      screen.getByRole("list", { name: "Monitor configurations" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Production API" })).toHaveAttribute(
      "href",
      `/dashboard/monitors/${checkedMonitor.id}`
    );
    expect(screen.getByText("https://api.example.com/health")).toBeInTheDocument();
    expect(screen.getByText("Active config")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("200–202, 204")).toBeInTheDocument();
    expect(screen.getByText("5 min")).toBeInTheDocument();
    expect(screen.getByText("1 hr")).toBeInTheDocument();
  });

  it("shows a real last-check time only when monitor_state has data", () => {
    render(<MonitorList monitors={[checkedMonitor, uncheckedMonitor]} canWrite />);

    const checkedRow = screen.getByText("Production API").closest("li");
    const uncheckedRow = screen.getByText("Staging API").closest("li");
    expect(checkedRow).not.toBeNull();
    expect(uncheckedRow).not.toBeNull();

    const checkedTime = within(checkedRow as HTMLElement).getByText(/UTC/);
    expect(checkedTime.tagName).toBe("TIME");
    expect(checkedTime).toHaveAttribute(
      "dateTime",
      "2026-10-28T12:34:00.000Z"
    );
    expect(
      within(uncheckedRow as HTMLElement).getByText(/no checks recorded/i)
    ).toBeInTheDocument();
  });

  it("does not fabricate latency, uptime, or status results", () => {
    const { container } = render(
      <MonitorList monitors={[uncheckedMonitor]} canWrite={false} />
    );

    expect(container.textContent).not.toMatch(
      /uptime|latency|response time|99\.\d%|last incident|operational/i
    );
  });

  it("passes the read-only role to row actions", () => {
    render(<MonitorList monitors={[checkedMonitor]} canWrite={false} />);

    expect(
      screen.getByTestId(`actions-${checkedMonitor.id}`)
    ).toHaveTextContent("canWrite=false");
  });
});
