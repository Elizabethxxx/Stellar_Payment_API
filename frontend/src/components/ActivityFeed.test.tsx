/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ActivityFeed from "./ActivityFeed";

// ─── Mock sonner ─────────────────────────────────────────────────────────────
const mockToast = {
  success: vi.fn(),
  error: vi.fn(),
};

vi.mock("sonner", () => ({
  toast: mockToast,
  Toaster: () => <div data-testid="toaster" />,
}));

// ─── Mock next-intl ───────────────────────────────────────────────────────────
let mockLocale = "en";
vi.mock("next-intl", () => ({
  useLocale: () => mockLocale,
}));

// ─── Mock merchant store ──────────────────────────────────────────────────────
let mockApiKey: string | null = "merchant-secret-key-123";
let mockHydrated = true;
let mockMerchantId: string | null = "merchant_test_123";

vi.mock("@/lib/merchant-store", () => ({
  useMerchantApiKey: () => mockApiKey,
  useMerchantHydrated: () => mockHydrated,
  useMerchantId: () => mockMerchantId,
  useHydrateMerchantStore: vi.fn(),
}));

// ─── Mock usePaymentSocket ────────────────────────────────────────────────────
let socketCallback: ((event: any) => void) | null = null;
vi.mock("@/lib/usePaymentSocket", () => ({
  usePaymentSocket: vi.fn((_merchantId: string | null, onConfirmed: (event: any) => void) => {
    socketCallback = onConfirmed;
  }),
}));

// ─── Mock display preferences ─────────────────────────────────────────────────
let mockHideCents = false;
vi.mock("@/lib/display-preferences", () => ({
  useDisplayPreferences: () => ({ hideCents: mockHideCents }),
  formatAmount: (amount: number, _locale: string, hideCents: boolean) =>
    hideCents && Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2),
}));

const MOCK_PAYMENTS = [
  {
    id: "pay_101",
    amount: 250.0,
    asset: "USDC",
    status: "confirmed",
    description: "Annual Subscription",
    created_at: "2026-10-21T10:00:00.000Z",
  },
  {
    id: "pay_102",
    amount: 45.5,
    asset: "XLM",
    status: "pending",
    description: "Service Tip",
    created_at: "2026-10-21T09:30:00.000Z",
  },
  {
    id: "pay_103",
    amount: 1000.0,
    asset: "USDC",
    status: "failed",
    description: "Enterprise Invoice",
    created_at: "2026-10-21T08:15:00.000Z",
  },
];

