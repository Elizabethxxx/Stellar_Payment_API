/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import AssetConverter from "./AssetConverter";

// ─── Mock toast ───────────────────────────────────────────────────────────────
const mockToastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: any[]) => mockToastError(...args),
    success: vi.fn(),
  },
}));

// ─── Mock wallet context ──────────────────────────────────────────────────────
let mockActiveProvider: { name: string } | null = { name: "freighter" };
vi.mock("@/lib/wallet-context", () => ({
  useWallet: () => ({
    activeProvider: mockActiveProvider,
  }),
}));

// ─── Mock stellar-sdk ─────────────────────────────────────────────────────────
const mockStrictSendPathsCall = vi.fn();
const mockStrictSendPaths = vi.fn(() => ({
  call: mockStrictSendPathsCall,
}));

vi.mock("stellar-sdk", () => ({
  Horizon: {
    Server: class MockServer {
      strictSendPaths = mockStrictSendPaths;
    },
  },
  Asset: class MockAsset {
    code: string;
    issuer: string | null;
    constructor(code: string, issuer: string | null) {
      this.code = code;
      this.issuer = issuer;
    }
    static native() {
      return new MockAsset("XLM", null);
    }
  },
}));

// ─── Mock resolveAsset ────────────────────────────────────────────────────────
vi.mock("@/lib/stellar", () => ({
  resolveAsset: (code: string, issuer: string | null) => ({
    code,
    issuer,
    isNative: () => code === "XLM",
  }),
}));

