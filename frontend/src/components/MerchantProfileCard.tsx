"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { Avatar } from "@/components/ui/Avatar";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  useMerchantMetadata,
  useMerchantLogout,
  useMerchantHydrated,
  useHydrateMerchantStore,
} from "@/lib/merchant-store";
import { MerchantProfileDropdownSkeleton } from "./MerchantProfileDropdown";

// Dynamic import for the profile dropdown menu to optimize bundle footprint
const MerchantProfileDropdown = dynamic(
  () => import("./MerchantProfileDropdown"),
  {
    loading: () => <MerchantProfileDropdownSkeleton />,
    ssr: false,
  }
);

export default function MerchantProfileCard() {
  const t = useTranslations("profileCard");
  const merchant = useMerchantMetadata();
  const logout = useMerchantLogout();
  const hydrated = useMerchantHydrated();
  const [showDropdown, setShowDropdown] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useHydrateMerchantStore();

  const handleClose = useCallback(() => {
    setShowDropdown(false);
    triggerRef.current?.focus();
  }, []);

  const handleLogout = useCallback(() => {
    logout();
    setShowDropdown(false);
    window.location.href = "/login";
  }, [logout]);

  // Close dropdown on Escape key if open
  useEffect(() => {
    if (!showDropdown) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showDropdown, handleClose]);

  if (!hydrated) {
    return (
      <div
        className="h-10 w-10 shrink-0 animate-pulse rounded-full border border-[#E8E8E8] bg-[#F0F0F0] sm:w-40"
        role="status"
        aria-label={t("loadingProfile")}
        data-testid="merchant-profile-loading"
      />
    );
  }

  if (!merchant) {
    return (
      <Link
        href="/login"
        data-testid="merchant-login-link"
        className="inline-flex h-10 items-center gap-2 rounded-full border border-[#E8E8E8] bg-white px-4 text-xs font-bold uppercase tracking-widest text-[#0A0A0A] transition-colors hover:bg-[#F5F5F5] focus:outline-none focus:ring-2 focus:ring-black"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M5.121 17.804A9 9 0 1118.879 17.804M15 11a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
        {t("account")}
      </Link>
    );
  }

  const displayName = merchant.business_name || merchant.email || "Merchant";
  const email = merchant.email || "";
  const avatarName = merchant.business_name || merchant.email || "Merchant";
  const logoUrl = merchant.logo_url || null;

  return (
    <div className="relative" data-testid="merchant-profile-card">
      <button
        ref={triggerRef}
        type="button"
        data-testid="merchant-profile-trigger"
        onClick={() => setShowDropdown((v) => !v)}
        className="group flex h-10 items-center gap-2.5 rounded-full border border-[#E8E8E8] bg-white px-2.5 pr-3.5 transition-all hover:border-[#DADADA] hover:bg-[#F8F8F8] focus:outline-none focus:ring-2 focus:ring-black"
        aria-label={t("openProfileMenu")}
        aria-expanded={showDropdown}
        aria-haspopup="true"
      >
        <Avatar
          size={30}
          name={avatarName}
          src={logoUrl}
        />
        <div className="hidden max-w-[170px] text-left sm:block">
          <p className="truncate text-xs font-bold text-[#0A0A0A]">
            {displayName}
          </p>
          <p className="truncate text-[10px] font-bold uppercase tracking-[0.18em] text-[#6B6B6B]">
            {email}
          </p>
        </div>
        <svg
          className={`h-3.5 w-3.5 text-[#8A8A8A] transition-transform duration-300 ${
            showDropdown ? "rotate-180" : ""
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2.5}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {showDropdown && (
        <MerchantProfileDropdown
          displayName={displayName}
          email={email}
          avatarName={avatarName}
          logoUrl={logoUrl}
          onClose={handleClose}
          onLogout={handleLogout}
        />
      )}
    </div>
  );
}
