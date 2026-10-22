"use client";

import { useEffect, useState, useCallback, useMemo, memo, useRef } from "react";
import Link from "next/link";
import { useLocale } from "next-intl";
import { toast, Toaster } from "sonner";
import {
  useHydrateMerchantStore,
  useMerchantApiKey,
  useMerchantHydrated,
  useMerchantId,
} from "@/lib/merchant-store";
import { usePaymentSocket } from "@/lib/usePaymentSocket";
import { useDisplayPreferences, formatAmount } from "@/lib/display-preferences";

interface Payment {
  id: string;
  amount: number;
  asset: string;
  status: string;
  description: string | null;
  created_at: string;
  isOptimistic?: boolean;
}

interface PaymentRowProps {
  payment: Payment;
  index: number;
  locale: string;
  hideCents: boolean;
}

const PaymentRow = memo(function PaymentRow({
  payment,
  index,
  locale,
  hideCents,
}: PaymentRowProps) {
  const formattedDate = useMemo(
    () => new Date(payment.created_at).toLocaleDateString(),
    [payment.created_at],
  );
  const formattedAmount = useMemo(
    () => formatAmount(payment.amount, locale, hideCents),
    [payment.amount, locale, hideCents],
  );
  const rowClassName = `group cursor-pointer outline-none transition-all duration-200 ease-in-out hover:bg-pluto-50 hover:shadow-sm active:bg-pluto-100 active:scale-[0.985] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-pluto-500 ${index % 2 === 0 ? "bg-white" : "bg-[#F9F9F9]"} ${payment.isOptimistic ? "animate-pulse" : ""}`;
  const statusClassName = `inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-tight ${
    payment.status === "confirmed"
      ? "bg-[#0A0A0A] text-white"
      : payment.status === "pending"
        ? "bg-[#F5F5F5] text-[#6B6B6B] border border-[#E8E8E8]"
        : "bg-red-50 text-red-600 border border-red-100"
  }`;
  return (
    <tr
      role="row"
      tabIndex={0}
      className={rowClassName}
      aria-label={`Payment ${payment.description || "Transaction"} for ${formattedAmount} ${payment.asset}${payment.isOptimistic ? " (Verifying)" : ""}`}
    >
      <td className="border-l-0 border-transparent px-6 py-4 transition-all duration-200 group-hover:border-l-2 group-hover:border-l-pluto-500">
        <div className={statusClassName} aria-label={`Status: ${payment.status}${payment.isOptimistic ? " (Verifying)" : ""}`}>
          {payment.status}
          {payment.isOptimistic && (
            <span className="h-1 w-1 rounded-full bg-current animate-pulse" />
          )}
        </div>
      </td>
      <td className="px-6 py-4">
        <p className="text-sm font-semibold text-[#0A0A0A] truncate max-w-[200px]">
          {payment.description || "Transaction"}
        </p>
      </td>
      <td className="px-6 py-4">
        <time
          className="text-[11px] font-medium text-[#6B6B6B]"
          dateTime={payment.created_at}
        >
          {formattedDate}
        </time>
      </td>
      <td className="px-6 py-4 text-right">
        <p className="text-sm font-bold text-[#0A0A0A]">
          {formattedAmount} {payment.asset}
        </p>
      </td>
    </tr>
  );
});

