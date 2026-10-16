/**
 * Retry Manager tests
 *
 * - Strict validation and payload sanitization (#1437)
 * - Prometheus alert metrics and health telemetry (#1438)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../logger.js';
import {
  horizonClientDataValidationErrors,
  horizonClientRetryExhausted,
  horizonClientConsecutiveFailures,
  horizonClientLastSuccessTimestamp,
  horizonClientHealthState,
  horizonClientConcurrentOperations,
} from '../../metrics.js';
import { DEFAULT_UNHEALTHY_AFTER_FAILURES, HealthStatus, RetryManager, createRetryManager } from './retry-manager.js';
import { HORIZON_VALIDATION_ERROR, REDACTED } from './sanitizer.js';

const SECRET_SEED = `S${'B'.repeat(55)}`;
const URL = 'https://horizon-testnet.stellar.org';

async function metricValue(metric, labels = {}) {
  const { values } = await metric.get();
  const match = values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  return match ? match.value : undefined;
}

function networkError(message = 'socket hang up') {
  const err = new Error(message);
  err.code = 'ECONNRESET';
  return err;
}

function httpError(status) {
  const err = new Error(`HTTP ${status}`);
  err.response = { status };
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  horizonClientDataValidationErrors.reset();
  horizonClientRetryExhausted.reset();
  horizonClientConsecutiveFailures.reset();
  horizonClientLastSuccessTimestamp.reset();
  horizonClientHealthState.reset();
  horizonClientConcurrentOperations.reset();
});

describe('RetryManager validation (#1437)', () => {
  it('rejects an invalid retry schedule at construction', () => {
    expect(() => new RetryManager([-5])).toThrow(expect.objectContaining({ code: HORIZON_VALIDATION_ERROR }));
    expect(() => new RetryManager(undefined)).toThrow(expect.objectContaining({ validationType: 'retry_delays' }));
    expect(() => createRetryManager(Array(20).fill(1))).toThrow(TypeError);
  });

  it('freezes the schedule so callers cannot mutate it later', () => {
    const delays = [0, 0];
    const manager = new RetryManager(delays);
    delays.push(99_999);
    expect(manager.getConfig()).toMatchObject({ retryDelays: [0, 0], maxAttempts: 3 });
  });

  it('rejects an invalid operation name before calling Horizon', async () => {
    const manager = new RetryManager([0]);
    const op = vi.fn();

    await expect(manager.executeWithRetry(op, 'load account\n', {}, URL)).rejects.toMatchObject({
      code: HORIZON_VALIDATION_ERROR,
      validationType: 'operation_name',
    });
    expect(op).not.toHaveBeenCalled();
    expect(await metricValue(horizonClientDataValidationErrors, { operation: 'invalid', validation_type: 'operation_name' })).toBe(1);
    expect(manager.getConfig().currentConcurrentOperations).toBe(0);
  });

  it('rejects a non-function operation', async () => {
    const manager = new RetryManager([0]);
    await expect(manager.executeWithRetry('nope', 'loadAccount', {}, URL)).rejects.toMatchObject({
      validationType: 'operation',
    });
    expect(await metricValue(horizonClientDataValidationErrors, { operation: 'loadAccount', validation_type: 'operation' })).toBe(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('sanitizes context and error text in retry logs', async () => {
    const manager = new RetryManager([0]);
    const op = vi.fn()
      .mockRejectedValueOnce(networkError(`boom\r\nforged ${SECRET_SEED}`))
      .mockResolvedValue('ok');

    await manager.executeWithRetry(op, 'loadAccount', { accountId: 'GABC', secret: SECRET_SEED, 'x\ny': 1 }, URL);

    const [fields] = logger.warn.mock.calls[0];
    expect(fields).toMatchObject({ operation: 'loadAccount', attempt: 1, accountId: 'GABC', secret: REDACTED });
    expect(fields.error).toBe(`boom forged ${REDACTED}`);
    expect(fields).not.toHaveProperty('x\ny');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET_SEED);
  });

  it('never leaks URL credentials or secrets in the thrown error', async () => {
    const manager = new RetryManager([]);
    const op = vi.fn().mockRejectedValue(networkError(`refused ${SECRET_SEED}`));

    const err = await manager
      .executeWithRetry(op, 'loadAccount', { seed: SECRET_SEED }, 'https://u:p@horizon.example.com/?key=1')
      .catch((e) => e);

    expect(err.message).toBe(`Unable to connect to Horizon (https://horizon.example.com): refused ${REDACTED}`);
    expect(err.status).toBe(502);
  });
});

describe('RetryManager alert metrics and health telemetry (#1438)', () => {
  it('starts healthy with no tracked operations', () => {
    const manager = new RetryManager([0]);
    expect(manager.getHealth()).toEqual({
      status: HealthStatus.HEALTHY,
      unhealthyAfterFailures: DEFAULT_UNHEALTHY_AFTER_FAILURES,
      concurrentOperations: 0,
      operations: {},
    });
  });

  it('records last success and keeps the operation healthy', async () => {
    const manager = new RetryManager([0], '', { now: () => 1_700_000_000_000 });
    await manager.executeWithRetry(() => Promise.resolve('ok'), 'getFeeStats', {}, URL);

    const health = manager.getHealth();
    expect(health.status).toBe(HealthStatus.HEALTHY);
    expect(health.operations.getFeeStats).toMatchObject({
      status: 'healthy',
      consecutiveFailures: 0,
      totalSuccesses: 1,
      lastSuccessAt: new Date(1_700_000_000_000).toISOString(),
    });
    expect(await metricValue(horizonClientLastSuccessTimestamp, { operation: 'getFeeStats' })).toBe(1_700_000_000);
    expect(await metricValue(horizonClientHealthState)).toBe(0);
  });

  it('counts retry exhaustion and degrades, then turns unhealthy at the threshold', async () => {
    const manager = new RetryManager([0], '', { unhealthyAfterFailures: 2 });
    const failing = () => Promise.reject(networkError());

    await manager.executeWithRetry(failing, 'loadAccount', {}, URL).catch(() => {});
    expect(manager.getHealth().status).toBe(HealthStatus.DEGRADED);
    expect(await metricValue(horizonClientHealthState)).toBe(1);
    expect(await metricValue(horizonClientConsecutiveFailures, { operation: 'loadAccount' })).toBe(1);

    await manager.executeWithRetry(failing, 'loadAccount', {}, URL).catch(() => {});
    expect(manager.getHealth().status).toBe(HealthStatus.UNHEALTHY);
    expect(manager.getHealth().operations.loadAccount).toMatchObject({
      consecutiveFailures: 2,
      totalFailures: 2,
      lastErrorType: 'network_error',
    });
    expect(await metricValue(horizonClientHealthState)).toBe(2);
    expect(await metricValue(horizonClientRetryExhausted, { operation: 'loadAccount', error_type: 'network_error' })).toBe(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'loadAccount', consecutiveFailures: 2 }),
      'Horizon client: operation is unhealthy after consecutive failures',
    );
  });

  it('recovers to healthy after a success', async () => {
    const manager = new RetryManager([], '', { unhealthyAfterFailures: 1 });
    await manager.executeWithRetry(() => Promise.reject(httpError(503)), 'fetchTransaction', {}, URL).catch(() => {});
    expect(manager.getHealth().status).toBe(HealthStatus.UNHEALTHY);

    await manager.executeWithRetry(() => Promise.resolve({}), 'fetchTransaction', {}, URL);
    expect(manager.getHealth().status).toBe(HealthStatus.HEALTHY);
    expect(await metricValue(horizonClientConsecutiveFailures, { operation: 'fetchTransaction' })).toBe(0);
    expect(await metricValue(horizonClientHealthState)).toBe(0);
  });

  it('does not treat non-retryable client errors as an outage', async () => {
    const manager = new RetryManager([0, 0]);
    const op = vi.fn().mockRejectedValue(httpError(404));

    await expect(manager.executeWithRetry(op, 'loadAccount', { accountId: 'G1' }, URL)).rejects.toThrow('not found');

    expect(op).toHaveBeenCalledTimes(1);
    expect(manager.getHealth().operations.loadAccount).toMatchObject({
      status: 'healthy',
      consecutiveFailures: 0,
      lastErrorType: 'not_found',
    });
    expect(await metricValue(horizonClientRetryExhausted, { operation: 'loadAccount', error_type: 'not_found' })).toBeUndefined();
  });

  it('does not count exhaustion when a retry succeeds', async () => {
    const manager = new RetryManager([0, 0]);
    const op = vi.fn().mockRejectedValueOnce(httpError(429)).mockResolvedValue('ok');

    await expect(manager.executeWithRetry(op, 'fetchPayments', {}, URL)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
    expect((await horizonClientRetryExhausted.get()).values).toHaveLength(0);
    expect(manager.getHealth().operations.fetchPayments.status).toBe('healthy');
  });

  it('reports the worst operation as the overall status', async () => {
    const manager = new RetryManager([], '', { unhealthyAfterFailures: 3 });
    await manager.executeWithRetry(() => Promise.resolve(1), 'getFeeStats', {}, URL);
    await manager.executeWithRetry(() => Promise.reject(networkError()), 'loadAccount', {}, URL).catch(() => {});

    const health = manager.getHealth();
    expect(health.status).toBe(HealthStatus.DEGRADED);
    expect(health.operations.getFeeStats.status).toBe('healthy');
    expect(health.operations.loadAccount.status).toBe('degraded');
  });

  it('falls back to the default threshold for invalid options', () => {
    expect(new RetryManager([], '', { unhealthyAfterFailures: 0 }).unhealthyAfterFailures).toBe(DEFAULT_UNHEALTHY_AFTER_FAILURES);
    expect(new RetryManager([], '', { unhealthyAfterFailures: 'x' }).unhealthyAfterFailures).toBe(DEFAULT_UNHEALTHY_AFTER_FAILURES);
    expect(new RetryManager([], '', { unhealthyAfterFailures: 2.5 }).unhealthyAfterFailures).toBe(DEFAULT_UNHEALTHY_AFTER_FAILURES);
  });

  it('bounds the number of tracked operations', async () => {
    const manager = new RetryManager([]);
    for (let i = 0; i < 70; i += 1) {
      await manager.executeWithRetry(() => Promise.resolve(i), `op${i}`, {}, URL);
    }
    expect(Object.keys(manager.getHealth().operations)).toHaveLength(64);
  });
});
