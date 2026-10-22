import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ─── Mock next/image ──────────────────────────────────────────────────────────
vi.mock("next/image", () => ({
  default: ({ src, alt, fill: _f, sizes: _s, ...p }: any) => (
    <img src={src} alt={alt} {...p} />
  ),
}));

// ─── Mock next/dynamic with React.lazy + Suspense ────────────────────────────
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<any>, options?: { loading?: () => React.ReactNode }) => {
    const Component = React.lazy(loader);
    return function DynamicStub(props: any) {
      return (
        <React.Suspense fallback={options?.loading ? options.loading() : null}>
          <Component {...props} />
        </React.Suspense>
      );
    };
  },
}));

// ─── Mock next/link ──────────────────────────────────────────────────────────
vi.mock("next/link", () => ({
  default: ({ href, onClick, children, ...props }: any) => (
    <a href={href} onClick={onClick} {...props}>
      {children}
    </a>
  ),
}));

// ─── Mock next-intl ──────────────────────────────────────────────────────────
const messages: Record<string, string> = {
  account: "Account",
  openProfileMenu: "Open profile menu",
  dashboard: "Dashboard",
  settings: "Settings",
  createPayment: "Create Payment",
  logoutAccount: "Logout Account",
  loadingProfile: "Loading profile…",
};

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => messages[key] || key,
}));

// ─── Mock merchant store ─────────────────────────────────────────────────────
let mockMerchant: {
  business_name?: string | null;
  email?: string | null;
  logo_url?: string | null;
} | null = null;
let mockHydrated = true;
const mockLogout = vi.fn();
const mockHydrateMerchantStore = vi.fn();

vi.mock("@/lib/merchant-store", () => ({
  useMerchantMetadata: () => mockMerchant,
  useMerchantLogout: () => mockLogout,
  useMerchantHydrated: () => mockHydrated,
  useHydrateMerchantStore: () => mockHydrateMerchantStore(),
}));

import MerchantProfileCard from "./MerchantProfileCard";

