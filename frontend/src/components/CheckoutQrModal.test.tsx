import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { NextIntlClientProvider } from "next-intl";

import CheckoutQrModal from "./CheckoutQrModal";

// ─── i18n messages ───────────────────────────────────────────────────────────
const messages = {
  checkout: {
    qrModalTitle: "Payment QR Code",
    qrModalDescription:
      "Scan this QR code with your Stellar-compatible wallet to complete the payment.",
    downloadQr: "Download QR",
    downloadQrSuccess: "QR code downloaded successfully",
    downloadQrError: "Failed to download QR code",
  },
};

// ─── framer-motion mock ───────────────────────────────────────────────────────
vi.mock("framer-motion", () => {
  const strip = (props: Record<string, unknown>) => {
    const { initial: _i, animate: _a, exit: _e, transition: _t, ...rest } = props;
    return rest;
  };
  return {
    motion: {
      div: ({ children, ...p }: any) => <div {...strip(p)}>{children}</div>,
    },
    AnimatePresence: ({ children }: any) => <>{children}</>,
  };
});

// ─── sonner (toast) mock ──────────────────────────────────────────────────────
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

// ─── qrcode.react mock ───────────────────────────────────────────────────────
vi.mock("qrcode.react", () => ({
  QRCodeCanvas: ({ value, size, level }: { value: string; size: number; level: string }) => (
    <canvas
      data-testid="qr-canvas"
      data-value={value}
      data-size={size}
      data-level={level}
      width={size}
      height={size}
    />
  ),
}));

// ─── Default props ────────────────────────────────────────────────────────────
const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  qrValue: "stellar:GABC...XYZ?amount=10.00&asset_code=USDC",
  paymentId: "pay_test_abc123",
};

