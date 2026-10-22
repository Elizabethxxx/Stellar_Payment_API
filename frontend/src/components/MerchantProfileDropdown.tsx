"use client";

import React, { useEffect, useRef } from "react";
import Link from "next/link";
import { Avatar } from "@/components/ui/Avatar";
import { useTranslations } from "next-intl";

export interface MerchantProfileDropdownProps {
  displayName: string;
  email: string;
  avatarName: string;
  logoUrl: string | null;
  onClose: () => void;
  onLogout: () => void;
}

export function MerchantProfileDropdownSkeleton() {
  return (
    <div
      data-testid="merchant-dropdown-skeleton"
      className="fixed inset-x-0 bottom-0 z-50 w-full rounded-t-3xl border-t border-[#E8E8E8] bg-white p-5 shadow-2xl animate-pulse sm:absolute sm:inset-auto sm:right-0 sm:top-full sm:mt-3 sm:w-72 sm:origin-top-right sm:rounded-2xl sm:border sm:shadow-[0_20px_50px_rgba(0,0,0,0.12)]"
      role="status"
      aria-label="Loading profile details"
    >
      <div className="flex justify-center pt-1 pb-3 sm:hidden" aria-hidden="true">
        <div className="h-1.5 w-12 rounded-full bg-slate-300 dark:bg-slate-600" />
      </div>
      <div className="mb-5 flex items-center gap-3.5 border-b border-[#F0F0F0] pb-5">
        <div className="h-[52px] w-[52px] rounded-full bg-slate-200" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-4 w-3/4 rounded bg-slate-200" />
          <div className="h-3 w-1/2 rounded bg-slate-200" />
        </div>
      </div>
      <div className="space-y-2">
        <div className="h-9 w-full rounded-xl bg-slate-100" />
        <div className="h-9 w-full rounded-xl bg-slate-100" />
        <div className="h-9 w-full rounded-xl bg-slate-100" />
      </div>
    </div>
  );
}

export default function MerchantProfileDropdown({
  displayName,
  email,
  avatarName,
  logoUrl,
  onClose,
  onLogout,
}: MerchantProfileDropdownProps) {
  const t = useTranslations("profileCard");
  const menuRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number | null>(null);

  // Touch gesture support for mobile drawer dismiss (#1667)
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return;
    const deltaY = e.changedTouches[0].clientY - touchStartY.current;
    // Swipe down 50px+ dismisses the drawer on mobile
    if (deltaY > 50) {
      onClose();
    }
    touchStartY.current = null;
  };

  // Close on Escape key and focus trap within menu
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === "Tab" && menuRef.current) {
        const focusable = menuRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-xs transition-opacity sm:bg-black/10 sm:backdrop-blur-[1px]"
        data-testid="merchant-profile-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Menu Panel / Responsive Drawer */}
      <div
        ref={menuRef}
        data-testid="merchant-profile-menu"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className="fixed inset-x-0 bottom-0 z-50 w-full max-h-[85vh] overflow-y-auto rounded-t-3xl border-t border-[#E8E8E8] bg-white p-5 shadow-2xl transition-all sm:absolute sm:inset-auto sm:right-0 sm:top-full sm:mt-3 sm:w-72 sm:max-h-none sm:origin-top-right sm:rounded-2xl sm:border sm:shadow-[0_20px_50px_rgba(0,0,0,0.12)]"
        role="menu"
        aria-orientation="vertical"
        aria-label="Merchant Account Navigation"
      >
        {/* Mobile Drag Handle Indicator */}
        <div
          className="flex justify-center pt-1 pb-3 sm:hidden"
          data-testid="merchant-drawer-handle"
          aria-hidden="true"
        >
          <div className="h-1.5 w-12 rounded-full bg-slate-300 dark:bg-slate-600" />
        </div>

        {/* Profile Header */}
        <div className="mb-5 flex items-center gap-3.5 border-b border-[#F0F0F0] pb-5">
          <Avatar size={52} name={avatarName} src={logoUrl} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-bold text-[#0A0A0A]">
              {displayName}
            </p>
            <p className="truncate text-[10px] font-bold text-[#6B6B6B] uppercase tracking-[0.16em]">
              {email}
            </p>
          </div>
        </div>

        {/* Menu Items */}
        <div className="flex flex-col gap-1.5">
          <Link
            href="/dashboard"
            onClick={onClose}
            role="menuitem"
            data-testid="merchant-menu-dashboard"
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-xs font-bold uppercase tracking-widest text-[#0A0A0A] bg-[#F5F5F5] transition-all hover:bg-[#E8E8E8] focus:outline-none focus:ring-2 focus:ring-black"
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
                d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
              />
            </svg>
            {t("dashboard")}
          </Link>

          <Link
            href="/settings"
            onClick={onClose}
            role="menuitem"
            data-testid="merchant-menu-settings"
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-xs font-bold uppercase tracking-widest text-[#6B6B6B] transition-all hover:bg-[#F5F5F5] hover:text-[#0A0A0A] focus:outline-none focus:ring-2 focus:ring-black"
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
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            {t("settings")}
          </Link>

          <Link
            href="/dashboard/create"
            onClick={onClose}
            role="menuitem"
            data-testid="merchant-menu-create-payment"
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-xs font-bold uppercase tracking-widest text-[#6B6B6B] transition-all hover:bg-[#F5F5F5] hover:text-[#0A0A0A] focus:outline-none focus:ring-2 focus:ring-black"
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
                d="M12 4v16m8-8H4"
              />
            </svg>
            {t("createPayment")}
          </Link>

          <button
            type="button"
            onClick={onLogout}
            role="menuitem"
            data-testid="merchant-menu-logout"
            className="mt-2 flex items-center gap-3 rounded-xl bg-red-50 px-3 py-2.5 text-xs font-bold uppercase tracking-widest text-red-600 transition-all hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-500"
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
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
            {t("logoutAccount")}
          </button>
        </div>
      </div>
    </>
  );
}
