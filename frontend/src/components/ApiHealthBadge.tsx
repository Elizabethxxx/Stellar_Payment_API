/**
 * Api Health Badge component (#1548, #1549).
 *
 * Displays API health status with responsive mobile drawer, touch gestures,
 * and WCAG 2.1 AA accessible focus trap and ARIA attributes.
 */

import React, { useState, useRef, useEffect, useCallback } from "react";

interface ApiHealthBadgeProps {
  status: "healthy" | "degraded" | "down";
  message?: string;
  className?: string;
}

export function ApiHealthBadge({ status, message, className = "" }: ApiHealthBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const statusColors = {
    healthy: "bg-green-500",
    degraded: "bg-yellow-500",
    down: "bg-red-500",
  };

  const statusLabels = {
    healthy: "Healthy",
    degraded: "Degraded",
    down: "Down",
  };

  // Focus trap for WCAG 2.1 AA (#1548)
  useEffect(() => {
    if (!isOpen) return;

    const focusableElements = drawerRef.current?.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements?.[0] as HTMLElement;
    const lastElement = focusableElements?.[focusableElements.length - 1] as HTMLElement;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
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
  }, [isOpen]);

  // Touch gestures for mobile drawer (#1549)
  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchStart(e.touches[0].clientY);
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStart === null) return;
    const touchEnd = e.changedTouches[0].clientY;
    const diff = touchStart - touchEnd;

    // Swipe up to open, swipe down to close
    if (diff > 50 && !isOpen) setIsOpen(true);
    if (diff < -50 && isOpen) setIsOpen(false);
    setTouchStart(null);
  };

  return (
    <div className={`relative ${className}`}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        aria-expanded={isOpen}
        aria-controls="api-health-drawer"
        aria-haspopup="dialog"
        aria-label={`API Status: ${statusLabels[status]}${message ? `. ${message}` : ""}`}
        className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-gray-200 hover:border-gray-300 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <span
          className={`w-2 h-2 rounded-full ${statusColors[status]}`}
          aria-hidden="true"
        />
        <span className="text-sm font-medium">{statusLabels[status]}</span>
      </button>

      {/* Mobile drawer */}
      <div
        ref={drawerRef}
        id="api-health-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="api-health-drawer-title"
        className={`
          fixed inset-x-0 bottom-0 z-50 transform transition-transform duration-300 ease-in-out
          bg-white rounded-t-2xl shadow-2xl p-6
          ${isOpen ? "translate-y-0" : "translate-y-full"}
          md:absolute md:inset-auto md:top-full md:right-0 md:w-72 md:rounded-2xl md:shadow-lg
          ${isOpen ? "md:opacity-100 md:pointer-events-auto" : "md:opacity-0 md:pointer-events-none"}
        `}
        style={{ maxHeight: "80vh" }}
      >
        {/* Drag handle for mobile */}
        <div
          className="w-12 h-1 bg-gray-300 rounded-full mx-auto mb-4 md:hidden"
          aria-hidden="true"
        />

        <h3 id="api-health-drawer-title" className="text-lg font-semibold mb-3">
          API Health Status
        </h3>

        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span
              className={`w-3 h-3 rounded-full ${statusColors[status]}`}
              aria-hidden="true"
            />
            <div>
              <p className="font-medium">{statusLabels[status]}</p>
              {message && (
                <p className="text-sm text-gray-600">{message}</p>
              )}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            setIsOpen(false);
            triggerRef.current?.focus();
          }}
          className="mt-4 w-full px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          Close
        </button>
      </div>

      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-40 md:hidden"
          onClick={() => {
            setIsOpen(false);
            triggerRef.current?.focus();
          }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export default ApiHealthBadge;
