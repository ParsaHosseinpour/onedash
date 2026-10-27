// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WaitlistForm from "@/app/components/WaitlistForm";

async function submit(email = "person@example.com") {
  const user = userEvent.setup();
  render(<WaitlistForm />);

  await user.type(screen.getByLabelText("Email address"), email);
  await user.click(
    screen.getByRole("button", { name: /reserve my spot/i })
  );
}

describe("WaitlistForm", () => {
  it("resets the loading state and shows a friendly error on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("offline"))
    );

    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't reach the server/i
    );
    expect(
      screen.getByRole("button", { name: /reserve my spot/i })
    ).toBeEnabled();
  });

  it("shows the server error instead of a raw exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          ok: false,
          message: "Too many attempts. Please try again in a few minutes.",
        }),
      })
    );

    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /too many attempts/i
    );
    expect(
      screen.getByRole("button", { name: /reserve my spot/i })
    ).toBeEnabled();
  });

  it("confirms success without promising a queue position", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          alreadyJoined: false,
          message:
            "You're on the list! We'll email you when early access opens.",
        }),
      })
    );

    await submit();

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/you're on the list/i);
    expect(status).not.toHaveTextContent(/in line|#\d+|queue position/i);
  });
});
