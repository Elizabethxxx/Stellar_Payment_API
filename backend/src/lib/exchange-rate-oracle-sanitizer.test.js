/**
 * Unit tests for Exchange Rate Oracle Cache payload sanitization and strict
 * validation (issue #1442).
 */

import { describe, it, expect } from 'vitest';
import {
  ExchangeRateValidationError,
  MAX_PATH_HOPS,
  ORACLE_VALIDATION_ERROR_CODE,
  isValidAccountId,
  isValidSanitizedQuote,
  normalizeAmount,
  sanitizeAsset,
  sanitizeQuote,
  sanitizeQuoteRequest,
} from './exchange-rate-oracle-sanitizer.js';

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const OTHER_ISSUER = 'GA5HBVNVS6P3QJ2ZGLMEACPSGFG3KDCAFTVHNJXWG22E5DVZTPSSAWQW';
const BAD_CHECKSUM = 'GA5HBVNVS6P3QJ2ZGLMEACPSGFG3KDCAFTVHNJXWG22E5DVZTPSSAWQA';
const SECRET_SEED = 'SBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const validRequest = (overrides = {}) => ({
  sourceAssetCode: 'XLM',
  sourceAssetIssuer: null,
  destAssetCode: 'USDC',
  destAssetIssuer: USDC_ISSUER,
  destAmount: '10.5000000',
  sourceAccount: null,
  slippage: 0.01,
  ...overrides,
});

const validQuote = (overrides = {}) => ({
  sourceAsset: 'XLM',
  sourceAssetIssuer: null,
  sourceAmount: '20.0000000',
  sendMax: '20.2000000',
  destinationAsset: 'USDC',
  destinationAssetIssuer: USDC_ISSUER,
  destinationAmount: '10.5000000',
  path: [{ asset_code: 'USDC', asset_issuer: USDC_ISSUER }],
  slippage: 0.01,
  cached: false,
  ...overrides,
});

const expectValidationError = (fn, field) => {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ExchangeRateValidationError);
  expect(caught).toMatchObject({
    status: 400,
    statusCode: 400,
    code: ORACLE_VALIDATION_ERROR_CODE,
    retryable: false,
    field,
  });
};

describe('isValidAccountId', () => {
  it('accepts a valid ed25519 public key', () => {
    expect(isValidAccountId(USDC_ISSUER)).toBe(true);
    expect(isValidAccountId(OTHER_ISSUER)).toBe(true);
  });

  it.each([
    ['a bad checksum', BAD_CHECKSUM],
    ['a secret seed', SECRET_SEED],
    ['lower case', USDC_ISSUER.toLowerCase()],
    ['the wrong length', USDC_ISSUER.slice(0, -1)],
    ['a non-string', 42],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(isValidAccountId(value)).toBe(false);
  });
});

describe('normalizeAmount', () => {
  it.each([
    ['1', '1'],
    ['10.5', '10.5'],
    ['50.0000000', '50.0000000'],
    ['  7.25  ', '7.25'],
    ['10.500000000', '10.5000000'],
    [25, '25'],
    ['922337203685.4775807', '922337203685.4775807'],
  ])('accepts %j as %j', (input, expected) => {
    expect(normalizeAmount(input)).toBe(expected);
  });

  it.each([
    ['zero', '0'],
    ['zero with decimals', '0.0000000'],
    ['negative', '-1'],
    ['exponent', '1e5'],
    ['too much precision', '1.00000001'],
    ['above int64 stroops', '922337203685.4775808'],
    ['hex', '0x10'],
    ['empty', ''],
    ['whitespace inside', '1 0'],
    ['NaN number', NaN],
    ['Infinity', Infinity],
    ['object', { toString: () => '1' }],
    ['null', null],
  ])('rejects %s', (_label, input) => {
    expect(normalizeAmount(input)).toBeNull();
  });

  it('allows zero when asked', () => {
    expect(normalizeAmount('0', { allowZero: true })).toBe('0');
  });
});

describe('sanitizeAsset', () => {
  it('upper-cases codes and keeps issuers', () => {
    expect(sanitizeAsset(' usdc ', ` ${USDC_ISSUER} `, 'destAsset')).toEqual({ code: 'USDC', issuer: USDC_ISSUER });
  });

  it('treats XLM as native and drops any issuer, like resolveAsset()', () => {
    expect(sanitizeAsset('xlm', USDC_ISSUER, 'sourceAsset')).toEqual({ code: 'XLM', issuer: null });
  });

  it('requires an issuer for credit assets', () => {
    expectValidationError(() => sanitizeAsset('USDC', null, 'destAsset'), 'destAssetIssuer');
    expectValidationError(() => sanitizeAsset('USDC', '', 'destAsset'), 'destAssetIssuer');
  });

  it.each([
    ['too long', 'ABCDEFGHIJKLM'],
    ['symbols', 'US$C'],
    ['empty', ''],
    ['a separator', 'USDC:GA'],
  ])('rejects a code that is %s', (_label, code) => {
    expectValidationError(() => sanitizeAsset(code, USDC_ISSUER, 'destAsset'), 'destAsset');
  });

  it('rejects malformed issuers', () => {
    expectValidationError(() => sanitizeAsset('USDC', BAD_CHECKSUM, 'destAsset'), 'destAssetIssuer');
    expectValidationError(() => sanitizeAsset('USDC', { toString: () => USDC_ISSUER }, 'destAsset'), 'destAssetIssuer');
  });
});

