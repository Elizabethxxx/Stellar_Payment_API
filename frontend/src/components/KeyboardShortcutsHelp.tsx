/**
 * KeyboardShortcutsHelp component
 *
 * Displays available keyboard shortcuts in a tooltip or modal.
 * Helps users discover and learn keyboard navigation.
 *
 * #1566 - Enhance keyboard navigation and shortcut bindings
 */

"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { formatShortcut, type KeyboardShortcut } from "@/hooks/useKeyboardShortcuts";

interface KeyboardShortcutsHelpProps {
  shortcuts: KeyboardShortcut[];
  /**
   * Button label. Defaults to "?".
   */
  label?: string;
  /**
   * Position of the tooltip. Defaults to "top".
   */
  position?: "top" | "bottom" | "left" | "right";
}

/**
 * Displays keyboard shortcuts help in a compact tooltip.
 *
 * @example
 * ```tsx
 * <KeyboardShortcutsHelp
 *   shortcuts={[
 *     { key: "Enter", ctrl: true, handler: submit, description: "Submit form" },
 *     { key: "k", meta: true, handler: clear, description: "Clear form" }
 *   ]}
 * />
 * ```
 */
export function KeyboardShortcutsHelp({
  shortcuts,
  label = "?",
  position = "top",
}: KeyboardShortcutsHelpProps) {
  const [isOpen, setIsOpen] = useState(false);

  const positionStyles = {
    top: "bottom-full mb-2 left-1/2 -translate-x-1/2",
    bottom: "top-full mt-2 left-1/2 -translate-x-1/2",
    left: "right-full mr-2 top-1/2 -translate-y-1/2",
    right: "left-full ml-2 top-1/2 -translate-y-1/2",
  };

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => setIsOpen(false)}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setIsOpen(false)}
        className="flex h-6 w-6 items-center justify-center rounded-full bg-white/5 text-xs text-slate-400 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/50"
        aria-label="Keyboard shortcuts help"
        tabIndex={0}
      >
        {label}
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className={`absolute z-50 ${positionStyles[position]} w-max`}
          >
            <div className="rounded-lg border border-white/10 bg-slate-900/95 p-3 shadow-xl backdrop-blur-sm">
              <div className="mb-2 text-xs font-semibold text-white">Keyboard Shortcuts</div>
              <div className="space-y-1.5">
                {shortcuts.map((shortcut, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between gap-4 text-xs"
                  >
                    <span className="text-slate-400">{shortcut.description}</span>
                    <kbd className="inline-flex items-center rounded border border-white/20 bg-white/5 px-1.5 py-0.5 font-mono text-xs text-white">
                      {formatShortcut(shortcut)}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
