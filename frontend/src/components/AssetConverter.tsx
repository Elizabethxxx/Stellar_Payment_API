"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import * as StellarSdk from "stellar-sdk";
import { toast } from "sonner";
import { useWallet } from "@/lib/wallet-context";
import { resolveAsset } from "@/lib/stellar";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface PathRecord {
  destination_amount: string;
  source_amount: string;
  path: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string }>;
}

export interface QuoteResult {
  sourceAsset: string;
  sourceAmount: string;
  destAsset: string;
  destAmount: string;
  rate: string;
  path: string[];
  queriedAt: number;
  isOptimistic?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? "https://horizon-testnet.stellar.org";

const SLIPPAGE = 0.01;

/* ------------------------------------------------------------------ */
/*  Icons                                                              */
/* ------------------------------------------------------------------ */

function SwapIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowLeftIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M19 12H5m0 0 5-5m-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M21 12a9 9 0 1 1-2.6-6.36" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatAssetLabel(code: string, issuer: string | null): string {
  if (!issuer || code.toUpperCase() === "XLM") return code.toUpperCase();
  return `${code.toUpperCase()}:${issuer.slice(0, 4)}…${issuer.slice(-4)}`;
}

function formatPathHop(asset: { asset_type: string; asset_code?: string; asset_issuer?: string }): string {
  if (asset.asset_type === "native") return "XLM";
  return asset.asset_code?.toUpperCase() ?? "?";
}

function isValidAssetCode(code: string): boolean {
  return /^[a-zA-Z0-9]{1,12}$/.test(code);
}

