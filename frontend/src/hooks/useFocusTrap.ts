/**
 * useFocusTrap hook
 *
 * WCAG 2.1 AA compliant focus trap for modal dialogs and panels.
 * Implements focus management per WCAG 2.4.3 (Focus Order) and 2.1.2 (No Keyboard Trap).
 *
 * #1497 - Implement WCAG 2.1 AA accessible focus trap
 */

import { useEffect, useRef, useCallback } from "react";

interface UseFocusTrapOptions {
  /**
   * Whether the trap is active. When false, focus management is disabled.
   */
  enabled: boolean;
  /**
   * Callback invoked when Escape key is pressed.
   */
  onEscape?: () => void;
  /**
   * Element to focus when the trap is disabled.
   * Defaults to the element that had focus when the trap was enabled.
   */
  returnFocusOnDeactivate?: boolean;
}

/**
 * Selector for all focusable elements per WCAG guidelines.
 * Includes standard interactive elements and any element with tabindex >= 0.
 */
const FOCUSABLE_ELEMENTS = [
  'a[href]',
  'area[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable]',
  '[tabindex]:not([tabindex^="-"])',
].join(',');

/**
 * Custom hook for implementing WCAG 2.1 AA compliant focus trap.
 *
 * @param options Configuration options
 * @returns Ref to attach to the container element
 *
 * @example
 * ```tsx
 * function Dialog({ isOpen, onClose }) {
 *   const trapRef = useFocusTrap({
 *     enabled: isOpen,
 *     onEscape: onClose,
 *   });
 *
 *   if (!isOpen) return null;
 *
 *   return (
 *     <div ref={trapRef} role="dialog" aria-modal="true">
 *       {content}
 *     </div>
 *   );
 * }
 * ```
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  options: UseFocusTrapOptions
) {
  const { enabled, onEscape, returnFocusOnDeactivate = true } = options;
  const containerRef = useRef<T>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  /**
   * Get all focusable elements within the container.
   */
  const getFocusableElements = useCallback((): HTMLElement[] => {
    if (!containerRef.current) return [];

    const elements = containerRef.current.querySelectorAll<HTMLElement>(
      FOCUSABLE_ELEMENTS
    );

    return Array.from(elements).filter(
      (el) => !el.hasAttribute('disabled') && el.offsetParent !== null
    );
  }, []);

  /**
   * Handle Tab key navigation to create the focus trap.
   */
  const handleTabKey = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled || event.key !== 'Tab') return;

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      // Shift + Tab on first element -> focus last
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
        return;
      }

      // Tab on last element -> focus first
      if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
        return;
      }
    },
    [enabled, getFocusableElements]
  );

  /**
   * Handle Escape key to close the trap.
   */
  const handleEscapeKey = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled || event.key !== 'Escape') return;

      event.preventDefault();
      onEscape?.();
    },
    [enabled, onEscape]
  );

  /**
   * Set up focus trap when enabled.
   */
  useEffect(() => {
    if (!enabled) return;

    // Store the currently focused element to return focus later
    previousActiveElement.current = document.activeElement as HTMLElement;

    // Focus the first focusable element in the container
    const focusableElements = getFocusableElements();
    if (focusableElements.length > 0) {
      // Small delay to ensure the container is rendered and positioned
      const timer = setTimeout(() => {
        focusableElements[0].focus();
      }, 10);

      return () => clearTimeout(timer);
    }
  }, [enabled, getFocusableElements]);

  /**
   * Return focus when trap is deactivated.
   */
  useEffect(() => {
    return () => {
      if (returnFocusOnDeactivate && previousActiveElement.current) {
        previousActiveElement.current.focus();
      }
    };
  }, [returnFocusOnDeactivate]);

  /**
   * Set up keyboard event listeners.
   */
  useEffect(() => {
    if (!enabled) return;

    document.addEventListener('keydown', handleTabKey);
    document.addEventListener('keydown', handleEscapeKey);

    return () => {
      document.removeEventListener('keydown', handleTabKey);
      document.removeEventListener('keydown', handleEscapeKey);
    };
  }, [enabled, handleTabKey, handleEscapeKey]);

  return containerRef;
}
