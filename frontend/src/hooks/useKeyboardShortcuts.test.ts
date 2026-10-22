/**
 * Tests for useKeyboardShortcuts hook (#1566)
 */

import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts, formatShortcut, type KeyboardShortcut } from "./useKeyboardShortcuts";

describe("useKeyboardShortcuts", () => {
  let handleSubmit: jest.Mock;
  let handleClear: jest.Mock;

  beforeEach(() => {
    handleSubmit = jest.fn();
    handleClear = jest.fn();
  });

  it("should trigger submit handler on Ctrl+Enter", () => {
    const shortcuts: KeyboardShortcut[] = [
      {
        key: "Enter",
        ctrl: true,
        handler: handleSubmit,
        description: "Submit",
      },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
    });
    document.dispatchEvent(event);

    expect(handleSubmit).toHaveBeenCalledTimes(1);
  });

  it("should trigger clear handler on Cmd/Ctrl+K", () => {
    const shortcuts: KeyboardShortcut[] = [
      {
        key: "k",
        meta: true,
        handler: handleClear,
        description: "Clear",
      },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    const event = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
    });
    document.dispatchEvent(event);

    expect(handleClear).toHaveBeenCalledTimes(1);
  });

  it("should not trigger shortcuts when disabled", () => {
    const shortcuts: KeyboardShortcut[] = [
      {
        key: "Enter",
        ctrl: true,
        handler: handleSubmit,
        description: "Submit",
      },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts, { enabled: false }));

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
    });
    document.dispatchEvent(event);

    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it("should allow Escape to work even when input is focused", () => {
    const handleEscape = jest.fn();
    const shortcuts: KeyboardShortcut[] = [
      {
        key: "Escape",
        handler: handleEscape,
        description: "Close",
      },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    // Create and focus an input
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    const event = new KeyboardEvent("keydown", { key: "Escape" });
    document.dispatchEvent(event);

    expect(handleEscape).toHaveBeenCalled();

    document.body.removeChild(input);
  });

  it("should not trigger non-Escape shortcuts when input is focused", () => {
    const shortcuts: KeyboardShortcut[] = [
      {
        key: "Enter",
        handler: handleSubmit,
        description: "Submit",
      },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    // Create and focus an input
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    const event = new KeyboardEvent("keydown", { key: "Enter" });
    document.dispatchEvent(event);

    // Should not trigger without ctrl/meta modifier when input is focused
    expect(handleSubmit).not.toHaveBeenCalled();

    document.body.removeChild(input);
  });
});

describe("formatShortcut", () => {
  it("should format Ctrl+Enter correctly", () => {
    const shortcut: KeyboardShortcut = {
      key: "Enter",
      ctrl: true,
      handler: jest.fn(),
      description: "Submit",
    };

    const formatted = formatShortcut(shortcut);
    expect(formatted).toMatch(/Ctrl\+Enter|⌘\+Enter/);
  });

  it("should format Cmd+K correctly", () => {
    const shortcut: KeyboardShortcut = {
      key: "k",
      meta: true,
      handler: jest.fn(),
      description: "Clear",
    };

    const formatted = formatShortcut(shortcut);
    expect(formatted).toMatch(/⌘\+k|Cmd\+k/);
  });

  it("should format Escape correctly", () => {
    const shortcut: KeyboardShortcut = {
      key: "Escape",
      handler: jest.fn(),
      description: "Close",
    };

    const formatted = formatShortcut(shortcut);
    expect(formatted).toBe("Escape");
  });

  it("should handle Space key display", () => {
    const shortcut: KeyboardShortcut = {
      key: " ",
      handler: jest.fn(),
      description: "Play",
    };

    const formatted = formatShortcut(shortcut);
    expect(formatted).toBe("Space");
  });
});
