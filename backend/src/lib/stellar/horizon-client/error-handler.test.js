/**
 * Unit tests for Horizon error classification used by the Retry Manager.
 */

import { describe, it, expect } from 'vitest';
import { classifyError, getErrorStatus, handleError, isRetryableError } from './error-handler.js';

describe('isRetryableError', () => {
  it.each([
    ['429', { response: { status: 429 } }],
    ['408', { status: 408 }],
    ['5xx', { response: { status: 503 } }],
    ['a system code', { code: 'ECONNRESET' }],
    ['a system code on cause (undici)', { message: 'fetch failed', cause: { code: 'UND_ERR_SOCKET' } }],
    ['an SDK transport error without code', new Error('connect ECONNREFUSED 127.0.0.1:443')],
    ['an abort', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['a timeout message', new Error('Request timeout')],
  ])('retries %s', (_label, err) => {
    expect(isRetryableError(err)).toBe(true);
  });

  it.each([
    ['404', { response: { status: 404 } }],
    ['400', { response: { status: 400 } }],
    ['an ordinary bug', new TypeError('x is not a function')],
    ['null', null],
  ])('does not retry %s', (_label, err) => {
    expect(isRetryableError(err)).toBe(false);
  });
});

describe('classifyError / getErrorStatus', () => {
  it('reads status from response or the error itself', () => {
    expect(getErrorStatus({ response: { status: 418 } })).toBe(418);
    expect(getErrorStatus({ status: 500 })).toBe(500);
    expect(getErrorStatus({})).toBeNull();
  });

  it('classifies common failures', () => {
    expect(classifyError({ status: 429 })).toBe('rate_limit');
    expect(classifyError({ status: 404 })).toBe('not_found');
    expect(classifyError({ status: 500 })).toBe('server_error');
    expect(classifyError({ status: 400 })).toBe('client_error');
    expect(classifyError({ code: 'ECONNREFUSED' })).toBe('network_error');
    expect(classifyError({})).toBe('unknown');
  });
});

describe('handleError', () => {
  it('maps 5xx to 502 and keeps the operation', () => {
    expect(handleError({ status: 500 }, 'loadAccount', {}, 'h')).toMatchObject({ status: 502, operation: 'loadAccount' });
  });

  it('includes context for 404s', () => {
    expect(handleError({ status: 404 }, 'loadAccount', { accountId: 'GA' }, 'h').message).toContain('accountId=GA');
  });
});
