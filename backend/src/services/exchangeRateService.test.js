import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getExchangeRateQuote,
  invalidateExchangeRateQuote,
  configureExchangeRateCoordination,
  resetExchangeRateCoordination,
  NoPathFoundError,
  ExchangeRateError,
  ExchangeRateValidationError,
} from './exchangeRateService.js';
import { resetExchangeRateCache, generateRateCacheKey } from '../lib/exchange-rate-cache.js';
import { createFakeRedis } from '../../tests/helpers/fake-redis.js';

vi.mock('../lib/stellar.js', () => ({
  findStrictReceivePaths: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { findStrictReceivePaths } from '../lib/stellar.js';

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const MOCK_PATH = {
  source_asset_code:   'XLM',
  source_asset_issuer: null,
  source_amount:       '0.5000000',
  destination_amount:  '1.0000000',
  path: [
    { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
  ],
};

describe('getExchangeRateQuote', () => {
  beforeEach(() => {
    resetExchangeRateCache();
    vi.clearAllMocks();
    process.env.EXCHANGE_RATE_ORACLE_RETRY_BASE_DELAY_MS = '0';
    process.env.EXCHANGE_RATE_ORACLE_RETRY_MAX_DELAY_MS = '0';
    findStrictReceivePaths.mockResolvedValue(MOCK_PATH);
  });

  afterEach(() => {
    resetExchangeRateCache();
    delete process.env.EXCHANGE_RATE_ORACLE_RETRY_BASE_DELAY_MS;
    delete process.env.EXCHANGE_RATE_ORACLE_RETRY_MAX_DELAY_MS;
  });

  it('returns a quote with correct fields', async () => {
    const quote = await getExchangeRateQuote({
      sourceAssetCode: 'XLM',
      destAssetCode:   'USDC',
      destAssetIssuer: USDC_ISSUER,
      destAmount:      '1.0000000',
    });

    expect(quote.sourceAsset).toBe('XLM');
    expect(quote.destinationAsset).toBe('USDC');
    expect(quote.sourceAmount).toBe('0.5000000');
    expect(quote.slippage).toBeCloseTo(0.01);
    expect(quote.sendMax).toBe('0.5050000');
    expect(quote.cached).toBe(false);
  });

  it('calls findStrictReceivePaths exactly once on first call', async () => {
    await getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' });
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);
  });

  it('returns cached result on second identical call without hitting Horizon', async () => {
    await getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' });
    const second = await getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' });
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
  });

  it('does not share cache between different dest amounts', async () => {
    await getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' });
    await getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '2.0' });
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(2);
  });

  it('does not share cache between different asset pairs', async () => {
    await getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' });
    await getExchangeRateQuote({ sourceAssetCode: 'BTC', sourceAssetIssuer: USDC_ISSUER, destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' });
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(2);
  });

  it('throws NoPathFoundError when Horizon returns null', async () => {
    findStrictReceivePaths.mockResolvedValue(null);
    await expect(
      getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' }),
    ).rejects.toThrow(NoPathFoundError);
  });

  it('NoPathFoundError has statusCode 404', async () => {
    findStrictReceivePaths.mockResolvedValue(null);
    try {
      await getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' });
    } catch (err) {
      expect(err.statusCode).toBe(404);
    }
  });

  it('propagates Horizon errors as-is after retries are exhausted', async () => {
    const horizonErr = new Error('Horizon unavailable');
    horizonErr.status = 503;
    findStrictReceivePaths.mockRejectedValue(horizonErr);
    await expect(
      getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' }),
    ).rejects.toThrow('Horizon unavailable');
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(3);
    expect(horizonErr.retryAttempts).toBe(3);
  });

  it('retries a transient Horizon failure and then returns the quote', async () => {
    findStrictReceivePaths
      .mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }))
      .mockResolvedValueOnce(MOCK_PATH);
    const quote = await getExchangeRateQuote({
      sourceAssetCode: 'XLM',
      destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER,
      destAmount: '1.0',
    });
    expect(quote.sourceAmount).toBe('0.5000000');
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(2);
  });

  it('does not retry a deterministic 400', async () => {
    findStrictReceivePaths.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));
    await expect(
      getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' }),
    ).rejects.toThrow('bad request');
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);
  });

  it('applies custom slippage correctly', async () => {
    const quote = await getExchangeRateQuote({
      sourceAssetCode: 'XLM',
      destAssetCode:   'USDC',
      destAssetIssuer: USDC_ISSUER,
      destAmount:      '1.0000000',
      slippage:        0.02,
    });
    const expected = (0.5 * 1.02).toFixed(7);
    expect(quote.sendMax).toBe(expected);
  });
});