describe("MerchantProfileCard", () => {
  const originalLocation = window.location;
  let currentHref = "http://localhost:3000/";

  beforeEach(() => {
    vi.clearAllMocks();
    mockHydrated = true;
    currentHref = "http://localhost:3000/";
    mockMerchant = {
      business_name: "Stellar Apex Ltd",
      email: "merchant@stellar.org",
      logo_url: "https://example.com/logo.png",
    };

    delete (window as any).location;
    window.location = {
      ...originalLocation,
      get href() {
        return currentHref;
      },
      set href(val: string) {
        currentHref = val;
      },
    } as any;
  });

  afterEach(() => {
    window.location = originalLocation;
  });

  // ── 1. Rendering & Hydration States ─────────────────────────────────────────
  describe("Rendering & Hydration States", () => {
    it("renders loading skeleton when not hydrated", () => {
      mockHydrated = false;
      render(<MerchantProfileCard />);

      const skeleton = screen.getByTestId("merchant-profile-loading");
      expect(skeleton).toBeInTheDocument();
      expect(skeleton).toHaveAttribute("role", "status");
      expect(skeleton).toHaveAttribute("aria-label", "Loading profile…");
      expect(screen.queryByTestId("merchant-profile-trigger")).not.toBeInTheDocument();
      expect(screen.queryByTestId("merchant-login-link")).not.toBeInTheDocument();
    });

    it("renders login link when hydrated but no merchant session", () => {
      mockHydrated = true;
      mockMerchant = null;
      render(<MerchantProfileCard />);

      const loginLink = screen.getByTestId("merchant-login-link");
      expect(loginLink).toBeInTheDocument();
      expect(loginLink).toHaveAttribute("href", "/login");
      expect(loginLink).toHaveTextContent("Account");
      expect(screen.queryByTestId("merchant-profile-trigger")).not.toBeInTheDocument();
    });

    it("renders profile card trigger button when merchant is authenticated", () => {
      render(<MerchantProfileCard />);

      const trigger = screen.getByTestId("merchant-profile-trigger");
      expect(trigger).toBeInTheDocument();
      expect(trigger).toHaveAttribute("aria-label", "Open profile menu");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(trigger).toHaveAttribute("aria-haspopup", "true");
      expect(screen.getByText("Stellar Apex Ltd")).toBeInTheDocument();
      expect(screen.getByText("merchant@stellar.org")).toBeInTheDocument();
    });

    it("falls back to email when business_name is missing", () => {
      mockMerchant = {
        business_name: null,
        email: "fallback@stellar.org",
        logo_url: null,
      };
      render(<MerchantProfileCard />);

      const names = screen.getAllByText("fallback@stellar.org");
      expect(names.length).toBeGreaterThanOrEqual(1);
    });

    it("falls back to Merchant when both business_name and email are missing", () => {
      mockMerchant = {
        business_name: null,
        email: null,
        logo_url: null,
      };
      render(<MerchantProfileCard />);

      expect(screen.getByText("Merchant")).toBeInTheDocument();
    });
  });

  // ── 2. User Interactions & Dropdown Menu ────────────────────────────────────
  describe("User Interactions & Dropdown Menu", () => {
    it("toggles dropdown menu on trigger button click", async () => {
      render(<MerchantProfileCard />);

      const trigger = screen.getByTestId("merchant-profile-trigger");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("merchant-profile-menu")).not.toBeInTheDocument();

      // Click to open
      await act(async () => {
        fireEvent.click(trigger);
      });

      expect(trigger).toHaveAttribute("aria-expanded", "true");
      const menu = await screen.findByTestId("merchant-profile-menu");
      expect(menu).toBeInTheDocument();

      // Click to close
      await act(async () => {
        fireEvent.click(trigger);
      });

      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("merchant-profile-menu")).not.toBeInTheDocument();
    });

    it("closes dropdown menu and refocuses trigger when clicking backdrop", async () => {
      render(<MerchantProfileCard />);

      const trigger = screen.getByTestId("merchant-profile-trigger");
      await act(async () => {
        fireEvent.click(trigger);
      });

      const backdrop = await screen.findByTestId("merchant-profile-backdrop");
      expect(backdrop).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(backdrop);
      });

      expect(screen.queryByTestId("merchant-profile-menu")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(trigger);
    });

    it("renders navigation links inside dropdown menu", async () => {
      render(<MerchantProfileCard />);

      const trigger = screen.getByTestId("merchant-profile-trigger");
      await act(async () => {
        fireEvent.click(trigger);
      });

      const dashboardLink = await screen.findByTestId("merchant-menu-dashboard");
      const settingsLink = await screen.findByTestId("merchant-menu-settings");
      const createLink = await screen.findByTestId("merchant-menu-create-payment");

      expect(dashboardLink).toHaveAttribute("href", "/dashboard");
      expect(dashboardLink).toHaveTextContent("Dashboard");

      expect(settingsLink).toHaveAttribute("href", "/settings");
      expect(settingsLink).toHaveTextContent("Settings");

      expect(createLink).toHaveAttribute("href", "/dashboard/create");
      expect(createLink).toHaveTextContent("Create Payment");
    });

    it("closes dropdown when a menu link is clicked", async () => {
      render(<MerchantProfileCard />);

      const trigger = screen.getByTestId("merchant-profile-trigger");
      await act(async () => {
        fireEvent.click(trigger);
      });

      const dashboardLink = await screen.findByTestId("merchant-menu-dashboard");
      await act(async () => {
        fireEvent.click(dashboardLink);
      });

      expect(screen.queryByTestId("merchant-profile-menu")).not.toBeInTheDocument();
    });

    it("handles logout action cleanly", async () => {
      render(<MerchantProfileCard />);

      const trigger = screen.getByTestId("merchant-profile-trigger");
      await act(async () => {
        fireEvent.click(trigger);
      });

      const logoutBtn = await screen.findByTestId("merchant-menu-logout");
      expect(logoutBtn).toHaveTextContent("Logout Account");

      await act(async () => {
        fireEvent.click(logoutBtn);
      });

      expect(mockLogout).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("merchant-profile-menu")).not.toBeInTheDocument();
      expect(window.location.href).toBe("/login");
    });
  });

  // ── 3. Responsive Drawer View and Touch Gestures (#1667) ─────────────────────
  describe("Responsive Drawer View and Touch Gestures", () => {
    it("renders drawer drag handle with hidden class on sm breakpoint", async () => {
      render(<MerchantProfileCard />);
      const trigger = screen.getByTestId("merchant-profile-trigger");
      await act(async () => {
        fireEvent.click(trigger);
      });

      const handle = await screen.findByTestId("merchant-drawer-handle");
      expect(handle).toBeInTheDocument();
      expect(handle).toHaveClass("sm:hidden");
    });

    it("closes drawer on swipe down gesture (>50px delta)", async () => {
      render(<MerchantProfileCard />);
      const trigger = screen.getByTestId("merchant-profile-trigger");
      await act(async () => {
        fireEvent.click(trigger);
      });

      const menu = await screen.findByTestId("merchant-profile-menu");
      fireEvent.touchStart(menu, {
        touches: [{ clientY: 100 }],
      });
      fireEvent.touchEnd(menu, {
        changedTouches: [{ clientY: 160 }],
      });

      expect(screen.queryByTestId("merchant-profile-menu")).not.toBeInTheDocument();
    });

    it("does not close drawer on small swipe movement (<=50px delta)", async () => {
      render(<MerchantProfileCard />);
      const trigger = screen.getByTestId("merchant-profile-trigger");
      await act(async () => {
        fireEvent.click(trigger);
      });

      const menu = await screen.findByTestId("merchant-profile-menu");
      fireEvent.touchStart(menu, {
        touches: [{ clientY: 100 }],
      });
      fireEvent.touchEnd(menu, {
        changedTouches: [{ clientY: 130 }],
      });

      expect(screen.getByTestId("merchant-profile-menu")).toBeInTheDocument();
    });

    it("does not close on swipe up gesture (negative delta)", async () => {
      render(<MerchantProfileCard />);
      const trigger = screen.getByTestId("merchant-profile-trigger");
      await act(async () => {
        fireEvent.click(trigger);
      });

      const menu = await screen.findByTestId("merchant-profile-menu");
      fireEvent.touchStart(menu, {
        touches: [{ clientY: 200 }],
      });
      fireEvent.touchEnd(menu, {
        changedTouches: [{ clientY: 120 }],
      });

      expect(screen.getByTestId("merchant-profile-menu")).toBeInTheDocument();
    });

    it("ignores touchEnd if touchStart was never fired", async () => {
      render(<MerchantProfileCard />);
      const trigger = screen.getByTestId("merchant-profile-trigger");
      await act(async () => {
        fireEvent.click(trigger);
      });

      const menu = await screen.findByTestId("merchant-profile-menu");
      fireEvent.touchEnd(menu, {
        changedTouches: [{ clientY: 200 }],
      });

      expect(screen.getByTestId("merchant-profile-menu")).toBeInTheDocument();
    });
  });

  // ── 3. Accessibility (WCAG 2.1 AA) & Keyboard Navigation ───────────────────
  describe("Accessibility (WCAG 2.1 AA) & Keyboard Navigation", () => {
    it("has correct ARIA semantics on menu and items", async () => {
      render(<MerchantProfileCard />);

      const trigger = screen.getByTestId("merchant-profile-trigger");
      await act(async () => {
        fireEvent.click(trigger);
      });

      const menu = await screen.findByTestId("merchant-profile-menu");
      expect(menu).toHaveAttribute("role", "menu");
      expect(menu).toHaveAttribute("aria-orientation", "vertical");

      const items = screen.getAllByRole("menuitem");
      expect(items.length).toBe(4); // Dashboard, Settings, Create, Logout
    });

    it("closes dropdown on Escape key and refocuses trigger", async () => {
      render(<MerchantProfileCard />);

      const trigger = screen.getByTestId("merchant-profile-trigger");
      await act(async () => {
        fireEvent.click(trigger);
      });

      expect(await screen.findByTestId("merchant-profile-menu")).toBeInTheDocument();

      await act(async () => {
        fireEvent.keyDown(document, { key: "Escape" });
      });

      expect(screen.queryByTestId("merchant-profile-menu")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(trigger);
    });

    it("traps focus between first and last focusable menu items", async () => {
      render(<MerchantProfileCard />);

      const trigger = screen.getByTestId("merchant-profile-trigger");
      await act(async () => {
        fireEvent.click(trigger);
      });

      const dashboardLink = await screen.findByTestId("merchant-menu-dashboard");
      const logoutBtn = await screen.findByTestId("merchant-menu-logout");

      dashboardLink.focus();
      expect(document.activeElement).toBe(dashboardLink);

      // Shift+Tab from first item wraps to last item
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(logoutBtn);

      // Tab from last item wraps to first item
      fireEvent.keyDown(document, { key: "Tab", shiftKey: false });
      expect(document.activeElement).toBe(dashboardLink);
    });
  });

  // ── 4. Snapshot Tests ──────────────────────────────────────────────────────
  describe("Snapshot Tests", () => {
    it("matches snapshot when not hydrated", () => {
      mockHydrated = false;
      const { container } = render(<MerchantProfileCard />);
      expect(container).toMatchSnapshot();
    });

    it("matches snapshot when logged out", () => {
      mockHydrated = true;
      mockMerchant = null;
      const { container } = render(<MerchantProfileCard />);
      expect(container).toMatchSnapshot();
    });

    it("matches snapshot when logged in and dropdown closed", () => {
      const { container } = render(<MerchantProfileCard />);
      expect(container).toMatchSnapshot();
    });

    it("matches snapshot when logged in and dropdown open", async () => {
      const { container } = render(<MerchantProfileCard />);
      const trigger = screen.getByTestId("merchant-profile-trigger");

      await act(async () => {
        fireEvent.click(trigger);
      });

      await screen.findByTestId("merchant-profile-menu");
      expect(container).toMatchSnapshot();
    });

    it("matches snapshot with fallback merchant details", () => {
      mockMerchant = {
        business_name: null,
        email: "simple@stellar.org",
        logo_url: null,
      };
      const { container } = render(<MerchantProfileCard />);
      expect(container).toMatchSnapshot();
    });
  });
});