export default function ActivityFeed() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryTrigger, setRetryTrigger] = useState(0);
  const verificationTimeouts = useRef<Map<string, NodeJS.Timeout>>(new Map());

  const apiKey = useMerchantApiKey();
  const hydrated = useMerchantHydrated();
  const merchantId = useMerchantId();
  const locale = useLocale();
  const { hideCents } = useDisplayPreferences();

  useHydrateMerchantStore();

  // Verify optimistic payment with backend
  const verifyPayment = useCallback(
    async (paymentId: string) => {
      try {
        if (!apiKey) return;

        const apiUrl =
          process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
        const response = await fetch(`${apiUrl}/api/payments/${paymentId}`, {
          headers: { "x-api-key": apiKey },
          signal: AbortSignal.timeout(5000), // 5s timeout
        });

        if (!response.ok) {
          throw new Error("Verification failed");
        }

        const data = await response.json();

        // Update payment to confirmed if verified
        setPayments((prev) =>
          prev.map((p) =>
            p.id === paymentId
              ? { ...p, status: data.status || "confirmed", isOptimistic: false }
              : p,
          ),
        );
      } catch (err) {
        // Rollback on verification failure
        setPayments((prev) => {
          const payment = prev.find((p) => p.id === paymentId);
          if (payment?.isOptimistic) {
            toast.error("Payment verification failed", {
              description: `${formatAmount(payment.amount, locale, hideCents)} ${payment.asset} - Network error, update rolled back`,
              duration: 5000,
            });
            return prev.filter((p) => p.id !== paymentId);
          }
          return prev;
        });
      } finally {
        verificationTimeouts.current.delete(paymentId);
      }
    },
    [apiKey, locale, hideCents],
  );

  const handleConfirmed = useCallback(
    (event: {
      id: string;
      amount: number;
      asset: string;
      confirmed_at: string;
    }) => {
      setPayments((prev) => {
        // If payment exists, update it to confirmed and move to top
        const exists = prev.find((p) => p.id === event.id);
        let updatedList = prev;

        if (exists) {
          updatedList = prev.map((p) =>
            p.id === event.id ? { ...p, status: "confirmed", isOptimistic: false } : p,
          );
          // Clear verification timeout if exists
          const timeout = verificationTimeouts.current.get(event.id);
          if (timeout) {
            clearTimeout(timeout);
            verificationTimeouts.current.delete(event.id);
          }
        } else {
          // Brand new payment arrived - add optimistically
          const newPayment: Payment = {
            id: event.id,
            amount: event.amount,
            asset: event.asset,
            status: "confirmed",
            description: "Real-time payment",
            created_at: event.confirmed_at,
            isOptimistic: true,
          };

          updatedList = [newPayment, ...prev];

          // Schedule verification in 3 seconds
          const timeout = setTimeout(() => {
            verifyPayment(event.id);
          }, 3000);
          verificationTimeouts.current.set(event.id, timeout);

          // Show optimistic toast
          toast.success("New payment received", {
            description: `${formatAmount(event.amount, locale, hideCents)} ${event.asset}`,
            duration: 3000,
          });
        }

        // Sort to ensure highest items are top
        return updatedList
          .sort(
            (a, b) =>
              new Date(b.created_at).getTime() -
              new Date(a.created_at).getTime(),
          )
          .slice(0, 10);
      });
    },
    [locale, hideCents, verifyPayment],
  );

  // Cleanup verification timeouts on unmount
  useEffect(() => {
    return () => {
      verificationTimeouts.current.forEach((timeout) => clearTimeout(timeout));
      verificationTimeouts.current.clear();
    };
  }, []);

  usePaymentSocket(merchantId, handleConfirmed);

  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();

    const fetchPayments = async () => {
      try {
        if (!apiKey) {
          setError("API key not found.");
          setLoading(false);
          return;
        }

        const apiUrl =
          process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
        const response = await fetch(`${apiUrl}/api/payments?limit=10`, {
          headers: { "x-api-key": apiKey },
          signal: controller.signal,
        });

        if (!response.ok) throw new Error("Failed to fetch payments");

        const data = await response.json();
        setPayments(data.payments ?? []);
        setError(null);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        const errorMessage =
          err instanceof Error ? err.message : "Failed to load activity";
        setError(errorMessage);

        // Show toast for network failures
        toast.error("Network error", {
          description: errorMessage,
          action: {
            label: "Retry",
            onClick: () => {
              setLoading(true);
              setError(null);
              fetchPayments();
            },
          },
          duration: 10000,
        });
      } finally {
        setLoading(false);
      }
    };

    fetchPayments();
    return () => controller.abort();
  }, [apiKey, hydrated, retryTrigger]);

  if (loading) {
    return (
      <>
        <Toaster position="top-right" richColors closeButton />
        <div data-testid="activity-feed-loading" className="space-y-4 animate-pulse">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-14 w-full rounded-lg bg-[#F5F5F5] sm:h-16" />
          ))}
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <Toaster position="top-right" richColors closeButton />
        <div
          data-testid="activity-feed-error"
          className="flex items-center justify-between rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-red-400"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setError(null);
              setRetryTrigger((prev) => prev + 1);
            }}
            className="rounded bg-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-300 transition-colors hover:bg-red-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          >
            Retry
          </button>
        </div>
      </>
    );
  }

  if (payments.length === 0) {
    return (
      <>
        <Toaster position="top-right" richColors closeButton />
        <div
          data-testid="activity-feed-empty"
          className="flex flex-col items-center justify-center rounded-lg border border-[#E8E8E8] bg-[#F9F9F9] p-8 text-center sm:p-16"
        >
          <h3 className="mb-3 text-lg font-bold text-[#0A0A0A] sm:text-xl">
            No activity detected
          </h3>
          <p className="mb-8 max-w-sm text-sm font-medium text-[#6B6B6B] sm:text-base">
            Your live feed will populate here once you start receiving payments.
            Create a link to get started.
          </p>
          <Link
            href="/dashboard/create"
            className="w-full rounded-[6px] bg-[#0A0A0A] px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-[#222] sm:w-auto"
          >
            Create First Payment
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <Toaster position="top-right" richColors closeButton />
      <div data-testid="activity-feed" className="rounded-lg border border-[#E8E8E8] bg-white overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#E8E8E8] bg-[#0A0A0A] px-4 py-4 sm:px-6">
          <h3 className="font-semibold text-white text-sm">Live Activity Feed</h3>
          <div className="flex items-center gap-2 text-[10px] font-bold text-white/70 uppercase tracking-widest">
            <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
            Live
          </div>
        </div>

      {/* ── Mobile card list (visible below sm breakpoint) ── */}
      <div className="space-y-3 p-4 sm:hidden">
        {payments.map((payment, i) => (
          <div
            key={payment.id}
            /* Hover: lift with Pluto-50 tint + left accent border.
               Active: scale-down for tactile tap feedback.
               Focus-visible: keyboard-navigable with Pluto-500 ring. */
            tabIndex={0}
            role="row"
            aria-label={`Payment ${payment.description || "Transaction"} for ${formatAmount(payment.amount, locale, hideCents)} ${payment.asset}${payment.isOptimistic ? " (Verifying)" : ""}`}
            className={`rounded-lg border p-3 outline-none
              transition-all duration-200 ease-in-out
              hover:border-l-2 hover:border-l-pluto-500 hover:bg-pluto-50 hover:shadow-sm
              active:scale-[0.985] active:bg-pluto-100
              focus-visible:ring-2 focus-visible:ring-pluto-500 focus-visible:ring-offset-2
              cursor-pointer
              ${i % 2 === 0 ? "border-[#E8E8E8] bg-white" : "border-[#ECECEC] bg-[#F9F9F9]"}
              ${payment.isOptimistic ? "animate-pulse" : ""}`}
          >
            <div className="mb-2 flex items-start justify-between gap-3">
              <p className="truncate text-sm font-semibold text-[#0A0A0A]">
                {payment.description || "Transaction"}
              </p>
              <div
                className={`shrink-0 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-tight ${payment.status === "confirmed"
                    ? "bg-[#0A0A0A] text-white"
                    : payment.status === "pending"
                      ? "bg-[#F5F5F5] text-[#6B6B6B] border border-[#E8E8E8]"
                      : "bg-red-50 text-red-600 border border-red-100"
                  }`}
                aria-label={`Status: ${payment.status}${payment.isOptimistic ? " (Verifying)" : ""}`}
              >
                {payment.status}
                {payment.isOptimistic && (
                  <span className="h-1 w-1 rounded-full bg-current animate-pulse" />
                )}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <time
                className="text-[11px] font-medium text-[#6B6B6B]"
                dateTime={payment.created_at}
              >
                {new Date(payment.created_at).toLocaleDateString()}
              </time>
              <p className="text-right text-sm font-bold text-[#0A0A0A]">
                {formatAmount(payment.amount, locale, hideCents)} {payment.asset}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-left border-separate border-spacing-0">
          <thead>
            <tr className="bg-[#F9F9F9] border-b border-[#E8E8E8]">
              <th className="px-6 py-3 text-[11px] font-bold text-[#6B6B6B] uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-[11px] font-bold text-[#6B6B6B] uppercase tracking-wider">
                Description
              </th>
              <th className="px-6 py-3 text-[11px] font-bold text-[#6B6B6B] uppercase tracking-wider">
                Date
              </th>
              <th className="px-6 py-3 text-right text-[11px] font-bold text-[#6B6B6B] uppercase tracking-wider">
                Amount
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E8E8E8]">
            {payments.map((payment, i) => (
              <PaymentRow
                key={payment.id}
                payment={payment}
                index={i}
                locale={locale}
                hideCents={hideCents}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
    </>
  );
}
