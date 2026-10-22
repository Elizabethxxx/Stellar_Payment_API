import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const push = vi.fn();
const logout = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/merchant-store", () => ({ useMerchantLogout: () => logout }));
vi.mock("react-hot-toast", () => ({
  default: { error: (m: string) => toastError(m), success: (m: string) => toastSuccess(m) },
}));

import DangerZone from "./DangerZone";

const fetchMock = vi.fn();

beforeEach(() => {
  push.mockReset();
  logout.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openFirstModal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /initiate deletion/i }));
}

async function openConfirmation(user: ReturnType<typeof userEvent.setup>) {
  await openFirstModal(user);
  await user.click(screen.getByRole("button", { name: "Continue" }));
}

describe("DangerZone keyboard navigation (#1571)", () => {
  it("starts on the safe action (Cancel) when the first dialog opens", async () => {
    const user = userEvent.setup();
    render(<DangerZone apiKey="key" />);
    await openFirstModal(user);

    expect(screen.getByRole("dialog", { name: "Delete Account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("Enter on the initially focused control cancels instead of continuing", async () => {
    const user = userEvent.setup();
    render(<DangerZone apiKey="key" />);
    await openFirstModal(user);

    await user.keyboard("{Enter}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns focus to the opener when the first dialog is dismissed with Escape", async () => {
    const user = userEvent.setup();
    render(<DangerZone apiKey="key" />);
    const opener = screen.getByRole("button", { name: /initiate deletion/i });
    await user.click(opener);

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("focuses the labelled confirmation input when the final dialog opens", async () => {
    const user = userEvent.setup();
    render(<DangerZone apiKey="key" />);
    await openConfirmation(user);

    const input = screen.getByRole("textbox", { name: /type delete/i });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("autocapitalize", "characters");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAccessibleDescription(/enter/i);
  });

  it("keeps the delete button disabled until DELETE is typed, so Enter cannot submit early", async () => {
    const user = userEvent.setup();
    render(<DangerZone apiKey="key" />);
    await openConfirmation(user);

    const submit = screen.getByRole("button", { name: "Permanently Delete Account" });
    expect(submit).toBeDisabled();

    await user.keyboard("delet{Enter}");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(submit).toBeDisabled();

    await user.keyboard("e");
    expect(submit).toBeDisabled(); // lower-case does not match
  });

  it("deletes the account when DELETE is typed and Enter is pressed", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    const user = userEvent.setup();
    render(<DangerZone apiKey="secret-key" />);
    await openConfirmation(user);

    await user.keyboard("DELETE{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/merchants$/);
    expect(init).toMatchObject({ method: "DELETE", headers: { "x-api-key": "secret-key" } });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/register"));
    expect(logout).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("Escape closes the final dialog and clears what was typed", async () => {
    const user = userEvent.setup();
    render(<DangerZone apiKey="key" />);
    await openConfirmation(user);
    await user.keyboard("DELE");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await openConfirmation(user);
    expect(screen.getByRole("textbox", { name: /type delete/i })).toHaveValue("");
  });

  it("ignores Escape, the backdrop and the close button while the delete request is in flight", async () => {
    let resolveFetch!: (v: unknown) => void;
    fetchMock.mockReturnValue(new Promise((r) => (resolveFetch = r)));
    const user = userEvent.setup();
    render(<DangerZone apiKey="key" />);
    await openConfirmation(user);
    await user.keyboard("DELETE{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("modal-backdrop"));
    await user.click(screen.getByRole("button", { name: /close final confirmation/i }));

    expect(screen.getByRole("dialog", { name: "Final Confirmation" })).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: /type delete/i });
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveValue("DELETE");
    // The dialog is not left stuck: a second Enter does not send a second request.
    await user.keyboard("{Enter}");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => resolveFetch({ ok: true, json: async () => ({}) }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/register"));
  });

  it("stays open and usable again after a failed deletion", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "nope" }) });
    const user = userEvent.setup();
    render(<DangerZone apiKey="key" />);
    await openConfirmation(user);
    await user.keyboard("DELETE{Enter}");

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("nope"));
    expect(push).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox", { name: /type delete/i });
    expect(input).not.toHaveAttribute("readonly");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps Tab inside the final dialog", async () => {
    const user = userEvent.setup();
    render(<DangerZone apiKey="key" />);
    await openConfirmation(user);
    await user.keyboard("DELETE");

    const dialog = screen.getByRole("dialog", { name: "Final Confirmation" });
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });
});

describe("Modal initialFocusRef is opt-in", () => {
  it("still focuses the dialog itself when no ref is given", async () => {
    const { Modal } = await import("@/components/ui/Modal");
    render(
      <Modal isOpen onClose={() => {}} title="Plain">
        <button type="button">Inside</button>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Plain" })).toHaveFocus();
  });
});
