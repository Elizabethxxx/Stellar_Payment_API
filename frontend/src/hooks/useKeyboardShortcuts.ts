/**
 * useKeyboardShortcuts hook
 *
 * Provides keyboard shortcut bindings for forms and interactive components.
 * Supports common shortcuts like Cmd/Ctrl+Enter (submit), Cmd/Ctrl+K (clear),
 * and Escape (cancel/close).
 *
 * #1566 - Enhance keyboard navigation and shortcut bindings
 */

import { useEffect, useCallback } from "react";

export interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  meta?: boolean; // Cmd on Mac
  shift?: boolean;
  alt?: boolean;
  handler: (e: KeyboardEvent) => void;
  description: string;
}

export interface KeyboardShortcutsOptions {
  /**
   * Enable keyboard shortcuts. Defaults to true.
   * Set to false to temporarily disable shortcuts.
   */
  enabled?: boolean;
  /**
   * Target element to attach listeners to. Defaults to document.
   */
  target?: HTMLElement | Document;
}

/**
 * Hook to register keyboard shortcuts for a component.
 *
 * @param shortcuts - Array of keyboard shortcut configurations
 * @param options - Optional configuration (enabled state, target element)
 *
 * @example
 * ```tsx
 * useKeyboardShortcuts([
 *   {
 *     key: "Enter",
 *     ctrl: true,
 *     handler: (e) => {
 *       e.preventDefault();
 *       handleSubmit();
 *     },
 *     description: "Submit form"
 *   },
 *   {
 *     key: "k",
 *     meta: true,
 *     handler: (e) => {
 *       e.preventDefault();
 *       handleClear();
 *     },
 *     description: "Clear form"
 *   }
 * ]);
 * ```
 */
export function useKeyboardShortcuts(
  shortcuts: KeyboardShortcut[],
  options: KeyboardShortcutsOptions = {}
) {
  const { enabled = true, target = typeof document !== "undefined" ? document : null } = options;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return;

      // Don't trigger shortcuts when user is typing in an input (except for Escape)
      const activeElement = document.activeElement;
      const isInputFocused =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement instanceof HTMLSelectElement ||
        activeElement?.hasAttribute("contenteditable");

      for (const shortcut of shortcuts) {
        const keyMatches = e.key.toLowerCase() === shortcut.key.toLowerCase();
        const ctrlMatches = shortcut.ctrl ? e.ctrlKey : true;
        const metaMatches = shortcut.meta ? e.metaKey : true;
        const shiftMatches = shortcut.shift ? e.shiftKey : !e.shiftKey;
        const altMatches = shortcut.alt ? e.altKey : !e.altKey;

        // Allow Escape to work even in inputs
        const shouldTrigger =
          e.key === "Escape" ||
          !isInputFocused ||
          (shortcut.ctrl || shortcut.meta);

        if (
          keyMatches &&
          ctrlMatches &&
          metaMatches &&
          shiftMatches &&
          altMatches &&
          shouldTrigger
        ) {
          shortcut.handler(e);
          break; // Only trigger the first matching shortcut
        }
      }
    },
    [shortcuts, enabled]
  );

  useEffect(() => {
    if (!target || !enabled) return;

    target.addEventListener("keydown", handleKeyDown as EventListener);

    return () => {
      target.removeEventListener("keydown", handleKeyDown as EventListener);
    };
  }, [handleKeyDown, target, enabled]);
}

/**
 * Format a keyboard shortcut for display.
 *
 * @param shortcut - The keyboard shortcut configuration
 * @returns A human-readable string like "⌘+K" or "Ctrl+Enter"
 */
export function formatShortcut(shortcut: KeyboardShortcut): string {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const parts: string[] = [];

  if (shortcut.ctrl && !isMac) parts.push("Ctrl");
  if (shortcut.meta || (shortcut.ctrl && isMac)) parts.push(isMac ? "⌘" : "Cmd");
  if (shortcut.alt) parts.push(isMac ? "⌥" : "Alt");
  if (shortcut.shift) parts.push(isMac ? "⇧" : "Shift");

  const keyDisplay = shortcut.key === " " ? "Space" : shortcut.key;
  parts.push(keyDisplay);

  return parts.join("+");
}