describe("AssetConverter Component", () => {
  const defaultOnBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveProvider = { name: "freighter" };
    mockStrictSendPathsCall.mockResolvedValue({
      records: [
        {
          source_amount: "10",
          destination_amount: "1.2500000",
          path: [],
        },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. Rendering & Navigation ──────────────────────────────────────────────
  describe("Rendering & Navigation", () => {
    it("renders modal structure, headers, and default inputs", () => {
      render(<AssetConverter onBack={defaultOnBack} />);

      expect(screen.getByTestId("asset-converter-modal")).toBeInTheDocument();
      expect(screen.getByText("Asset Converter")).toBeInTheDocument();
      expect(screen.getByDisplayValue("XLM")).toBeInTheDocument();
      expect(screen.getByDisplayValue("USDC")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("Amount")).toBeInTheDocument();
    });

    it("triggers onBack when the close button is clicked", () => {
      render(<AssetConverter onBack={defaultOnBack} />);

      const backBtn = screen.getByLabelText("Close asset converter and return to commands");
      fireEvent.click(backBtn);
      expect(defaultOnBack).toHaveBeenCalledTimes(1);
    });

    it("triggers onBack when Escape key is pressed", () => {
      render(<AssetConverter onBack={defaultOnBack} />);

      const modal = screen.getByTestId("asset-converter-modal");
      fireEvent.keyDown(modal, { key: "Escape" });
      expect(defaultOnBack).toHaveBeenCalledTimes(1);
    });
  });

  // ── 2. Responsive Drawer View and Touch Gestures (#1662) ───────────────────
  describe("Responsive Drawer View and Touch Gestures (#1662)", () => {
    it("renders mobile drawer drag handle with hidden class on desktop", () => {
      render(<AssetConverter onBack={defaultOnBack} />);

      const handle = screen.getByTestId("asset-converter-drawer-handle");
      expect(handle).toBeInTheDocument();
      expect(handle).toHaveClass("sm:hidden");
    });

    it("dismisses drawer on swipe down gesture (>50px delta)", () => {
      render(<AssetConverter onBack={defaultOnBack} />);

      const modal = screen.getByTestId("asset-converter-modal");
      fireEvent.touchStart(modal, {
        touches: [{ clientY: 100 }],
      });
      fireEvent.touchEnd(modal, {
        changedTouches: [{ clientY: 165 }],
      });

      expect(defaultOnBack).toHaveBeenCalledTimes(1);
    });

    it("does not dismiss drawer on small swipe movement (<=50px delta)", () => {
      render(<AssetConverter onBack={defaultOnBack} />);

      const modal = screen.getByTestId("asset-converter-modal");
      fireEvent.touchStart(modal, {
        touches: [{ clientY: 100 }],
      });
      fireEvent.touchEnd(modal, {
        changedTouches: [{ clientY: 130 }],
      });

      expect(defaultOnBack).not.toHaveBeenCalled();
    });

    it("does not dismiss on swipe up gesture (negative delta)", () => {
      render(<AssetConverter onBack={defaultOnBack} />);

      const modal = screen.getByTestId("asset-converter-modal");
      fireEvent.touchStart(modal, {
        touches: [{ clientY: 200 }],
      });
      fireEvent.touchEnd(modal, {
        changedTouches: [{ clientY: 140 }],
      });

      expect(defaultOnBack).not.toHaveBeenCalled();
    });

    it("ignores touchEnd if touchStart was never fired", () => {
      render(<AssetConverter onBack={defaultOnBack} />);

      const modal = screen.getByTestId("asset-converter-modal");
      fireEvent.touchEnd(modal, {
        changedTouches: [{ clientY: 250 }],
      });

      expect(defaultOnBack).not.toHaveBeenCalled();
    });
  });

  // ── 3. Validation & Swapping ───────────────────────────────────────────────
  describe("Form Validation & Asset Swapping", () => {
    it("shows validation error if wallet is not connected when pressing Enter", () => {
      mockActiveProvider = null;
      render(<AssetConverter onBack={defaultOnBack} />);

      const modal = screen.getByTestId("asset-converter-modal");
      fireEvent.keyDown(modal, { key: "Enter" });

      expect(screen.getByText("Connect a wallet to query paths")).toBeInTheDocument();
    });

    it("shows error when amount is empty or non-positive", () => {
      render(<AssetConverter onBack={defaultOnBack} />);

      const submitBtn = screen.getByRole("button", { name: "Convert assets" });
      fireEvent.click(submitBtn);

      expect(screen.getByText("Enter a valid positive amount")).toBeInTheDocument();
    });

    it("swaps from and to asset configurations on swap button click", () => {
      render(<AssetConverter onBack={defaultOnBack} />);

      const swapBtn = screen.getByLabelText("Swap source and destination assets");
      fireEvent.click(swapBtn);

      expect(screen.getByDisplayValue("USDC")).toBeInTheDocument();
      expect(screen.getByDisplayValue("XLM")).toBeInTheDocument();
    });
  });

  // ── 4. Optimistic Quote Updates and Horizon Rollback (#1663) ───────────────
  describe("Optimistic Quote Updates and Horizon Rollback (#1663)", () => {
    it("renders optimistic quote immediately and updates with resolved Horizon quote", async () => {
      let resolveCall!: (value: any) => void;
      mockStrictSendPathsCall.mockReturnValue(
        new Promise((resolve) => {
          resolveCall = resolve;
        })
      );

      render(<AssetConverter onBack={defaultOnBack} />);

      // Enter amount
      const amountInput = screen.getByPlaceholderText("Amount");
      fireEvent.change(amountInput, { target: { value: "10" } });

      const submitBtn = screen.getByRole("button", { name: "Convert assets" });
      fireEvent.click(submitBtn);

      // Verify optimistic estimate is rendered while loading
      expect(screen.getByText("Querying…")).toBeInTheDocument();
      expect(screen.getByText("Estimated Rate (Validating with network…)")).toBeInTheDocument();

      // Resolve Horizon network call
      await act(async () => {
        resolveCall({
          records: [
            {
              source_amount: "10",
              destination_amount: "1.2500000",
              path: [],
            },
          ],
        });
      });

      await waitFor(() => {
        expect(screen.getByText(/1\.2500000/)).toBeInTheDocument();
        expect(screen.queryByText("Estimated Rate (Validating with network…)")).not.toBeInTheDocument();
      });
    });

    it("rolls back optimistic state and displays toast.error on network failure", async () => {
      mockStrictSendPathsCall.mockRejectedValueOnce(new Error("Horizon server offline 503"));

      render(<AssetConverter onBack={defaultOnBack} />);

      const amountInput = screen.getByPlaceholderText("Amount");
      fireEvent.change(amountInput, { target: { value: "15" } });

      const submitBtn = screen.getByRole("button", { name: "Convert assets" });
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      await waitFor(() => {
        expect(screen.getByText("Horizon server offline 503")).toBeInTheDocument();
        expect(screen.queryByText("Estimated Rate (Validating with network…)")).not.toBeInTheDocument();
      });

      expect(mockToastError).toHaveBeenCalledWith(
        "Network error: Conversion rolled back",
        expect.objectContaining({
          description: "Horizon server offline 503",
          id: "asset-converter-network-failure",
        })
      );
    });

    it("rolls back to previous valid quote if subsequent quote fails", async () => {
      // First quote succeeds
      mockStrictSendPathsCall.mockResolvedValueOnce({
        records: [
          {
            source_amount: "5",
            destination_amount: "0.6250000",
            path: [],
          },
        ],
      });

      render(<AssetConverter onBack={defaultOnBack} />);

      const amountInput = screen.getByPlaceholderText("Amount");
      fireEvent.change(amountInput, { target: { value: "5" } });

      const submitBtn = screen.getByRole("button", { name: "Convert assets" });
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      await waitFor(() => {
        expect(screen.getByText(/0\.6250000/)).toBeInTheDocument();
      });

      // Second quote fails (e.g. refreshing quote when network is lost)
      mockStrictSendPathsCall.mockRejectedValueOnce(new Error("Network connection lost"));
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(
          "Network error: Conversion rolled back",
          expect.anything()
        );
        // Restored to previous destination amount
        expect(screen.getByText(/0\.6250000/)).toBeInTheDocument();
      });
    });
  });

  // ── 5. Snapshot Tests ──────────────────────────────────────────────────────
  describe("Snapshot Tests", () => {
    it("matches snapshot on initial render", () => {
      const { container } = render(<AssetConverter onBack={defaultOnBack} />);
      expect(container).toMatchSnapshot();
    });

    it("matches snapshot with populated quote", async () => {
      mockStrictSendPathsCall.mockResolvedValueOnce({
        records: [
          {
            source_amount: "10",
            destination_amount: "1.2500000",
            path: [],
          },
        ],
      });

      const { container } = render(<AssetConverter onBack={defaultOnBack} />);
      const amountInput = screen.getByPlaceholderText("Amount");
      fireEvent.change(amountInput, { target: { value: "10" } });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Convert assets" }));
      });

      await waitFor(() => {
        expect(screen.getByText(/1\.2500000/)).toBeInTheDocument();
      });

      expect(container).toMatchSnapshot();
    });
  });
});
