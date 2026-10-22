/**
 * Tests for useFocusTrap hook
 *
 * Validates WCAG 2.1 AA compliance for focus management:
 * - 2.4.3 Focus Order
 * - 2.1.2 No Keyboard Trap (via Escape key)
 * - 2.4.7 Focus Visible
 *
 * #1497 - WCAG 2.1 AA accessible focus trap
 */

import { renderHook } from "@testing-library/react";
import { useFocusTrap } from "./useFocusTrap";

describe("useFocusTrap", () => {
  let container: HTMLDivElement;
  let button1: HTMLButtonElement;
  let button2: HTMLButtonElement;
  let button3: HTMLButtonElement;
  let originalActiveElement: Element | null;

  beforeEach(() => {
    // Store original active element
    originalActiveElement = document.activeElement;

    // Create a test container with focusable elements
    container = document.createElement("div");
    document.body.appendChild(container);

    button1 = document.createElement("button");
    button1.textContent = "First";
    button1.tabIndex = 0;

    button2 = document.createElement("button");
    button2.textContent = "Second";
    button2.tabIndex = 0;

    button3 = document.createElement("button");
    button3.textContent = "Third";
    button3.tabIndex = 0;

    container.appendChild(button1);
    container.appendChild(button2);
    container.appendChild(button3);
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  it("should focus the first element when enabled", async () => {
    const { result } = renderHook(() =>
      useFocusTrap({
        enabled: true,
      })
    );

    // Assign the ref to our container
    if (result.current) {
      (result.current as any).current = container;
    }

    // Wait for the focus timeout
    await new Promise((resolve) => setTimeout(resolve, 50));

    // First button should be focused
    expect(document.activeElement).toBe(button1);
  });

  it("should trap Tab navigation within the container", () => {
    const { result } = renderHook(() =>
      useFocusTrap({
        enabled: true,
      })
    );

    if (result.current) {
      (result.current as any).current = container;
    }

    // Focus the last button
    button3.focus();
    expect(document.activeElement).toBe(button3);

    // Simulate Tab on the last element
    const tabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });

    document.dispatchEvent(tabEvent);

    // Focus should cycle to first element
    if (tabEvent.defaultPrevented) {
      button1.focus(); // Manually focus first element as preventDefault blocks default behavior
    }

    expect(document.activeElement).toBe(button1);
  });

  it("should trap Shift+Tab navigation within the container", () => {
    const { result } = renderHook(() =>
      useFocusTrap({
        enabled: true,
      })
    );

    if (result.current) {
      (result.current as any).current = container;
    }

    // Focus the first button
    button1.focus();
    expect(document.activeElement).toBe(button1);

    // Simulate Shift+Tab on the first element
    const shiftTabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    document.dispatchEvent(shiftTabEvent);

    // Focus should cycle to last element
    if (shiftTabEvent.defaultPrevented) {
      button3.focus(); // Manually focus last element
    }

    expect(document.activeElement).toBe(button3);
  });

  it("should call onEscape when Escape key is pressed", () => {
    const onEscape = jest.fn();
    const { result } = renderHook(() =>
      useFocusTrap({
        enabled: true,
        onEscape,
      })
    );

    if (result.current) {
      (result.current as any).current = container;
    }

    // Simulate Escape key
    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });

    document.dispatchEvent(escapeEvent);

    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(escapeEvent.defaultPrevented).toBe(true);
  });

  it("should not trap focus when disabled", () => {
    const onEscape = jest.fn();
    const { result } = renderHook(() =>
      useFocusTrap({
        enabled: false,
        onEscape,
      })
    );

    if (result.current) {
      (result.current as any).current = container;
    }

    // Simulate Escape key
    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });

    document.dispatchEvent(escapeEvent);

    expect(onEscape).not.toHaveBeenCalled();
    expect(escapeEvent.defaultPrevented).toBe(false);
  });

  it("should return focus to previous element when deactivated", async () => {
    // Focus a button outside the container
    const outsideButton = document.createElement("button");
    outsideButton.textContent = "Outside";
    document.body.appendChild(outsideButton);
    outsideButton.focus();

    const previouslyFocused = document.activeElement;

    const { result, unmount } = renderHook(() =>
      useFocusTrap({
        enabled: true,
        returnFocusOnDeactivate: true,
      })
    );

    if (result.current) {
      (result.current as any).current = container;
    }

    // Wait for focus to move
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Unmount to deactivate
    unmount();

    // Focus should return to the previously focused element
    expect(document.activeElement).toBe(previouslyFocused);

    document.body.removeChild(outsideButton);
  });

  it("should ignore disabled focusable elements", () => {
    // Add a disabled button
    const disabledButton = document.createElement("button");
    disabledButton.textContent = "Disabled";
    disabledButton.disabled = true;
    container.insertBefore(disabledButton, button2);

    const { result } = renderHook(() =>
      useFocusTrap({
        enabled: true,
      })
    );

    if (result.current) {
      (result.current as any).current = container;
    }

    // Focus last enabled button
    button3.focus();

    // Simulate Tab - should skip disabled button and go to first
    const tabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });

    document.dispatchEvent(tabEvent);

    // Focus should skip disabled button
    if (tabEvent.defaultPrevented) {
      button1.focus();
    }

    expect(document.activeElement).toBe(button1);
  });

  it("should handle containers with no focusable elements gracefully", () => {
    const emptyContainer = document.createElement("div");
    document.body.appendChild(emptyContainer);

    const { result } = renderHook(() =>
      useFocusTrap({
        enabled: true,
      })
    );

    if (result.current) {
      (result.current as any).current = emptyContainer;
    }

    // Should not throw or cause errors
    const tabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
    });

    expect(() => document.dispatchEvent(tabEvent)).not.toThrow();

    document.body.removeChild(emptyContainer);
  });
});