function isValidStellarAddress(addr: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(addr);
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface AssetConverterProps {
  onBack: () => void;
}

export default function AssetConverter({ onBack }: AssetConverterProps) {
  const { activeProvider } = useWallet();
  const firstInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number | null>(null);

  // From fields
  const [fromCode, setFromCode] = useState("XLM");
  const [fromIssuer, setFromIssuer] = useState("");
  const [amount, setAmount] = useState("");

  // To fields
  const [toCode, setToCode] = useState("USDC");
  const [toIssuer, setToIssuer] = useState(
    "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  );

  // State
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QuoteResult | null>(null);

  // Touch gesture support for mobile drawer dismiss (#1662)
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return;
    const deltaY = e.changedTouches[0].clientY - touchStartY.current;
    if (deltaY > 50) {
      onBack();
    }
    touchStartY.current = null;
  };

  // Focus first input on mount and trap focus
  useEffect(() => {
    requestAnimationFrame(() => firstInputRef.current?.focus());
  }, []);

  // Focus trap for accessibility
  useEffect(() => {
    const handleFocus = (e: FocusEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        e.preventDefault();
        firstInputRef.current?.focus();
      }
    };

    document.addEventListener("focusin", handleFocus);
    return () => document.removeEventListener("focusin", handleFocus);
  }, []);

  /* ---------- staleness timer ---------- */
  const [secondsAgo, setSecondsAgo] = useState(0);
  useEffect(() => {
    if (!result) return;
    setSecondsAgo(0);
    const id = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - result.queriedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [result]);

  /* ---------- validation ---------- */
  function validate(): string | null {
    if (!activeProvider) return "Connect a wallet to query paths";
    if (!fromCode.trim()) return "Enter source asset code";
    if (!isValidAssetCode(fromCode.trim())) return "Invalid source asset code (1-12 alphanumeric)";
    if (fromCode.toUpperCase() !== "XLM" && !fromIssuer.trim()) return "Issuer address required for non-native source asset";
    if (fromCode.toUpperCase() !== "XLM" && fromIssuer.trim() && !isValidStellarAddress(fromIssuer.trim())) return "Invalid source issuer address";
    if (!toCode.trim()) return "Enter destination asset code";
    if (!isValidAssetCode(toCode.trim())) return "Invalid destination asset code (1-12 alphanumeric)";
    if (toCode.toUpperCase() !== "XLM" && !toIssuer.trim()) return "Issuer address required for non-native destination asset";
    if (toCode.toUpperCase() !== "XLM" && toIssuer.trim() && !isValidStellarAddress(toIssuer.trim())) return "Invalid destination issuer address";
    if (!amount.trim() || isNaN(Number(amount)) || Number(amount) <= 0) return "Enter a valid positive amount";
    if (fromCode.toUpperCase() === toCode.toUpperCase() && (fromIssuer || "") === (toIssuer || "")) return "Source and destination assets must be different";
    return null;
  }

  /* ---------- query Horizon with Optimistic Rollback (#1663) ---------- */
  const convert = useCallback(async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    const previousResult = result;
    setLoading(true);
    setError(null);

    // Optimistic estimate while fetching path payment rate
    const estimatedRate = previousResult ? previousResult.rate : "1.0000000";
    const estimatedDestAmount = (Number(amount.trim()) * Number(estimatedRate)).toFixed(7);
    const optimisticQuote: QuoteResult = {
      sourceAsset: formatAssetLabel(fromCode, fromCode.toUpperCase() === "XLM" ? null : fromIssuer),
      sourceAmount: amount.trim(),
      destAsset: formatAssetLabel(toCode, toCode.toUpperCase() === "XLM" ? null : toIssuer),
      destAmount: estimatedDestAmount,
      rate: estimatedRate,
      path: [
        formatAssetLabel(fromCode, fromCode.toUpperCase() === "XLM" ? null : fromIssuer),
        formatAssetLabel(toCode, toCode.toUpperCase() === "XLM" ? null : toIssuer),
      ],
      queriedAt: Date.now(),
      isOptimistic: true,
    };
    setResult(optimisticQuote);

    try {
      const server = new StellarSdk.Horizon.Server(HORIZON_URL);

      const sourceAsset = resolveAsset(
        fromCode.trim().toUpperCase(),
        fromCode.toUpperCase() === "XLM" ? null : fromIssuer.trim(),
      );
      const destAsset = resolveAsset(
        toCode.trim().toUpperCase(),
        toCode.toUpperCase() === "XLM" ? null : toIssuer.trim(),
      );

      const response = await server
        .strictSendPaths(sourceAsset, amount.trim(), [destAsset])
        .call();

      const records = response.records as PathRecord[];

      if (!records || records.length === 0) {
        setResult(previousResult);
        setError("No conversion path available for this asset pair");
        toast.error("No conversion path available for this asset pair", {
          id: "asset-converter-no-path",
        });
        return;
      }

      // Pick the best path (highest destination amount)
      const best = records.reduce((a, b) =>
        Number(b.destination_amount) > Number(a.destination_amount) ? b : a,
      );

      const srcAmt = Number(best.source_amount);
      const dstAmt = Number(best.destination_amount);
      const rate = srcAmt > 0 ? (dstAmt / srcAmt).toFixed(7) : "0";

      const pathLabels = [
        formatAssetLabel(fromCode, fromCode.toUpperCase() === "XLM" ? null : fromIssuer),
        ...best.path.map(formatPathHop),
        formatAssetLabel(toCode, toCode.toUpperCase() === "XLM" ? null : toIssuer),
      ];

      setResult({
        sourceAsset: formatAssetLabel(fromCode, fromCode.toUpperCase() === "XLM" ? null : fromIssuer),
        sourceAmount: best.source_amount,
        destAsset: formatAssetLabel(toCode, toCode.toUpperCase() === "XLM" ? null : toIssuer),
        destAmount: best.destination_amount,
        rate,
        path: pathLabels,
        queriedAt: Date.now(),
        isOptimistic: false,
      });
    } catch (err) {
      // Optimistic state rollback upon network failure (#1663)
      setResult(previousResult);
      const errorMessage =
        err instanceof Error && err.message.includes("404")
          ? "No conversion path available for this asset pair"
          : err instanceof Error
          ? err.message
          : "Horizon unavailable. Try again.";

      setError(errorMessage);
      toast.error("Network error: Conversion rolled back", {
        description: errorMessage,
        id: "asset-converter-network-failure",
      });
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProvider, fromCode, fromIssuer, toCode, toIssuer, amount, result]);

  /* ---------- swap ---------- */
  function handleSwap() {
    setFromCode(toCode);
    setFromIssuer(toIssuer);
    setToCode(fromCode);
    setToIssuer(fromIssuer);
    setResult(null);
    setError(null);
  }

  /* ---------- keyboard ---------- */
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !loading) {
      e.preventDefault();
      convert();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onBack();
    }
  }

  const isNativeFrom = fromCode.toUpperCase() === "XLM";
  const isNativeTo = toCode.toUpperCase() === "XLM";

  return (
    <div
      ref={modalRef}
      onKeyDown={handleKeyDown}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      role="dialog"
      aria-modal="true"
      aria-labelledby="asset-converter-title"
      aria-describedby="asset-converter-description"
      data-testid="asset-converter-modal"
      className="fixed inset-x-0 bottom-0 z-50 flex max-h-[90vh] w-full flex-col overflow-y-auto rounded-t-3xl border-t border-white/10 bg-slate-900/95 shadow-2xl backdrop-blur-xl sm:relative sm:inset-auto sm:max-h-none sm:rounded-xl sm:border sm:border-white/10 sm:bg-slate-900/90 sm:shadow-none"
    >
      {/* Mobile Drag Handle Indicator (#1662) */}
      <div
        className="flex justify-center pt-3 pb-1 sm:hidden"
        data-testid="asset-converter-drawer-handle"
        aria-hidden="true"
      >
        <div className="h-1.5 w-12 rounded-full bg-white/20" />
      </div>

      {/* ── Header ── */}
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-white/5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-mint focus:ring-offset-2 focus:ring-offset-slate-900"
          aria-label="Close asset converter and return to commands"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="h-5 w-5 text-mint" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
            <path d="M2 17 12 7l10 10" strokeLinecap="round" strokeLinejoin="round" opacity={0.4} />
            <path d="M2 12 12 2l10 10" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h2 id="asset-converter-title" className="text-sm font-semibold text-white">Asset Converter</h2>
        </div>
        <kbd className="ml-auto hidden rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 sm:inline-block" aria-hidden="true">
          ESC
        </kbd>
      </div>

      {/* Screen reader description */}
      <div id="asset-converter-description" className="sr-only">
        Convert between Stellar assets using strict send path payment. Enter source and destination assets with amounts to get conversion rates and paths.
      </div>

      {/* ── Body ── */}
      <div className="flex flex-col gap-4 p-4">

        {/* FROM */}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            From
          </legend>
          <div className="flex gap-2">
            <input
              ref={firstInputRef}
              type="text"
              value={fromCode}
              onChange={(e) => {
                setFromCode(e.target.value.toUpperCase().slice(0, 12));
                setResult(null);
              }}
              placeholder="XLM"
              className="w-28 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-slate-600 outline-none transition-colors focus:border-mint focus:ring-2 focus:ring-mint"
              aria-label="Source asset code (1-12 alphanumeric characters)"
              aria-required="true"
              aria-describedby="from-asset-help"
            />
            {!isNativeFrom && (
              <input
                type="text"
                value={fromIssuer}
                onChange={(e) => {
                  setFromIssuer(e.target.value);
                  setResult(null);
                }}
                placeholder="Issuer G…"
                className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs text-white placeholder-slate-600 outline-none transition-colors focus:border-mint focus:ring-2 focus:ring-mint"
                aria-label="Source asset issuer address (starts with G)"
                aria-required="true"
                aria-describedby="from-issuer-help"
              />
            )}
          </div>
          <div id="from-asset-help" className="sr-only">
            Enter the asset code you want to convert from. Use XLM for native Stellar Lumens, or enter a custom asset code up to 12 characters.
          </div>
          {!isNativeFrom && (
            <div id="from-issuer-help" className="sr-only">
              Enter the Stellar address of the asset issuer. Must start with G and be 56 characters long.
            </div>
          )}
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || /^\d*\.?\d*$/.test(v)) {
                setAmount(v);
                setResult(null);
              }
            }}
            placeholder="Amount"
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-slate-600 outline-none transition-colors focus:border-mint focus:ring-2 focus:ring-mint"
            aria-label="Amount to convert (positive decimal number)"
            aria-required="true"
            aria-describedby="amount-help"
          />
          <div id="amount-help" className="sr-only">
            Enter the amount of the source asset you want to convert. Must be a positive number.
          </div>
        </fieldset>

        {/* SWAP */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={handleSwap}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-slate-400 transition-all hover:border-mint/30 hover:bg-mint/10 hover:text-mint focus:outline-none focus:ring-2 focus:ring-mint focus:ring-offset-2 focus:ring-offset-slate-900"
            aria-label="Swap source and destination assets"
            aria-describedby="swap-button-help"
          >
            <SwapIcon className="h-4 w-4" aria-hidden="true" />
          </button>
          <div id="swap-button-help" className="sr-only">
            Exchange the from and to assets. Your source asset becomes the destination and vice versa.
          </div>
        </div>

        {/* TO */}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            To
          </legend>
          <div className="flex gap-2">
            <input
              type="text"
              value={toCode}
              onChange={(e) => {
                setToCode(e.target.value.toUpperCase().slice(0, 12));
                setResult(null);
              }}
              placeholder="USDC"
              className="w-28 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-slate-600 outline-none transition-colors focus:border-mint focus:ring-2 focus:ring-mint"
              aria-label="Destination asset code (1-12 alphanumeric characters)"
              aria-required="true"
              aria-describedby="to-asset-help"
            />
            {!isNativeTo && (
              <input
                type="text"
                value={toIssuer}
                onChange={(e) => {
                  setToIssuer(e.target.value);
                  setResult(null);
                }}
                placeholder="Issuer G…"
                className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs text-white placeholder-slate-600 outline-none transition-colors focus:border-mint focus:ring-2 focus:ring-mint"
                aria-label="Destination asset issuer address (starts with G)"
                aria-required="true"
                aria-describedby="to-issuer-help"
              />
            )}
          </div>
          <div id="to-asset-help" className="sr-only">
            Enter the asset code you want to convert to. Use XLM for native Stellar Lumens, or enter a custom asset code up to 12 characters.
          </div>
          {!isNativeTo && (
            <div id="to-issuer-help" className="sr-only">
              Enter the Stellar address of the destination asset issuer. Must start with G and be 56 characters long.
            </div>
          )}
        </fieldset>

        {/* CONVERT BUTTON */}
        <button
          type="button"
          onClick={convert}
          disabled={loading || !activeProvider}
          className="group relative flex h-10 w-full items-center justify-center rounded-lg font-semibold text-black transition-all disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-mint focus:ring-offset-2 focus:ring-offset-slate-900"
          style={{ backgroundColor: "var(--color-mint)" }}
          aria-label={loading ? "Querying conversion path" : "Convert assets"}
          aria-busy={loading}
          aria-disabled={!activeProvider}
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <SpinnerIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span aria-live="polite">Querying…</span>
            </span>
          ) : (
            "Convert"
          )}
          <div className="absolute inset-0 -z-10 rounded-lg opacity-0 blur-xl transition-opacity group-hover:opacity-100" style={{ backgroundColor: "color-mix(in srgb, var(--color-mint) 25%, transparent)" }} aria-hidden="true" />
        </button>

        {/* ERROR */}
        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400"
          >
            <span className="sr-only">Error: </span>{error}
          </div>
        )}

        {/* RESULT */}
        {result && (
          <div
            className="flex flex-col gap-2.5 rounded-lg border border-mint/20 bg-mint/5 p-3"
            role="region"
            aria-live="polite"
            aria-label="Conversion result"
          >
            {/* Optimistic indicator badge */}
            {result.isOptimistic && (
              <div className="flex items-center justify-between border-b border-mint/10 pb-1.5 text-[11px] text-amber-300">
                <span className="flex items-center gap-1 font-medium">
                  <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" aria-hidden="true" />
                  Estimated Rate (Validating with network…)
                </span>
              </div>
            )}

            {/* Rate headline */}
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
                Rate
              </span>
              <span className="font-mono text-sm font-bold text-white" aria-label={`Exchange rate: 1 ${result.sourceAsset} equals approximately ${result.rate} ${result.destAsset}`}>
                1 {result.sourceAsset} ≈ {result.rate} {result.destAsset}
              </span>
            </div>

            {/* You send */}
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-slate-400">You send</span>
              <span className="font-mono text-sm text-white" aria-label={`You send ${result.sourceAmount} ${result.sourceAsset}`}>
                {result.sourceAmount} {result.sourceAsset}
              </span>
            </div>

            {/* You receive */}
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-slate-400">You receive</span>
              <span className="font-mono text-sm font-bold text-mint" aria-label={`You receive ${result.destAmount} ${result.destAsset}`}>
                {result.destAmount} {result.destAsset}
              </span>
            </div>

            {/* Slippage */}
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-slate-400">Slippage buffer</span>
              <span className="font-mono text-xs text-slate-400" aria-label={`Maximum slippage: ${(Number(result.sourceAmount) * (1 + SLIPPAGE)).toFixed(7)} ${result.sourceAsset}, which is ${(SLIPPAGE * 100).toFixed(0)} percent`}>
                ≤ {(Number(result.sourceAmount) * (1 + SLIPPAGE)).toFixed(7)} {result.sourceAsset} ({(SLIPPAGE * 100).toFixed(0)}%)
              </span>
            </div>

            {/* Path */}
            {result.path.length > 2 && (
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-slate-400">Path</span>
                <span className="font-mono text-xs text-slate-300" aria-label={`Conversion path: ${result.path.join(", then ")}`}>
                  {result.path.join(" → ")}
                </span>
              </div>
            )}

            {/* Staleness + refresh */}
            <div className="flex items-center justify-between border-t border-white/5 pt-2">
              <span className="text-[11px] text-slate-500" aria-live="off">
                Quoted {secondsAgo}s ago
              </span>
              <button
                type="button"
                onClick={convert}
                disabled={loading}
                className="flex items-center gap-1 text-[11px] text-mint transition-colors hover:text-glow disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-mint focus:ring-offset-2 focus:ring-offset-slate-900"
                aria-label="Refresh quote to get updated conversion rates"
              >
                <RefreshIcon className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
                Refresh
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="flex items-center gap-4 border-t border-white/10 px-4 py-2">
        <span className="flex items-center gap-1 text-[11px] text-slate-500">
          <kbd className="rounded border border-white/10 bg-white/5 px-1 py-0.5 font-mono text-[10px]">
            ↵
          </kbd>
          convert
        </span>
        <span className="flex items-center gap-1 text-[11px] text-slate-500">
          <kbd className="rounded border border-white/10 bg-white/5 px-1 py-0.5 font-mono text-[10px]">
            esc
          </kbd>
          back
        </span>
        {!activeProvider && (
          <span className="ml-auto text-[11px] text-amber-400/80">
            Wallet not connected
          </span>
        )}
      </div>
    </div>
  );
}