// ─── Render helper ────────────────────────────────────────────────────────────
function renderModal(props: Partial<typeof defaultProps> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CheckoutQrModal {...defaultProps} {...props} />
    </NextIntlClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CheckoutQrModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Visibility ─────────────────────────────────────────────────────────────

  describe("visibility", () => {
    it("renders modal content when isOpen is true", () => {
      renderModal({ isOpen: true });
      expect(screen.getByTestId("modal-content")).toBeInTheDocument();
    });

    it("does not render modal content when isOpen is false", () => {
      renderModal({ isOpen: false });
      expect(screen.queryByTestId("modal-content")).not.toBeInTheDocument();
    });

    it("renders the modal title", () => {
      renderModal();
      expect(screen.getByText("Payment QR Code")).toBeInTheDocument();
    });

    it("renders the modal description", () => {
      renderModal();
      expect(
        screen.getByText(
          "Scan this QR code with your Stellar-compatible wallet to complete the payment.",
        ),
      ).toBeInTheDocument();
    });
  });

  // ── QR Code ────────────────────────────────────────────────────────────────

  describe("QR code rendering", () => {
    it("renders a QR canvas with the correct value prop", () => {
      renderModal({ qrValue: "stellar:GABC...?amount=5.00" });
      const canvas = screen.getByTestId("qr-canvas");
      expect(canvas).toBeInTheDocument();
      expect(canvas).toHaveAttribute("data-value", "stellar:GABC...?amount=5.00");
    });

    it("renders QR canvas with high error correction level", () => {
      renderModal();
      const canvas = screen.getByTestId("qr-canvas");
      expect(canvas).toHaveAttribute("data-level", "H");
    });

    it("renders QR canvas with size 512", () => {
      renderModal();
      const canvas = screen.getByTestId("qr-canvas");
      expect(canvas).toHaveAttribute("data-size", "512");
    });

    it("re-renders with an updated qrValue", () => {
      const { rerender } = renderModal({ qrValue: "stellar:OLD" });
      expect(screen.getByTestId("qr-canvas")).toHaveAttribute("data-value", "stellar:OLD");

      rerender(
        <NextIntlClientProvider locale="en" messages={messages}>
          <CheckoutQrModal {...defaultProps} qrValue="stellar:NEW" />
        </NextIntlClientProvider>,
      );
      expect(screen.getByTestId("qr-canvas")).toHaveAttribute("data-value", "stellar:NEW");
    });
  });

  // ── Download button ────────────────────────────────────────────────────────

  describe("download button", () => {
    it("renders the download QR button", () => {
      renderModal();
      expect(screen.getByRole("button", { name: /download qr/i })).toBeInTheDocument();
    });

    it("download button is of type button (not submit)", () => {
      renderModal();
      const btn = screen.getByRole("button", { name: /download qr/i });
      expect(btn).toHaveAttribute("type", "button");
    });

    it("triggers a download and shows success toast when canvas is available", async () => {
      // Mock toDataURL on the canvas prototype
      const toDataURLSpy = vi
        .spyOn(HTMLCanvasElement.prototype, "toDataURL")
        .mockReturnValue("data:image/png;base64,abc");

      const realCreateElement = document.createElement.bind(document);
      const clickSpy = vi.fn();
      const createElementSpy = vi
        .spyOn(document, "createElement")
        .mockImplementation((tag: string, options?: any) => {
          if (tag === "a") {
            const anchor = {
              click: clickSpy,
              download: "",
              href: "",
            } as unknown as HTMLAnchorElement;
            return anchor;
          }
          return realCreateElement(tag, options);
        });

      renderModal({ paymentId: "pay_xyz" });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /download qr/i }));
      });

      expect(clickSpy).toHaveBeenCalledOnce();
      expect(mockToastSuccess).toHaveBeenCalledWith(messages.checkout.downloadQrSuccess);

      toDataURLSpy.mockRestore();
      createElementSpy.mockRestore();
    });

    it("sets the correct download filename using paymentId", async () => {
      const toDataURLSpy = vi
        .spyOn(HTMLCanvasElement.prototype, "toDataURL")
        .mockReturnValue("data:image/png;base64,abc");

      const realCreateElement = document.createElement.bind(document);
      let capturedAnchor: { download: string; href: string; click: () => void } | null = null;
      const createElementSpy = vi
        .spyOn(document, "createElement")
        .mockImplementation((tag: string, options?: any) => {
          if (tag === "a") {
            capturedAnchor = { download: "", href: "", click: vi.fn() };
            return capturedAnchor as unknown as HTMLAnchorElement;
          }
          return realCreateElement(tag, options);
        });

      renderModal({ paymentId: "pay_custom_id" });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /download qr/i }));
      });

      expect(capturedAnchor?.download).toBe("stellar-payment-pay_custom_id.png");

      toDataURLSpy.mockRestore();
      createElementSpy.mockRestore();
    });

    it("shows error toast if canvas element is not found", async () => {
      // The QRCodeCanvas mock renders a <canvas> but we remove it to simulate absence
      renderModal();
      // Remove the rendered canvas from the DOM
      document.querySelectorAll("canvas").forEach((c) => c.remove());

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /download qr/i }));
      });

      expect(mockToastError).toHaveBeenCalledWith(messages.checkout.downloadQrError);
      expect(mockToastSuccess).not.toHaveBeenCalled();
    });

    it("shows error toast if toDataURL throws", async () => {
      vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
        throw new Error("Canvas tainted");
      });

      renderModal();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /download qr/i }));
      });

      expect(mockToastError).toHaveBeenCalledWith(messages.checkout.downloadQrError);
    });
  });

  // ── Close behaviour ────────────────────────────────────────────────────────

  describe("close behaviour", () => {
    it("calls onClose when the modal close button is clicked", () => {
      const onClose = vi.fn();
      renderModal({ onClose });
      fireEvent.click(screen.getByTestId("modal-close"));
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("calls onClose when the backdrop is clicked", () => {
      const onClose = vi.fn();
      renderModal({ onClose });
      fireEvent.click(screen.getByTestId("modal-backdrop"));
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("calls onClose when Escape key is pressed", () => {
      const onClose = vi.fn();
      renderModal({ onClose });
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  // ── Accessibility ──────────────────────────────────────────────────────────

  describe("accessibility", () => {
    it("the modal container has role=dialog", () => {
      renderModal();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("modal has aria-modal=true", () => {
      renderModal();
      expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    });

    it("modal is labelled by its title", () => {
      renderModal();
      const dialog = screen.getByRole("dialog");
      const labelledBy = dialog.getAttribute("aria-labelledby");
      expect(labelledBy).toBeTruthy();
      const titleEl = document.getElementById(labelledBy!);
      expect(titleEl).toHaveTextContent("Payment QR Code");
    });

    it("close button has accessible label", () => {
      renderModal();
      const closeBtn = screen.getByTestId("modal-close");
      const ariaLabel = closeBtn.getAttribute("aria-label");
      expect(ariaLabel).toBeTruthy();
      expect(ariaLabel).toMatch(/close/i);
    });

    it("download button is keyboard-accessible (visible in tab order)", () => {
      renderModal();
      const btn = screen.getByRole("button", { name: /download qr/i });
      expect(btn).not.toHaveAttribute("tabindex", "-1");
    });

    it("backdrop has aria-hidden=true so screen readers skip it", () => {
      renderModal();
      expect(screen.getByTestId("modal-backdrop")).toHaveAttribute("aria-hidden", "true");
    });
  });

  // ── Snapshot ───────────────────────────────────────────────────────────────

  describe("snapshots", () => {
    it("matches snapshot when modal is open", () => {
      const { container } = renderModal({ isOpen: true });
      expect(container).toMatchSnapshot();
    });

    it("matches snapshot when modal is closed (renders nothing)", () => {
      const { container } = renderModal({ isOpen: false });
      expect(container).toMatchSnapshot();
    });

    it("matches snapshot with a custom qrValue", () => {
      const { container } = renderModal({ qrValue: "stellar:GCUSTOM...XYZ?amount=99.99" });
      expect(container).toMatchSnapshot();
    });

    it("matches snapshot with a custom paymentId", () => {
      const { container } = renderModal({ paymentId: "pay_snap_id_001" });
      expect(container).toMatchSnapshot();
    });
  });
});
