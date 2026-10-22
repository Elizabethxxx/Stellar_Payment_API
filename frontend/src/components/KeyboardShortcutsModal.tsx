'use client';

import { useEffect, useCallback, useState, useRef } from 'react';

export interface KeyboardShortcut {
  key: string;
  description: string;
  combo?: string[];
}

export interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
  shortcuts?: KeyboardShortcut[];
}

const defaultShortcuts: KeyboardShortcut[] = [
  { key: '?', description: 'Show keyboard shortcuts' },
  { key: 'Esc', description: 'Close modal or cancel action' },
  { key: 'p', description: 'Create new payment' },
  { key: 's', description: 'Search payments' },
  { combo: ['Ctrl', 'K'], description: 'Quick search' },
  { combo: ['Ctrl', 'Enter'], description: 'Submit form' },
];

/**
 * KeyboardShortcutsModal Component (#1558, #1559)
 *
 * Displays available keyboard shortcuts in an accessible modal dialog with:
 * - WCAG 2.1 AA focus trap and ARIA attributes (#1558)
 * - Responsive mobile drawer with touch gestures (#1559)
 */
export default function KeyboardShortcutsModal({
  isOpen,
  onClose,
  shortcuts = defaultShortcuts,
}: KeyboardShortcutsModalProps) {
  const [isMounted, setIsMounted] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number | null>(null);

  // WCAG 2.1 AA: Focus trap (#1558)
  const trapFocus = useCallback((event: KeyboardEvent) => {
    if (!modalRef.current || event.key !== 'Tab') return;
    const focusable = modalRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        event.preventDefault();
        onClose();
      }
      trapFocus(event);
    },
    [isOpen, onClose, trapFocus]
  );

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  // Touch gestures for mobile drawer (#1559)
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (touchStartY.current === null) return;
      const deltaY = e.changedTouches[0].clientY - touchStartY.current;
      // Swipe down to close on mobile
      if (deltaY > 50) onClose();
      touchStartY.current = null;
    },
    [onClose]
  );

  useEffect(() => {
    setIsMounted(true);
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
      const firstFocusable = modalRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      firstFocusable?.focus();
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, handleKeyDown]);

  if (!isMounted || !isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm"
      data-testid="shortcuts-modal-backdrop"
      role="presentation"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        aria-describedby="shortcuts-description"
        aria-labelledby="shortcuts-title"
        aria-modal="true"
        role="dialog"
        data-testid="shortcuts-modal"
        className="relative w-full max-w-2xl mx-4 bg-white dark:bg-gray-800 rounded-t-2xl sm:rounded-lg shadow-2xl max-h-[90vh] overflow-y-auto"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Mobile drag handle (#1559) */}
        <div className="sm:hidden flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-600" />
        </div>

        {/* Header */}
        <div className="sticky top-0 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-4 flex items-center justify-between">
          <h2
            className="text-xl sm:text-2xl font-semibold text-gray-900 dark:text-white"
            id="shortcuts-title"
          >
            Keyboard Shortcuts
          </h2>
          <button
            aria-label="Close keyboard shortcuts modal"
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
            data-testid="close-button"
            type="button"
            onClick={onClose}
          >
            <svg aria-hidden="true" className="w-6 h-6 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
            </svg>
          </button>
        </div>

        <p className="px-6 pt-4 text-sm text-gray-600 dark:text-gray-400" id="shortcuts-description">
          Use these keyboard shortcuts to navigate and perform actions quickly.
        </p>

        <div className="px-6 py-4 space-y-2">
          {shortcuts.map((shortcut, index) => (
            <div
              key={index}
              className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-700 last:border-0"
              data-testid={`shortcut-item-${index}`}
            >
              <span className="text-gray-700 dark:text-gray-300">{shortcut.description}</span>
              <div className="flex gap-1">
                {shortcut.combo ? (
                  shortcut.combo.map((key, i) => (
                    <kbd key={i} className="px-3 py-1.5 text-sm font-semibold text-gray-800 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded shadow-sm" data-testid={`shortcut-key-${index}-${i}`}>
                      {key}
                    </kbd>
                  ))
                ) : (
                  <kbd className="px-3 py-1.5 text-sm font-semibold text-gray-800 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded shadow-sm" data-testid={`shortcut-key-${index}`}>
                    {shortcut.key}
                  </kbd>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="sticky bottom-0 bg-gray-50 dark:bg-gray-900 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
            Press <kbd className="px-2 py-1 text-xs font-semibold bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded">?</kbd> to toggle this modal
          </p>
        </div>
      </div>
    </div>
  );
}