describe('invalidateExchangeRateQuote', () => {
  beforeEach(() => {
    resetExchangeRateCache();
    vi.clearAllMocks();
    findStrictReceivePaths.mockResolvedValue(MOCK_PATH);
  });

  afterEach(() => {
    resetExchangeRateCache();
  });

  it('forces re-query after invalidation', async () => {
    await getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' });
    invalidateExchangeRateQuote('XLM', 'USDC', '1.0', null, USDC_ISSUER);
    await getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' });
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(2);
  });

  it('does not affect cache entries for different amounts', async () => {
    await getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' });
    await getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '2.0' });
    invalidateExchangeRateQuote('XLM', 'USDC', '1.0', null, USDC_ISSUER);
    const quote = await getExchangeRateQuote({ sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '2.0' });
    // The 2.0 quote is still cached, so no third Horizon call is made.
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(2);
    expect(quote.cached).toBe(true);
  });
});

describe('concurrency control (issue #1445)', () => {
  const params = { sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' };

  beforeEach(() => {
    resetExchangeRateCache();
    resetExchangeRateCoordination();
    vi.clearAllMocks();
    process.env.EXCHANGE_RATE_ORACLE_RETRY_BASE_DELAY_MS = '0';
    process.env.EXCHANGE_RATE_ORACLE_RETRY_MAX_DELAY_MS = '0';
    findStrictReceivePaths.mockResolvedValue(MOCK_PATH);
  });

  afterEach(() => {
    resetExchangeRateCache();
    resetExchangeRateCoordination();
  });

  it('coalesces a burst of identical requests into one Horizon call', async () => {
    let release;
    findStrictReceivePaths.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve(MOCK_PATH); }),
    );
    const pending = Array.from({ length: 25 }, () => getExchangeRateQuote(params));
    await vi.waitFor(() => expect(findStrictReceivePaths).toHaveBeenCalled());
    release();
    const quotes = await Promise.all(pending);
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);
    expect(quotes.filter((q) => q.cached === false)).toHaveLength(1);
    expect(quotes.filter((q) => q.cached === true)).toHaveLength(24);
    expect(new Set(quotes.map((q) => q.sendMax))).toEqual(new Set(['0.5050000']));
  });

  it('propagates NoPathFoundError to every coalesced caller', async () => {
    findStrictReceivePaths.mockResolvedValue(null);
    const settled = await Promise.allSettled([getExchangeRateQuote(params), getExchangeRateQuote(params)]);
    expect(settled.every((s) => s.status === 'rejected' && s.reason instanceof NoPathFoundError)).toBe(true);
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);
  });

  it('configureExchangeRateCoordination ignores missing or closed clients', () => {
    expect(configureExchangeRateCoordination({ redisClient: null })).toBe(false);
    expect(configureExchangeRateCoordination({ redisClient: { isOpen: false, sendCommand: vi.fn() } })).toBe(false);
    expect(configureExchangeRateCoordination({ redisClient: { isOpen: true } })).toBe(false);
    expect(configureExchangeRateCoordination()).toBe(false);
    expect(configureExchangeRateCoordination({ redisClient: createFakeRedis() })).toBe(true);
  });

  it('publishes quotes to the shared store and reuses a peer’s quote', async () => {
    const redis = createFakeRedis();
    configureExchangeRateCoordination({ redisClient: redis, pollIntervalMs: 5 });

    const first = await getExchangeRateQuote(params);
    expect(first.cached).toBe(false);
    const key = generateRateCacheKey('XLM', 'USDC', '1.0', null, USDC_ISSUER);
    expect(redis.store.has(`exrate:quote:${key}`)).toBe(true);

    // A second instance with an empty in-memory cache.
    resetExchangeRateCache();
    const second = await getExchangeRateQuote(params);
    expect(second.cached).toBe(true);
    expect(second.sendMax).toBe(first.sendMax);
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);
  });

  it('invalidation also clears the shared quote', async () => {
    const redis = createFakeRedis();
    configureExchangeRateCoordination({ redisClient: redis });
    await getExchangeRateQuote(params);
    invalidateExchangeRateQuote('XLM', 'USDC', '1.0', null, USDC_ISSUER);
    await vi.waitFor(() => expect(redis.count('DEL')).toBe(1));
    expect(redis.store.size).toBe(0);
  });

  it('keeps serving quotes when Redis fails', async () => {
    const redis = createFakeRedis();
    configureExchangeRateCoordination({ redisClient: redis });
    redis.setFailure(new Error('ECONNREFUSED'));
    const quote = await getExchangeRateQuote(params);
    expect(quote.sourceAmount).toBe('0.5000000');
    expect(() => invalidateExchangeRateQuote('XLM', 'USDC', '1.0', null, USDC_ISSUER)).not.toThrow();
  });
});

