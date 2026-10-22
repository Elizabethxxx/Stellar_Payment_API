/**
 * Lazy-loaded MerchantProfileCard
 * Issue #1669: Optimize bundle footprint and code splitting via dynamic imports for Merchant Profile Card
 *
 * This module provides dynamic imports for the MerchantProfileCard component
 * to reduce the initial bundle size of the layout and navigation bars.
 */

"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";

export function MerchantProfileCardSkeleton() {
  return (
    <div
      data-testid="merchant-profile-card-skeleton"
      className="h-10 w-10 shrink-0 animate-pulse rounded-full border border-[#E8E8E8] bg-[#F0F0F0] sm:w-40"
      role="status"
      aria-label="Loading profile…"
    />
  );
}

const MerchantProfileCardComponent = dynamic(
  () => import("./MerchantProfileCard"),
  {
    loading: () => <MerchantProfileCardSkeleton />,
    ssr: false,
  }
) as ComponentType<Record<string, never>>;

export default MerchantProfileCardComponent;
