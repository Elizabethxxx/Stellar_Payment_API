/**
 * Comprehensive unit and snapshot tests for KeyboardShortcutsModal
 *
 * Test coverage:
 * - Component rendering and visibility
 * - User interactions (clicks, keyboard events)
 * - Accessibility features
 * - Mobile responsiveness
 * - State transitions
 * - Edge cases
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KeyboardShortcutsModal, { KeyboardShortcut } from '../KeyboardShortcutsModal';

describe('KeyboardShortcutsModal', () => {
  const mockOnClose = jest.fn();

  const defaultProps = {
    isOpen: true,
    onClose: mockOnClose,
  };

  const customShortcuts: KeyboardShortcut[] = [
    { key: 'a', description: 'Action A' },
    { combo: ['Ctrl', 'B'], description: 'Action B' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset body overflow style
    document.body.style.overflow = '';
  });

  afterEach(() => {
    // Clean up body overflow
    document.body.style.overflow = '';
  });

  describe('Rendering', () => {
    it('should render modal when isOpen is true', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      expect(screen.getByTestId('shortcuts-modal')).toBeInTheDocument();
      expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
    });

    it('should not render modal when isOpen is false', () => {
      render(<KeyboardShortcutsModal {...defaultProps} isOpen={false} />);

      expect(screen.queryByTestId('shortcuts-modal')).not.toBeInTheDocument();
    });

    it('should render default shortcuts when no shortcuts prop is provided', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      expect(screen.getByText('Show keyboard shortcuts')).toBeInTheDocument();
      expect(screen.getByText('Close modal or cancel action')).toBeInTheDocument();
      expect(screen.getByText('Create new payment')).toBeInTheDocument();
    });

    it('should render custom shortcuts when provided', () => {
      render(<KeyboardShortcutsModal {...defaultProps} shortcuts={customShortcuts} />);

      expect(screen.getByText('Action A')).toBeInTheDocument();
      expect(screen.getByText('Action B')).toBeInTheDocument();
      expect(screen.queryByText('Show keyboard shortcuts')).not.toBeInTheDocument();
    });

    it('should render keyboard shortcut keys correctly', () => {
      render(<KeyboardShortcutsModal {...defaultProps} shortcuts={customShortcuts} />);

      const singleKey = screen.getByTestId('shortcut-key-0');
      expect(singleKey).toHaveTextContent('a');

      const comboKey1 = screen.getByTestId('shortcut-key-1-0');
      const comboKey2 = screen.getByTestId('shortcut-key-1-1');
      expect(comboKey1).toHaveTextContent('Ctrl');
      expect(comboKey2).toHaveTextContent('B');
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA attributes', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      const modal = screen.getByTestId('shortcuts-modal');
      expect(modal).toHaveAttribute('role', 'dialog');
      expect(modal).toHaveAttribute('aria-modal', 'true');
      expect(modal).toHaveAttribute('aria-labelledby', 'shortcuts-title');
      expect(modal).toHaveAttribute('aria-describedby', 'shortcuts-description');
    });

    it('should have accessible close button', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      const closeButton = screen.getByTestId('close-button');
      expect(closeButton).toHaveAttribute('aria-label', 'Close keyboard shortcuts modal');
      expect(closeButton).toHaveAttribute('type', 'button');
    });

    it('should focus close button when modal opens', async () => {
      const { rerender } = render(<KeyboardShortcutsModal {...defaultProps} isOpen={false} />);

      rerender(<KeyboardShortcutsModal {...defaultProps} isOpen={true} />);

      await waitFor(() => {
        const closeButton = screen.getByTestId('close-button');
        expect(closeButton).toHaveFocus();
      });
    });

    it('should have semantic HTML structure', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    });
  });

  describe('User Interactions', () => {
    it('should call onClose when close button is clicked', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      const closeButton = screen.getByTestId('close-button');
      fireEvent.click(closeButton);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('should call onClose when backdrop is clicked', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      const backdrop = screen.getByTestId('shortcuts-modal-backdrop');
      fireEvent.click(backdrop);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('should not call onClose when modal content is clicked', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      const modal = screen.getByTestId('shortcuts-modal');
      fireEvent.click(modal);

      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it('should call onClose when Escape key is pressed', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('should not call onClose on other key presses', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      fireEvent.keyDown(document, { key: 'Enter' });
      fireEvent.keyDown(document, { key: 'a' });

      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });

  describe('Body Scroll Prevention', () => {
    it('should prevent body scroll when modal is open', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      expect(document.body.style.overflow).toBe('hidden');
    });

    it('should restore body scroll when modal is closed', () => {
      const { rerender } = render(<KeyboardShortcutsModal {...defaultProps} />);

      rerender(<KeyboardShortcutsModal {...defaultProps} isOpen={false} />);

      expect(document.body.style.overflow).toBe('');
    });

    it('should clean up body scroll on unmount', () => {
      const { unmount } = render(<KeyboardShortcutsModal {...defaultProps} />);

      unmount();

      expect(document.body.style.overflow).toBe('');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty shortcuts array', () => {
      render(<KeyboardShortcutsModal {...defaultProps} shortcuts={[]} />);

      expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
      expect(screen.queryAllByTestId(/^shortcut-item-/)).toHaveLength(0);
    });

    it('should handle multiple rapid open/close transitions', () => {
      const { rerender } = render(<KeyboardShortcutsModal {...defaultProps} isOpen={false} />);

      for (let i = 0; i < 5; i++) {
        rerender(<KeyboardShortcutsModal {...defaultProps} isOpen={true} />);
        rerender(<KeyboardShortcutsModal {...defaultProps} isOpen={false} />);
      }

      expect(document.body.style.overflow).toBe('');
    });

    it('should not crash with undefined onClose', () => {
      const propsWithoutOnClose = { ...defaultProps, onClose: undefined as any };

      // Should not throw
      expect(() => {
        render(<KeyboardShortcutsModal {...propsWithoutOnClose} />);
      }).not.toThrow();
    });

    it('should handle shortcuts with long descriptions', () => {
      const longShortcuts: KeyboardShortcut[] = [
        { key: 'x', description: 'A'.repeat(100) },
      ];

      render(<KeyboardShortcutsModal {...defaultProps} shortcuts={longShortcuts} />);

      expect(screen.getByText('A'.repeat(100))).toBeInTheDocument();
    });
  });

  describe('Responsive Behavior', () => {
    it('should have responsive container classes', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      const modal = screen.getByTestId('shortcuts-modal');
      expect(modal).toHaveClass('w-full', 'max-w-2xl', 'mx-4');
    });

    it('should have scrollable content when height exceeds viewport', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      const modal = screen.getByTestId('shortcuts-modal');
      expect(modal).toHaveClass('max-h-[90vh]', 'overflow-y-auto');
    });
  });

  describe('Visual Feedback', () => {
    it('should have hover states on close button', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      const closeButton = screen.getByTestId('close-button');
      expect(closeButton).toHaveClass('hover:bg-gray-100');
    });

    it('should have focus ring on close button', () => {
      render(<KeyboardShortcutsModal {...defaultProps} />);

      const closeButton = screen.getByTestId('close-button');
      expect(closeButton).toHaveClass('focus:ring-2', 'focus:ring-blue-500');
    });

    it('should style kbd elements consistently', () => {
      render(<KeyboardShortcutsModal {...defaultProps} shortcuts={customShortcuts} />);

      const kbdElements = screen.getAllByText(/^(a|Ctrl|B)$/);
      kbdElements.forEach(kbd => {
        expect(kbd.tagName).toBe('KBD');
        expect(kbd).toHaveClass('bg-gray-100');
      });
    });
  });

  describe('Snapshot Tests', () => {
    it('should match snapshot with default props', () => {
      const { container } = render(<KeyboardShortcutsModal {...defaultProps} />);
      expect(container.firstChild).toMatchSnapshot();
    });

    it('should match snapshot when closed', () => {
      const { container } = render(<KeyboardShortcutsModal {...defaultProps} isOpen={false} />);
      expect(container.firstChild).toMatchSnapshot();
    });

    it('should match snapshot with custom shortcuts', () => {
      const { container } = render(
        <KeyboardShortcutsModal {...defaultProps} shortcuts={customShortcuts} />
      );
      expect(container.firstChild).toMatchSnapshot();
    });

    it('should match snapshot with empty shortcuts', () => {
      const { container } = render(
        <KeyboardShortcutsModal {...defaultProps} shortcuts={[]} />
      );
      expect(container.firstChild).toMatchSnapshot();
    });

    it('should match snapshot with dark mode classes', () => {
      const { container } = render(<KeyboardShortcutsModal {...defaultProps} />);

      // Verify dark mode classes are present
      const modal = screen.getByTestId('shortcuts-modal');
      expect(modal.className).toContain('dark:bg-gray-800');
      expect(container.firstChild).toMatchSnapshot();
    });
  });
});
