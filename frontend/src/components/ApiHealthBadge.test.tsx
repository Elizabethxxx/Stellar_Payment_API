import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ApiHealthBadge from './ApiHealthBadge';

// ── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function healthyResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({ services: { database: 'ok', horizon: 'ok' } }),
  };
}

function degradedResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({ services: { database: 'ok', horizon: 'down' } }),
  };
}

function errorResponse() {
  return Promise.reject(new Error('Network error'));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ApiHealthBadge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders loading state initially', () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ApiHealthBadge />);
    expect(screen.getByText(/checking/i)).toBeInTheDocument();
  });

  it('renders healthy state after successful fetch', async () => {
    mockFetch.mockResolvedValue(healthyResponse());
    render(<ApiHealthBadge />);
    await waitFor(() => {
      expect(screen.getByText(/api active/i)).toBeInTheDocument();
    });
  });

  it('renders error state when fetch fails', async () => {
    mockFetch.mockImplementation(() => errorResponse());
    render(<ApiHealthBadge />);
    await waitFor(() => {
      expect(screen.getByText(/api down/i)).toBeInTheDocument();
    });
  });

  it('renders degraded dependency message when a service is down', async () => {
    mockFetch.mockResolvedValue(degradedResponse());
    render(<ApiHealthBadge />);
    await waitFor(() => {
      expect(screen.getByText(/api active/i)).toBeInTheDocument();
    });
    // Tooltip shows degraded dependency after hover/focus
    const button = screen.getByRole('button');
    fireEvent.focus(button);
    await waitFor(() => {
      expect(screen.getByText(/degraded dependency/i)).toBeInTheDocument();
    });
  });

  it('has accessible aria-label with status and shortcut hint', async () => {
    mockFetch.mockResolvedValue(healthyResponse());
    render(<ApiHealthBadge />);
    await waitFor(() => {
      expect(screen.getByText(/api active/i)).toBeInTheDocument();
    });
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-label', expect.stringContaining('Press Enter or R'));
  });

  it('has aria-live="polite" for screen reader announcements', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<ApiHealthBadge />);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-live', 'polite');
  });

  it('triggers refresh on Enter key', async () => {
    mockFetch.mockResolvedValue(healthyResponse());
    render(<ApiHealthBadge />);
    await waitFor(() => {
      expect(screen.getByText(/api active/i)).toBeInTheDocument();
    });
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(healthyResponse());
    const button = screen.getByRole('button');
    fireEvent.keyDown(button, { key: 'Enter' });
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  it('triggers refresh on "r" key', async () => {
    mockFetch.mockResolvedValue(healthyResponse());
    render(<ApiHealthBadge />);
    await waitFor(() => {
      expect(screen.getByText(/api active/i)).toBeInTheDocument();
    });
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(healthyResponse());
    const button = screen.getByRole('button');
    fireEvent.keyDown(button, { key: 'r' });
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  it('blurs button on Escape key', async () => {
    mockFetch.mockResolvedValue(healthyResponse());
    render(<ApiHealthBadge />);
    await waitFor(() => {
      expect(screen.getByText(/api active/i)).toBeInTheDocument();
    });
    const button = screen.getByRole('button');
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(document.activeElement).not.toBe(button);
  });

  it('shows tooltip on keyboard focus', async () => {
    mockFetch.mockResolvedValue(healthyResponse());
    render(<ApiHealthBadge />);
    await waitFor(() => {
      expect(screen.getByText(/api active/i)).toBeInTheDocument();
    });
    const button = screen.getByRole('button');
    fireEvent.focus(button);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveClass('opacity-100');
  });

  it('hides tooltip on blur', async () => {
    mockFetch.mockResolvedValue(healthyResponse());
    render(<ApiHealthBadge />);
    await waitFor(() => {
      expect(screen.getByText(/api active/i)).toBeInTheDocument();
    });
    const button = screen.getByRole('button');
    fireEvent.focus(button);
    fireEvent.blur(button);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveClass('opacity-0');
  });

  it('matches snapshot in healthy state', async () => {
    mockFetch.mockResolvedValue(healthyResponse());
    const { container } = render(<ApiHealthBadge />);
    await waitFor(() => {
      expect(screen.getByText(/api active/i)).toBeInTheDocument();
    });
    expect(container.firstChild).toMatchSnapshot();
  });

  it('matches snapshot in error state', async () => {
    mockFetch.mockImplementation(() => errorResponse());
    const { container } = render(<ApiHealthBadge />);
    await waitFor(() => {
      expect(screen.getByText(/api down/i)).toBeInTheDocument();
    });
    expect(container.firstChild).toMatchSnapshot();
  });

  it('matches snapshot in loading state', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    const { container } = render(<ApiHealthBadge />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