describe('payload sanitization and strict validation (issue #1442)', () => {
  const params = { sourceAssetCode: 'XLM', destAssetCode: 'USDC', destAssetIssuer: USDC_ISSUER, destAmount: '1.0' };

  beforeEach(() => {
    resetExchangeRateCache();
    resetExchangeRateCoordination();
    vi.clearAllMocks();
    process.env.EXCHANGE_RATE_ORACLE_RETRY_BASE_DELAY_MS = '0';
    process.env.EXCHANGE_RATE_ORACLE_RETRY_MAX_DELAY_MS = '0';
    findStrictReceivePaths.mockResolvedValue(MOCK_PATH);
  });

  afterEach(() => {
    resetExchangeRateCache();
    resetExchangeRateCoordination();
  });

  it.each([
    ['a credit asset without issuer', { ...params, destAssetIssuer: null }, 'destAssetIssuer'],
    ['a malformed amount', { ...params, destAmount: '1e9' }, 'destAmount'],
    ['an invalid source account', { ...params, sourceAccount: 'GNOTANACCOUNT' }, 'sourceAccount'],
    ['an out-of-range slippage', { ...params, slippage: 5 }, 'slippage'],
  ])('rejects %s with a 400 before touching Horizon or the cache', async (_label, input, field) => {
    await expect(getExchangeRateQuote(input)).rejects.toMatchObject({
      name: 'ExchangeRateValidationError',
      status: 400,
      field,
    });
    expect(findStrictReceivePaths).not.toHaveBeenCalled();
  });

  it('exposes ExchangeRateValidationError for route handlers', async () => {
    await expect(getExchangeRateQuote({ ...params, destAmount: '-1' }))
      .rejects.toBeInstanceOf(ExchangeRateValidationError);
  });

  it('canonicalises equivalent requests onto one cache entry', async () => {
    await getExchangeRateQuote(params);
    const again = await getExchangeRateQuote({ ...params, destAssetCode: ' usdc ', sourceAssetIssuer: USDC_ISSUER });
    expect(again.cached).toBe(true);
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);
  });

  it('passes sanitized parameters to Horizon', async () => {
    await getExchangeRateQuote({ ...params, destAssetCode: 'usdc', sourceAssetCode: 'xlm' });
    expect(findStrictReceivePaths).toHaveBeenCalledWith(expect.objectContaining({
      sourceAssetCode: 'XLM',
      sourceAssetIssuer: null,
      destAssetCode: 'USDC',
      destAssetIssuer: USDC_ISSUER,
    }));
  });

  it('rejects a malformed Horizon quote with 502, without retrying or caching it', async () => {
    findStrictReceivePaths.mockResolvedValue({ ...MOCK_PATH, source_amount: 'NaN' });
    await expect(getExchangeRateQuote(params)).rejects.toMatchObject({ statusCode: 502, retryable: false });
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);

    findStrictReceivePaths.mockResolvedValue(MOCK_PATH);
    const quote = await getExchangeRateQuote(params);
    expect(quote.cached).toBe(false);
  });

  it('strips unknown fields that a Horizon response or peer tries to smuggle in', async () => {
    findStrictReceivePaths.mockResolvedValue({
      ...MOCK_PATH,
      path: [{ ...MOCK_PATH.path[0], memo: 'evil' }],
    });
    const quote = await getExchangeRateQuote(params);
    expect(quote.path).toEqual([{ asset_code: 'USDC', asset_issuer: USDC_ISSUER }]);
  });

  it('sanitizes quotes read from the shared Redis store', async () => {
    const redis = createFakeRedis();
    configureExchangeRateCoordination({ redisClient: redis, pollIntervalMs: 5 });
    const key = generateRateCacheKey('XLM', 'USDC', '1.0', null, USDC_ISSUER);
    const planted = {
      sourceAsset: 'XLM',
      sourceAssetIssuer: null,
      sourceAmount: '0.5000000',
      sendMax: '0.5050000',
      destinationAsset: 'USDC',
      destinationAssetIssuer: USDC_ISSUER,
      destinationAmount: '1.0',
      path: [],
      slippage: 0.01,
      redirectTo: 'GATTACKER',
    };
    redis.store.set(`exrate:quote:${key}`, {
      value: JSON.stringify({ v: 1, insertedAt: Date.now(), data: planted }),
      expiresAt: null,
    });

    const quote = await getExchangeRateQuote(params);
    expect(quote.cached).toBe(true);
    expect(quote).not.toHaveProperty('redirectTo');
    expect(findStrictReceivePaths).not.toHaveBeenCalled();
  });

  it('treats a shared entry that fails strict validation as a miss', async () => {
    const redis = createFakeRedis();
    configureExchangeRateCoordination({ redisClient: redis, pollIntervalMs: 5 });
    const key = generateRateCacheKey('XLM', 'USDC', '1.0', null, USDC_ISSUER);
    redis.store.set(`exrate:quote:${key}`, {
      value: JSON.stringify({
        v: 1,
        data: { sourceAsset: 'XLM', sourceAmount: '9.0000000', sendMax: '0.0000001', path: [] },
      }),
      expiresAt: null,
    });

    const quote = await getExchangeRateQuote(params);
    expect(quote.sendMax).toBe('0.5050000');
    expect(findStrictReceivePaths).toHaveBeenCalledTimes(1);
  });

  it('invalidation never throws on malformed input', () => {
    expect(() => invalidateExchangeRateQuote(null, undefined, {})).not.toThrow();
  });
});