describe("ActivityFeed Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocale = "en";
    mockApiKey = "merchant-secret-key-123";
    mockHydrated = true;
    mockMerchantId = "merchant_test_123";
    mockHideCents = false;
    socketCallback = null;

    (globalThis.fetch as any) = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ payments: MOCK_PAYMENTS }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. Loading & Empty States ──────────────────────────────────────────────
  describe("Loading & Empty States", () => {
    it("renders loading skeleton while fetching initial payments", () => {
      (globalThis.fetch as any) = vi.fn().mockReturnValue(new Promise(() => {}));
      render(<ActivityFeed />);

      expect(screen.getByTestId("activity-feed-loading")).toBeInTheDocument();
      expect(screen.queryByTestId("activity-feed")).not.toBeInTheDocument();
    });

    it("renders empty state when merchant has no activity", async () => {
      (globalThis.fetch as any) = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ payments: [] }),
      });

      render(<ActivityFeed />);

      await waitFor(() => {
        expect(screen.getByTestId("activity-feed-empty")).toBeInTheDocument();
      });

      expect(screen.getByText("No activity detected")).toBeInTheDocument();
      expect(screen.getByText("Create First Payment")).toBeInTheDocument();
    });
  });

  // ── 2. Error & Retry Interactions ──────────────────────────────────────────
  describe("Error State & Retry Interactions", () => {
    it("renders error state on HTTP failure and permits retry", async () => {
      (globalThis.fetch as any) = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ payments: MOCK_PAYMENTS }),
        });

      render(<ActivityFeed />);

      await waitFor(() => {
        expect(screen.getByTestId("activity-feed-error")).toBeInTheDocument();
      });

      expect(screen.getByText("Failed to fetch payments")).toBeInTheDocument();

      // Click inline Retry button
      const retryBtn = screen.getByRole("button", { name: "Retry" });
      fireEvent.click(retryBtn);

      await waitFor(() => {
        expect(screen.getByTestId("activity-feed")).toBeInTheDocument();
      });
      expect(screen.getByText("Annual Subscription")).toBeInTheDocument();
    });

    it("displays error toast with retry action on network rejection", async () => {
      (globalThis.fetch as any) = vi
        .fn()
        .mockRejectedValueOnce(new Error("Connection refused"));

      render(<ActivityFeed />);

      await waitFor(() => {
        expect(screen.getByTestId("activity-feed-error")).toBeInTheDocument();
      });

      expect(mockToast.error).toHaveBeenCalledWith(
        "Network error",
        expect.objectContaining({
          description: "Connection refused",
        }),
      );
    });
  });

  // ── 3. Populated Feed & Rendering ──────────────────────────────────────────
  describe("Populated Feed & Rendering", () => {
    it("renders both desktop table and mobile card representations", async () => {
      render(<ActivityFeed />);

      await waitFor(() => {
        expect(screen.getByTestId("activity-feed")).toBeInTheDocument();
      });

      // Desktop table checks
      expect(screen.getByText("Live Activity Feed")).toBeInTheDocument();
      expect(screen.getAllByText("Annual Subscription").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Service Tip").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Enterprise Invoice").length).toBeGreaterThan(0);

      // Status badges
      expect(screen.getAllByText("confirmed").length).toBeGreaterThan(0);
      expect(screen.getAllByText("pending").length).toBeGreaterThan(0);
      expect(screen.getAllByText("failed").length).toBeGreaterThan(0);
    });

    it("formats amounts properly according to display preferences", async () => {
      mockHideCents = true;
      render(<ActivityFeed />);

      await waitFor(() => {
        expect(screen.getByTestId("activity-feed")).toBeInTheDocument();
      });

      // Integer 250 -> 250, Non-integer 45.5 -> 45.50
      expect(screen.getAllByText("250 USDC").length).toBeGreaterThan(0);
      expect(screen.getAllByText("45.50 XLM").length).toBeGreaterThan(0);
    });
  });

  // ── 4. Accessibility & Keyboard Navigation ──────────────────────────────────
  describe("Accessibility & Keyboard Navigation (WCAG 2.1 AA)", () => {
    it("assigns role='row', tabIndex=0, and descriptive aria-labels to all payment items", async () => {
      render(<ActivityFeed />);

      await waitFor(() => {
        expect(screen.getByTestId("activity-feed")).toBeInTheDocument();
      });

      const rows = screen.getAllByRole("row");
      // Header row + data rows (both desktop and mobile)
      expect(rows.length).toBeGreaterThan(3);

      const annualRows = screen.getAllByLabelText(/Payment Annual Subscription for 250\.00 USDC/i);
      expect(annualRows.length).toBeGreaterThan(0);
      annualRows.forEach((row) => {
        expect(row).toHaveAttribute("tabindex", "0");
      });
    });
  });

  // ── 5. Real-Time Socket Updates & Optimistic Feedback ───────────────────────
  describe("Real-Time Socket & Optimistic Updates", () => {
    it("prepends new payment upon receiving real-time event and shows toast", async () => {
      render(<ActivityFeed />);

      await waitFor(() => {
        expect(screen.getByTestId("activity-feed")).toBeInTheDocument();
      });

      expect(socketCallback).toBeTypeOf("function");

      // Simulate incoming socket payment event
      act(() => {
        socketCallback?.({
          id: "pay_new_999",
          amount: 88.0,
          asset: "USDC",
          confirmed_at: new Date().toISOString(),
        });
      });

      expect(screen.getAllByText("Real-time payment").length).toBeGreaterThan(0);
      expect(mockToast.success).toHaveBeenCalledWith(
        "New payment received",
        expect.objectContaining({
          description: "88.00 USDC",
        }),
      );
    });
  });

  // ── 6. Snapshot Tests ──────────────────────────────────────────────────────
  describe("Snapshot Tests", () => {
    it("matches snapshot on loading state", () => {
      (globalThis.fetch as any) = vi.fn().mockReturnValue(new Promise(() => {}));
      const { container } = render(<ActivityFeed />);
      expect(container).toMatchSnapshot();
    });

    it("matches snapshot on empty state", async () => {
      (globalThis.fetch as any) = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ payments: [] }),
      });
      const { container } = render(<ActivityFeed />);
      await waitFor(() => screen.getByTestId("activity-feed-empty"));
      expect(container).toMatchSnapshot();
    });

    it("matches snapshot on error state", async () => {
      (globalThis.fetch as any) = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      const { container } = render(<ActivityFeed />);
      await waitFor(() => screen.getByTestId("activity-feed-error"));
      expect(container).toMatchSnapshot();
    });

    it("matches snapshot on populated state", async () => {
      const { container } = render(<ActivityFeed />);
      await waitFor(() => screen.getByTestId("activity-feed"));
      expect(container).toMatchSnapshot();
    });
  });
});
