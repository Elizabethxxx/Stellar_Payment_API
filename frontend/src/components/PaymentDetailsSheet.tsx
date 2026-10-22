/**
 * Payment Details Sheet component (#1554).
 *
 * Displays payment details with responsive mobile drawer and touch gestures.
 */

import React, { useState, useRef, useEffect } from "react";

interface PaymentDetailsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  payment: {
    id: string;
    amount: string;
    asset: string;
    destination: string;
    status: string;
    createdAt: string;
  };
  className?: string;
}

export function PaymentDetailsSheet({ isOpen, onClose, payment, className = "" }: PaymentDetailsSheetProps) {
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Focus trap
  useEffect(() => {
    if (!isOpen || !paymentId || !apiKey) return;
    setLoading(true); setError(null); setPayment(null);
    const load = async () => {
      // Optimistic state: cache the previous state for rollback on failure (#1555)
      const prevPayment = payment;
      const prevLogs = webhookLogs;
      try {
        const [pRes, lRes] = await Promise.all([
          fetch(`${API_URL}/api/payments/${paymentId}`, { headers: { "x-api-key": apiKey } }),
          fetch(`${API_URL}/api/webhook-logs?limit=10`, { headers: { "x-api-key": apiKey } }),
        ]);
        if (!pRes.ok) throw new Error("Failed to fetch payment details");
        const pd = await pRes.json();
        setPayment(pd.payment);
        if (lRes.ok) { const ld = await lRes.json(); setWebhookLogs(ld.logs || []); }
      } catch (err: unknown) {
        // Rollback to previous state on network failure (#1555)
        setPayment(prevPayment);
        setWebhookLogs(prevLogs);
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally { setLoading(false); }
    if (!isOpen) return;

    const focusableElements = sheetRef.current?.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements?.[0] as HTMLElement;
    const lastElement = focusableElements?.[focusableElements.length - 1] as HTMLElement;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        triggerRef.current?.focus();
        return;
      }

      if (e.key === "Tab") {
        if (e.shiftKey) {
          if (document.activeElement === firstElement) {
            e.preventDefault();
            lastElement?.focus();
          }
        } else {
          if (document.activeElement === lastElement) {
            e.preventDefault();
            firstElement?.focus();
          }
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    firstElement?.focus();

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Touch gestures for mobile drawer (#1554)
  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchStart(e.touches[0].clientY);
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStart === null) return;
    const touchEnd = e.changedTouches[0].clientY;
    const diff = touchStart - touchEnd;

    // Swipe down to close
    if (diff < -50) {
      onClose();
    }
    setTouchStart(null);
  };

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 transition-opacity"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Sheet */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-details-title"
        className={`
          fixed inset-x-0 bottom-0 z-50 transform transition-transform duration-300 ease-in-out
          bg-white rounded-t-2xl shadow-2xl p-6 max-h-[80vh] overflow-y-auto
          ${isOpen ? "translate-y-0" : "translate-y-full"}
          md:absolute md:inset-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2
          md:w-full md:max-w-lg md:rounded-2xl md:max-h-[70vh]
          ${className}
        `}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Drag handle for mobile */}
        <div
          className="w-12 h-1 bg-gray-300 rounded-full mx-auto mb-4 md:hidden"
          aria-hidden="true"
        />

        <div className="flex items-center justify-between mb-6">
          <h2 id="payment-details-title" className="text-xl font-bold">
            Payment Details
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close payment details"
            className="p-2 hover:bg-gray-100 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-500">Payment ID</label>
            <p className="text-lg font-mono">{payment.id}</p>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-500">Amount</label>
            <p className="text-lg font-semibold">
              {payment.amount} {payment.asset}
            </p>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-500">Destination</label>
            <p className="text-lg font-mono truncate">{payment.destination}</p>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-500">Status</label>
            <p className="text-lg">
              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-medium ${
                  payment.status === "completed"
                    ? "bg-green-100 text-green-800"
                    : payment.status === "pending"
                      ? "bg-yellow-100 text-yellow-800"
                      : "bg-red-100 text-red-800"
                }`}
              >
                {payment.status}
              </span>
            </p>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-500">Created</label>
            <p className="text-lg">{new Date(payment.createdAt).toLocaleString()}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-6 w-full px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          Close
        </button>
      </div>
    </>
  );
}

export default PaymentDetailsSheet;
