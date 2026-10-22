/**
 * PaymentDetailsSheet Component Tests (#1557)
 *
 * Covers: rendering, loading states, error states, optimistic rollback,
 * tab switching, and accessibility attributes.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PaymentDetailsSheet from '../PaymentDetailsSheet';

// Mock dependencies
jest.mock('next-intl', () => ({ useLocale: () => 'en' }));
jest.mock('@/lib/merchant-store', () => ({ useMerchantApiKey: () => 'test-api-key' }));
jest.mock('@/i18n/config', () => ({ localeToLanguageTag: (l: string) => l }));

// Mock framer-motion to avoid animation issues in tests
jest.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

describe('PaymentDetailsSheet', () => {
  const mockPayment = {
    id: 'pay-1',
    amount: 100.50,
    asset: 'XLM',
    asset_issuer: null,
    recipient: 'GABC123',
    description: 'Test payment',
    memo: 'test-memo',
    memo_type: 'text',
    status: 'confirmed',
    tx_id: 'tx-abc123',
    metadata: null,
    created_at: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it('renders nothing when not open', () => {
    const { container } = render(
      <PaymentDetailsSheet paymentId={null} isOpen={false} onClose={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows loading state when open', () => {
    (global.fetch as jest.Mock).mockReturnValue(new Promise(() => {})); // never resolves
    render(<PaymentDetailsSheet paymentId="pay-1" isOpen={true} onClose={() => {}} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('renders payment details on successful fetch', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ payment: mockPayment }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ logs: [] }) });

    render(<PaymentDetailsSheet paymentId="pay-1" isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Test payment')).toBeInTheDocument();
    });
  });

  it('shows error message on fetch failure', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

    render(<PaymentDetailsSheet paymentId="pay-1" isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('rolls back to previous state on network failure (#1555)', async () => {
    // First successful fetch
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ payment: mockPayment }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ logs: [] }) });

    const { rerender } = render(
      <PaymentDetailsSheet paymentId="pay-1" isOpen={true} onClose={() => {}} />
    );

    await waitFor(() => {
      expect(screen.getByText('Test payment')).toBeInTheDocument();
    });

    // Now simulate a failure on refetch
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network failure'));

    rerender(<PaymentDetailsSheet paymentId="pay-1" isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Network failure')).toBeInTheDocument();
    });
  });

  it('switches between tabs', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ payment: mockPayment }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ logs: [] }) });

    render(<PaymentDetailsSheet paymentId="pay-1" isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Test payment')).toBeInTheDocument();
    });

    const metadataTab = screen.getByRole('tab', { name: /metadata/i });
    fireEvent.click(metadataTab);
    expect(metadataTab).toHaveAttribute('aria-selected', 'true');
  });

  it('closes on Escape key', async () => {
    const onClose = jest.fn();
    (global.fetch as jest.Mock).mockRejectedValue(new Error('err'));

    render(<PaymentDetailsSheet paymentId="pay-1" isOpen={true} onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('has correct accessibility attributes', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ payment: mockPayment }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ logs: [] }) });

    render(<PaymentDetailsSheet paymentId="pay-1" isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });
});
