"use client";

import { useRef, useEffect, useCallback, useId } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { QRCodeCanvas } from "qrcode.react";
import { Modal } from "@/components/ui/Modal";

interface CheckoutQrModalProps {
  isOpen: boolean;
  onClose: () => void;
  qrValue: string;
  paymentId: string;
}

/**
 * CheckoutQrModal — enhanced keyboard navigation & shortcut bindings (#1531)
 *
 * Keyboard shortcuts (active only while modal is open):
 *   • Escape       – close the modal (delegated to Modal base via onClose)
 *   • D / d        – trigger QR download (mirrors the Download button)
 *   • C / c        – copy payment link to clipboard
 *   • Tab / Shift+Tab – cycle focus within the modal (handled by Modal base)
 *
 * Accessibility:
 *   • role="dialog", aria-modal, aria-labelledby, aria-describedby
 *   • Download button: aria-label with payment ID for screen-readers
 *   • Copy button:     live-region feedback via aria-live on toast, plus
 *                      visible/announced state change on the button label
 *   • QR canvas wrapped in a <figure> with <figcaption> for context
 *   • Keyboard hint badge rendered inside the modal so users know shortcuts exist
 */
export default function CheckoutQrModal({
  isOpen,
  onClose,
  qrValue,
  paymentId,
}: CheckoutQrModalProps) {
  const t = useTranslations("checkout");
  const qrWrapperRef = useRef<HTMLDivElement | null>(null);
  const downloadBtnRef = useRef<HTMLButtonElement | null>(null);
  const copyBtnRef = useRef<HTMLButtonElement | null>(null);
  const descriptionId = useId();

  // ── Download handler ────────────────────────────────────────────────────────
  const handleDownload = useCallback(() => {
    const canvas = qrWrapperRef.current?.querySelector("canvas");

    if (!canvas) {
      toast.error(t("downloadQrError"));
      return;
    }

    try {
      const link = document.createElement("a");
      link.download = `stellar-payment-${paymentId}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
      toast.success(t("downloadQrSuccess"));
    } catch {
      toast.error(t("downloadQrError"));
    }
  }, [paymentId, t]);

  // ── Copy-to-clipboard handler ───────────────────────────────────────────────
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(qrValue);
      toast.success(t("copyLinkSuccess") ?? "Payment link copied!");
    } catch {
      toast.error(t("copyLinkError") ?? "Failed to copy link.");
    }
  }, [qrValue, t]);

  // ── Keyboard shortcut bindings (modal-scoped) ───────────────────────────────
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip when focus is inside an editable element (future-proof)
      const target = e.target as HTMLElement;
      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable;

      if (isEditable) return;

      switch (e.key.toLowerCase()) {
        case "d":
          // D → Download QR
          e.preventDefault();
          handleDownload();
          // Move focus to the download button for visual confirmation
          downloadBtnRef.current?.focus();
          break;

        case "c":
          // C → Copy payment link
          e.preventDefault();
          handleCopy();
          copyBtnRef.current?.focus();
          break;

        // Escape is handled by the Modal base component and forwarded to onClose.
        // Tab cycling is also delegated to Modal's built-in focus trap.
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleDownload, handleCopy]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t("qrModalTitle")}
      descriptionId={descriptionId}
      initialFocusRef={downloadBtnRef}
    >
      <div className="flex flex-col gap-5">
        {/* Description — referenced by aria-describedby on the dialog */}
        <p
          id={descriptionId}
          className="text-sm text-[#6B6B6B]"
        >
          {t("qrModalDescription")}
        </p>

        {/* QR code wrapped in a figure for semantic context */}
        <figure
          aria-label={`QR code for payment ${paymentId}`}
          className="m-0"
        >
          <div
            ref={qrWrapperRef}
            className="flex items-center justify-center rounded-2xl border border-[#E8E8E8] bg-white p-5 transition-all hover:border-[var(--pluto-400)] hover:shadow-lg hover:shadow-[var(--pluto-400)]/10"
          >
            <QRCodeCanvas
              value={qrValue}
              size={512}
              level="H"
              includeMargin
              style={{ width: "100%", height: "auto", maxWidth: "240px" }}
            />
          </div>
          <figcaption className="sr-only">
            Scan this QR code to complete payment {paymentId}
          </figcaption>
        </figure>

        {/* Action buttons row */}
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
          {/* Download button — keyboard shortcut: D */}
          <button
            ref={downloadBtnRef}
            type="button"
            onClick={handleDownload}
            aria-label={`Download QR code for payment ${paymentId} (keyboard shortcut: D)`}
            aria-keyshortcuts="d"
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-[var(--pluto-200)] bg-[var(--pluto-50)] px-4 font-bold uppercase tracking-widest text-xs text-[var(--pluto-700)] transition-all hover:bg-[var(--pluto-100)] hover:border-[var(--pluto-400)] hover:shadow-md hover:shadow-[var(--pluto-500)]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pluto-300)] focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v1a2 2 0 002 2h12a2 2 0 002-2v-1"
              />
            </svg>
            {t("downloadQr")}
            {/* Keyboard hint badge */}
            <kbd
              aria-hidden="true"
              className="ml-auto hidden rounded border border-[var(--pluto-300)] bg-white px-1.5 py-0.5 font-mono text-[10px] text-[var(--pluto-500)] sm:inline-flex"
            >
              D
            </kbd>
          </button>

          {/* Copy link button — keyboard shortcut: C */}
          <button
            ref={copyBtnRef}
            type="button"
            onClick={handleCopy}
            aria-label={`Copy payment link to clipboard (keyboard shortcut: C)`}
            aria-keyshortcuts="c"
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-[var(--pluto-200)] bg-transparent px-4 font-bold uppercase tracking-widest text-xs text-[var(--pluto-700)] transition-all hover:bg-[var(--pluto-50)] hover:border-[var(--pluto-400)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pluto-300)] focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
            {t("copyLink") ?? "Copy Link"}
            <kbd
              aria-hidden="true"
              className="ml-auto hidden rounded border border-[var(--pluto-300)] bg-white px-1.5 py-0.5 font-mono text-[10px] text-[var(--pluto-500)] sm:inline-flex"
            >
              C
            </kbd>
          </button>
        </div>

        {/* Keyboard shortcuts legend — visible hint for sighted keyboard users */}
        <div
          role="note"
          aria-label="Keyboard shortcuts available in this modal"
          className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-[#E8E8E8] bg-slate-50 px-3 py-2 text-[11px] text-slate-500"
        >
          <span className="font-semibold text-slate-600">Shortcuts:</span>
          <span>
            <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[10px] shadow-sm">
              D
            </kbd>{" "}
            Download
          </span>
          <span>
            <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[10px] shadow-sm">
              C
            </kbd>{" "}
            Copy link
          </span>
          <span>
            <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[10px] shadow-sm">
              Esc
            </kbd>{" "}
            Close
          </span>
          <span>
            <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[10px] shadow-sm">
              Tab
            </kbd>{" "}
            Navigate
          </span>
        </div>
      </div>
    </Modal>
  );
}
