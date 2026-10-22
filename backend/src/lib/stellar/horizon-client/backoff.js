/**
 * Horizon Client Backoff Policy (issue #1439)
 *
 * Computes how long the Retry Manager waits between attempts.
 *
 * Strategies
 * ----------
 *   exponential (default)  delay(n) = jitter(min(maxDelayMs, baseDelayMs * multiplier^n))
 *   fixed                  delay(n) = retryDelays[n]  (legacy explicit schedule)
 *
 * Jitter modes (exponential only)
 *   full   random(0, ceiling)                  - best at spreading retry storms
 *   equal  ceiling/2 + random(0, ceiling/2)    - keeps a guaranteed minimum wait
 *   none   ceiling                             - deterministic
 *
 * Every number is clamped to a safe range, so a bad environment variable can
 * neither disable the backoff nor make a request wait for minutes.
 *
 * Retry-After
 * -----------
 * A 429/503 from Horizon may carry a Retry-After header (delta-seconds or an
 * HTTP date). parseRetryAfterMs() turns it into milliseconds; the Retry
 * Manager waits at least that long and gives up instead of waiting when the
 * hint exceeds maxRetryAfterMs.
 */

import {
  DEFAULT_BACKOFF_OPTIONS,
  BACKOFF_LIMITS,
  BACKOFF_JITTER_MODES,
  BACKOFF_STRATEGIES,
} from "./constants.js";

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function clampFloat(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function pickEnum(value, allowed, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

/**
 * Sanitize an explicit delay schedule. Non-finite or negative entries are
 * dropped and every delay is capped, so `[NaN, -1, 1e9]` cannot stall a call.
 *
 * @param {unknown} delays
 * @returns {number[]|null} null when no usable schedule was provided
 */
export function normalizeRetryDelays(delays) {
  if (!Array.isArray(delays)) return null;
  const cleaned = delays
    .map((d) => Number(d))
    .filter((d) => Number.isFinite(d) && d >= 0)
    .slice(0, BACKOFF_LIMITS.maxRetries)
    .map((d) => Math.min(Math.trunc(d), BACKOFF_LIMITS.maxDelayMs));
  return cleaned;
}

/**
 * Resolve the effective backoff configuration.
 *
 * Precedence: explicit options > environment > defaults.
 * When `retryDelays` is supplied the strategy defaults to "fixed" so existing
 * callers keep their exact schedule.
 *
 * @param {object} [options]
 * @param {number[]} [options.retryDelays]
 * @param {"exponential"|"fixed"} [options.strategy]
 * @param {number} [options.maxRetries]
 * @param {number} [options.baseDelayMs]
 * @param {number} [options.maxDelayMs]
 * @param {number} [options.multiplier]
 * @param {"full"|"equal"|"none"} [options.jitter]
 * @param {number} [options.maxElapsedMs]
 * @param {number} [options.maxRetryAfterMs]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveBackoffOptions(options = {}, env = process.env) {
  const retryDelays = normalizeRetryDelays(options.retryDelays);
  const strategy = pickEnum(
    options.strategy ?? (retryDelays ? BACKOFF_STRATEGIES.FIXED : env.HORIZON_RETRY_STRATEGY),
    Object.values(BACKOFF_STRATEGIES),
    DEFAULT_BACKOFF_OPTIONS.strategy,
  );

  const baseDelayMs = clampInt(
    options.baseDelayMs ?? env.HORIZON_RETRY_BASE_DELAY_MS,
    DEFAULT_BACKOFF_OPTIONS.baseDelayMs,
    0,
    BACKOFF_LIMITS.maxDelayMs,
  );
  const maxDelayMs = clampInt(
    options.maxDelayMs ?? env.HORIZON_RETRY_MAX_DELAY_MS,
    DEFAULT_BACKOFF_OPTIONS.maxDelayMs,
    baseDelayMs,
    BACKOFF_LIMITS.maxDelayMs,
  );

  const fixedSchedule =
    strategy === BACKOFF_STRATEGIES.FIXED
      ? retryDelays ?? [...DEFAULT_BACKOFF_OPTIONS.fixedDelays]
      : null;

  const maxRetries = fixedSchedule
    ? fixedSchedule.length
    : clampInt(
        options.maxRetries ?? env.HORIZON_RETRY_MAX_RETRIES,
        DEFAULT_BACKOFF_OPTIONS.maxRetries,
        0,
        BACKOFF_LIMITS.maxRetries,
      );

  return Object.freeze({
    strategy,
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    multiplier: clampFloat(
      options.multiplier ?? env.HORIZON_RETRY_MULTIPLIER,
      DEFAULT_BACKOFF_OPTIONS.multiplier,
      1,
      BACKOFF_LIMITS.maxMultiplier,
    ),
    jitter: pickEnum(
      options.jitter ?? env.HORIZON_RETRY_JITTER,
      Object.values(BACKOFF_JITTER_MODES),
      DEFAULT_BACKOFF_OPTIONS.jitter,
    ),
    maxElapsedMs: clampInt(
      options.maxElapsedMs ?? env.HORIZON_RETRY_MAX_ELAPSED_MS,
      DEFAULT_BACKOFF_OPTIONS.maxElapsedMs,
      0,
      BACKOFF_LIMITS.maxElapsedMs,
    ),
    maxRetryAfterMs: clampInt(
      options.maxRetryAfterMs ?? env.HORIZON_RETRY_MAX_RETRY_AFTER_MS,
      DEFAULT_BACKOFF_OPTIONS.maxRetryAfterMs,
      0,
      BACKOFF_LIMITS.maxElapsedMs,
    ),
    fixedDelays: fixedSchedule ? Object.freeze(fixedSchedule) : null,
  });
}

/**
 * Delay before retry number `retryIndex` (0 = first retry).
 *
 * @param {number} retryIndex
 * @param {ReturnType<typeof resolveBackoffOptions>} policy
 * @param {() => number} [random] injectable for deterministic tests
 * @returns {number} milliseconds, always an integer >= 0
 */
export function computeBackoffDelay(retryIndex, policy, random = Math.random) {
  const index = Math.max(0, Math.trunc(Number(retryIndex) || 0));

  if (policy.strategy === BACKOFF_STRATEGIES.FIXED) {
    const schedule = policy.fixedDelays ?? [];
    if (schedule.length === 0) return 0;
    return schedule[Math.min(index, schedule.length - 1)];
  }

  // Cap the exponent before Math.pow so huge indices cannot overflow to Infinity.
  const exponent = Math.min(index, 64);
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.multiplier ** exponent);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return 0;

  const r = Math.min(Math.max(Number(random()) || 0, 0), 1);
  switch (policy.jitter) {
    case BACKOFF_JITTER_MODES.NONE:
      return Math.floor(ceiling);
    case BACKOFF_JITTER_MODES.EQUAL:
      return Math.floor(ceiling / 2 + r * (ceiling / 2));
    case BACKOFF_JITTER_MODES.FULL:
    default:
      return Math.floor(r * ceiling);
  }
}

function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") {
    return headers.get(name) ?? undefined;
  }
  if (typeof headers === "object") {
    const match = Object.keys(headers).find((key) => key.toLowerCase() === name);
    return match ? headers[match] : undefined;
  }
  return undefined;
}

/**
 * Extract a Retry-After hint from a Horizon / fetch / axios-style error.
 *
 * @param {unknown} err
 * @param {number} [now]
 * @returns {number|null} milliseconds to wait, or null when absent/invalid
 */
export function parseRetryAfterMs(err, now = Date.now()) {
  const raw =
    readHeader(err?.response?.headers, "retry-after") ??
    readHeader(err?.headers, "retry-after") ??
    err?.retryAfter;

  if (raw === undefined || raw === null) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const text = String(value).trim();
  if (text.length === 0 || text.length > 64) return null;

  if (/^\d+(\.\d+)?$/.test(text)) {
    const ms = Math.ceil(Number(text) * 1000);
    return Number.isFinite(ms) ? ms : null;
  }

  // HTTP dates always contain a weekday/month name; this also stops
  // Date.parse() from accepting bare values such as "-1" as a year.
  if (!/[a-z]/i.test(text)) return null;
  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}
