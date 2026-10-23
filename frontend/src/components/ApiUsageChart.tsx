"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useLocale } from "next-intl";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { toast } from "sonner";
import { localeToLanguageTag } from "@/i18n/config";
import { useMerchantApiKey } from "@/lib/merchant-store";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface DailyUsage {
  date: string;
  requests: number;
}

export default function ApiUsageChart() {
  const apiKey = useMerchantApiKey();
  const locale = localeToLanguageTag(useLocale());
  const [data, setData] = useState<DailyUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCompact, setIsCompact] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);

  const previousDataRef = useRef<DailyUsage[]>([]);
  const touchStartY = useRef<number | null>(null);
  const touchCurrentY = useRef<number | null>(null);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 640px)");
    const syncCompactState = (event?: MediaQueryList | MediaQueryListEvent) => {
      setIsCompact(event?.matches ?? mediaQuery.matches);
    };

    syncCompactState(mediaQuery);

    const listener = (event: MediaQueryListEvent) => syncCompactState(event);
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }, []);

  const fetchUsageData = useCallback(async () => {
    if (!apiKey) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`${API_URL}/api/metrics/api-usage`, {
        headers: {
          "x-api-key": apiKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch usage data: ${response.status}`);
      }

      const result = await response.json();
      const dailyData = result.daily || [];
      setData(dailyData);
      previousDataRef.current = dailyData;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    fetchUsageData();
  }, [fetchUsageData]);

  // Optimistic refresh with rollback & toast feedback on failure (#1658)
  const handleRefresh = useCallback(
    async (isRetry = false) => {
      if (!apiKey) return;
      try {
        setIsRefreshing(true);
        previousDataRef.current = data;

        const response = await fetch(`${API_URL}/api/metrics/api-usage`, {
          headers: {
            "x-api-key": apiKey,
          },
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch usage data: ${response.status}`);
        }

        const result = await response.json();
        const updated = result.daily || [];
        setData(updated);
        previousDataRef.current = updated;
        if (!isRetry) {
          toast.success("API usage data updated");
        }
      } catch (err) {
        // Rollback to previous state
        if (previousDataRef.current.length > 0) {
          setData(previousDataRef.current);
        }
        toast.error("Failed to update API usage data", {
          description:
            "Network error occurred. Previous data has been restored.",
          action: {
            label: "Retry",
            onClick: () => handleRefresh(true),
          },
          duration: 5000,
        });
      } finally {
        setIsRefreshing(false);
      }
    },
    [apiKey, data],
  );

  // Close drawer on Escape key (#1656 / #1657)
  useEffect(() => {
    if (!isDrawerOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isDrawerOpen]);

  // Touch gesture handlers for mobile drawer dismissal (#1657)
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return;
    const currentY = e.touches[0].clientY;
    touchCurrentY.current = currentY;
    const deltaY = currentY - touchStartY.current;
    if (deltaY > 0) {
      setDragOffset(deltaY);
    }
  };

  const handleTouchEnd = () => {
    if (touchStartY.current !== null && touchCurrentY.current !== null) {
      const deltaY = touchCurrentY.current - touchStartY.current;
      if (deltaY > 60) {
        setIsDrawerOpen(false);
      }
    }
    touchStartY.current = null;
    touchCurrentY.current = null;
    setDragOffset(0);
  };

  if (!apiKey) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <p className="text-sm text-slate-400">
          Register or log in to view API usage statistics.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-mint border-t-transparent" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6">
        <p className="text-sm text-red-300">{error}</p>
      </div>
    );
  }

  const totalRequests = data.reduce((sum, day) => sum + day.requests, 0);
  const maxDailyRequests = Math.max(...data.map((d) => d.requests), 1);

  const formatTickLabel = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      month: "short",
      day: isCompact ? undefined : "numeric",
    }).format(new Date(value));

  const formatTooltipLabel = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(value));

  return (
    <div
        role="region"
        aria-label="API Usage Statistics"
        tabIndex={0}
        className="min-w-0 rounded-xl border border-white/10 bg-white/5 p-4 sm:p-6 outline-none focus-visible:ring-2 focus-visible:ring-mint focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0A0A]"
      >
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 id="api-usage-heading" className="text-lg font-semibold text-white">
              API Usage - Last 7 Days
            </h3>
            <p className="text-sm text-slate-400" aria-live="polite">
              Total requests: {totalRequests.toLocaleString()}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleRefresh(false)}
              disabled={isRefreshing}
              aria-label="Refresh API usage statistics"
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint disabled:opacity-50"
            >
              <svg
                className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              <span>{isRefreshing ? "Updating..." : "Refresh"}</span>
            </button>

            {data.length > 0 && (
              <button
                type="button"
                onClick={() => setIsDrawerOpen(true)}
                aria-expanded={isDrawerOpen}
                aria-controls="api-usage-drawer"
                aria-label="Open detailed usage breakdown drawer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint sm:hidden"
              >
                <span>View Details</span>
              </button>
            )}
          </div>
        </div>

        {/* Screen Reader Data Table for WCAG 2.1 AA Compliance (#1656) */}
        {data.length > 0 && (
          <div className="sr-only">
            <table aria-label="Daily API request volume breakdown">
              <caption>Daily API request volume for the last 7 days</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Requests</th>
                </tr>
              </thead>
              <tbody>
                {data.map((day) => (
                  <tr key={day.date}>
                    <td>{formatTooltipLabel(day.date)}</td>
                    <td>{day.requests.toLocaleString(locale)} requests</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-slate-400">No API usage data available</p>
          </div>
        ) : (
          <div className="-mx-2 sm:mx-0">
            <ResponsiveContainer width="100%" height={isCompact ? 240 : 300}>
              <BarChart
                data={data}
                margin={{
                  top: 8,
                  right: isCompact ? 8 : 16,
                  left: isCompact ? -20 : -8,
                  bottom: isCompact ? 0 : 8,
                }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(255,255,255,0.1)"
                />
                <XAxis
                  dataKey="date"
                  stroke="#94a3b8"
                  axisLine={false}
                  tickLine={false}
                  tickMargin={10}
                  interval="preserveStartEnd"
                  minTickGap={isCompact ? 28 : 16}
                  tickFormatter={formatTickLabel}
                  style={{ fontSize: isCompact ? "10px" : "12px" }}
                />
                <YAxis
                  stroke="#94a3b8"
                  axisLine={false}
                  tickLine={false}
                  width={isCompact ? 32 : 44}
                  allowDecimals={false}
                  tickFormatter={(value: number) =>
                    value.toLocaleString(locale, { notation: "compact" })
                  }
                  style={{ fontSize: isCompact ? "10px" : "12px" }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "rgba(255, 255, 255, 0.95)",
                    border: "1px solid var(--pluto-100)",
                    borderRadius: "16px",
                    padding: "12px 16px",
                    boxShadow: "0 20px 50px rgba(0, 0, 0, 0.12)",
                    backdropFilter: "blur(8px)",
                  }}
                  itemStyle={{
                    color: "var(--pluto-600)",
                    fontSize: "12px",
                    fontWeight: "600",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                  formatter={(value: number) => [
                    value.toLocaleString(locale),
                    "Requests",
                  ]}
                  labelFormatter={formatTooltipLabel}
                  labelStyle={{
                    color: "var(--text-secondary)",
                    fontSize: "10px",
                    fontWeight: "600",
                    marginBottom: "4px",
                  }}
                />
                <Bar
                  dataKey="requests"
                  fill="#5ef2c0"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={isCompact ? 22 : 32}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Responsive Drawer View with Touch Gesture Support (#1657) */}
      {isDrawerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="API Usage Details Drawer"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:hidden"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsDrawerOpen(false);
          }}
        >
          <div
            id="api-usage-drawer"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            style={{
              transform: dragOffset > 0 ? `translateY(${dragOffset}px)` : undefined,
              transition: dragOffset === 0 ? "transform 0.2s ease-out" : "none",
            }}
            className="w-full max-h-[80vh] overflow-y-auto rounded-t-2xl border-t border-white/10 bg-[#0A0A0A] p-5 shadow-2xl"
          >
            {/* Tactile drag grabber */}
            <div
              data-testid="drawer-drag-handle"
              className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-slate-600 cursor-grab active:cursor-grabbing"
              aria-hidden="true"
            />

            <div className="mb-4 flex items-center justify-between">
              <div>
                <h4 className="text-base font-semibold text-white">
                  Usage Breakdown
                </h4>
                <p className="text-xs text-slate-400">
                  Daily requests (swipe down to close)
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsDrawerOpen(false)}
                aria-label="Close API usage details drawer"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
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

            <div className="space-y-3">
              {data.map((day) => {
                const percentage = Math.round(
                  (day.requests / maxDailyRequests) * 100,
                );
                return (
                  <div
                    key={day.date}
                    className="rounded-lg border border-white/5 bg-white/[0.02] p-3"
                  >
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-300">
                        {formatTooltipLabel(day.date)}
                      </span>
                      <span className="font-bold text-mint">
                        {day.requests.toLocaleString(locale)} reqs
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-mint transition-all duration-300"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
  );
}