describe('sanitizeQuoteRequest', () => {
  it('returns canonical parameters for a valid request', () => {
    expect(sanitizeQuoteRequest(validRequest({ sourceAssetCode: ' xlm ', destAssetCode: 'usdc' }))).toEqual({
      sourceAssetCode: 'XLM',
      sourceAssetIssuer: null,
      destAssetCode: 'USDC',
      destAssetIssuer: USDC_ISSUER,
      destAmount: '10.5000000',
      sourceAccount: null,
      slippage: 0.01,
    });
  });

  it('accepts and trims a valid source account', () => {
    expect(sanitizeQuoteRequest(validRequest({ sourceAccount: ` ${OTHER_ISSUER}` })).sourceAccount).toBe(OTHER_ISSUER);
  });

  it('does not copy unknown fields', () => {
    const result = sanitizeQuoteRequest({ ...validRequest(), extra: 'x', __proto__: { polluted: true } });
    expect(Object.keys(result).sort()).toEqual([
      'destAmount', 'destAssetCode', 'destAssetIssuer', 'slippage',
      'sourceAccount', 'sourceAssetCode', 'sourceAssetIssuer',
    ]);
    expect(result.polluted).toBeUndefined();
  });

  it.each([
    ['null params', null, 'params'],
    ['array params', [], 'params'],
    ['bad source code', validRequest({ sourceAssetCode: 'X L M' }), 'sourceAsset'],
    ['missing dest issuer', validRequest({ destAssetIssuer: null }), 'destAssetIssuer'],
    ['zero amount', validRequest({ destAmount: '0' }), 'destAmount'],
    ['injected amount', validRequest({ destAmount: '1;DROP' }), 'destAmount'],
    ['bad source account', validRequest({ sourceAccount: BAD_CHECKSUM }), 'sourceAccount'],
    ['non-string source account', validRequest({ sourceAccount: 7 }), 'sourceAccount'],
    ['negative slippage', validRequest({ slippage: -0.01 }), 'slippage'],
    ['excessive slippage', validRequest({ slippage: 0.9 }), 'slippage'],
    ['NaN slippage', validRequest({ slippage: 'abc' }), 'slippage'],
  ])('rejects %s', (_label, params, field) => {
    expectValidationError(() => sanitizeQuoteRequest(params), field);
  });
});

describe('sanitizeQuote', () => {
  it('returns an equal, fresh object for a valid quote', () => {
    const input = validQuote();
    const output = sanitizeQuote(input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(output.path[0]).not.toBe(input.path[0]);
  });

  it('preserves Horizon formatting and casing', () => {
    const output = sanitizeQuote(validQuote({ sourceAsset: 'yXLM', sourceAssetIssuer: OTHER_ISSUER }));
    expect(output.sourceAsset).toBe('yXLM');
    expect(output.sourceAmount).toBe('20.0000000');
  });

  it('strips unknown fields and prototype keys from parsed JSON', () => {
    const poisoned = JSON.parse(JSON.stringify(validQuote()).replace(
      /^\{/,
      '{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"x":1}},"memo":"pay-me",',
    ));
    const output = sanitizeQuote(poisoned);
    expect(output).not.toBeNull();
    expect(Object.keys(output)).not.toContain('memo');
    expect(output.isAdmin).toBeUndefined();
    expect({}.isAdmin).toBeUndefined();
  });

  it('only keeps cached:true when it is literally true', () => {
    expect(sanitizeQuote(validQuote({ cached: 'yes' })).cached).toBe(false);
    expect(sanitizeQuote(validQuote({ cached: true })).cached).toBe(true);
  });

  it('allows an empty path', () => {
    expect(sanitizeQuote(validQuote({ path: [] })).path).toEqual([]);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'quote'],
    ['a numeric sendMax', validQuote({ sendMax: 20.2 })],
    ['an exponent amount', validQuote({ sourceAmount: '2e1' })],
    ['sendMax below sourceAmount', validQuote({ sendMax: '19.0000000' })],
    ['a zero destination amount', validQuote({ destinationAmount: '0' })],
    ['a credit asset without issuer', validQuote({ destinationAssetIssuer: null })],
    ['a bad issuer', validQuote({ sourceAsset: 'EUR', sourceAssetIssuer: BAD_CHECKSUM })],
    ['an oversized asset code', validQuote({ sourceAsset: 'ABCDEFGHIJKLM' })],
    ['slippage out of range', validQuote({ slippage: 2 })],
    ['a missing slippage', validQuote({ slippage: undefined })],
    ['a non-array path', validQuote({ path: 'XLM>USDC' })],
    ['too many hops', validQuote({ path: Array.from({ length: MAX_PATH_HOPS + 1 }, () => ({ asset_code: 'XLM', asset_issuer: null })) })],
    ['a malformed hop', validQuote({ path: [null] })],
    ['a hop with a bad issuer', validQuote({ path: [{ asset_code: 'USDC', asset_issuer: 'G123' }] })],
  ])('rejects %s', (_label, data) => {
    expect(sanitizeQuote(data)).toBeNull();
    expect(isValidSanitizedQuote(data)).toBe(false);
  });
});
