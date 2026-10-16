/**
 * Automated retry with exponential backoff for the SEP-0001 Stellar Info
 * Generator (issue #1459).
 *
 * `GET /.well-known/stellar.toml` is polled by wallets, anchors and
 * validators. Its only I/O is the merchant lookup. A single dropped
 * connection or 5xx from Supabase used to turn into a 500, which wallets
 * cache as "no stellar.toml". The lookup is a read, so retrying it is safe.
 *
 *   - Retried: network errors, 408/429/5xx, connection-class Postgres errors
 *     (shared classifier `isRetryableSessionError`).
 *   - Never retried: invalid ids (22P02), PostgREST/client errors, "no row".
 *   - Delay: full jitter, random(0, min(maxDelay, base * 2^n)).
 *   - Budget: SEP0001_RETRY_MAX_ATTEMPTS (default 3, max 5),
 *     SEP0001_RETRY_BASE_DELAY_MS (default 100), SEP0001_RETRY_MAX_DELAY_MS
 *     (default 1000, max 5000). Small on purpose: this is a request path.
 *
 * Retry outcomes are exported as `sep0001_merchant_lookup_retries_total`.
 * Labels come from a fixed set; merchant ids never become labels or log
 * fields beyond the request's own structured context.
 */

import client from "prom-client";
import { register } from "./metrics.js";
import { resolveBackoffOptions, retrySupabaseRead } from "./backoff-retry.js";
import { isRetryableSessionError } from "./payment-session-retry.js";

export const DEFAULT_SEP0001_RETRY_OPTIONS = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
});

const SPEC = Object.freeze({
  envPrefix: "SEP0001_RETRY",
  defaults: DEFAULT_SEP0001_RETRY_OPTIONS,
  maxAttemptsCeiling: 5,
  maxDelayCeilingMs: 5000,
});

/** result: scheduled | recovered | exhausted */
export const sep0001LookupRetriesTotal = new client.Counter({
  name: "sep0001_merchant_lookup_retries_total",
  help: "SEP-0001 stellar.toml merchant lookup retries with exponential backoff, by result",
  labelNames: ["result"],
  registers: [],
});
register.registerMetric(sep0001LookupRetriesTotal);

export const MERCHANT_TOML_FIELDS =
  "id, business_name, email, notification_email, recipient, branding_config";

/** @param {object} [options] @param {Record<string,string|undefined>} [env] */
export function resolveSep0001RetryOptions(options = {}, env = process.env) {
  return resolveBackoffOptions(options, env, SPEC);
}

/**
 * True when a lookup error is transient (worth a 503 + retry) rather than a
 * deterministic failure.
 *
 * @param {unknown} err
 */
export function isTransientSep0001Error(err) {
  return isRetryableSessionError(err);
}

/**
 * Fetch the merchant row used to build stellar.toml, retrying transient
 * failures. Returns the final `{ data, error }` exactly like the plain
 * Supabase call, so callers keep their own 404/500 handling.
 *
 * @param {object} supabase  Supabase client
 * @param {string} merchantId
 * @param {object} [options] maxAttempts, baseDelayMs, maxDelayMs, sleep, random
 * @returns {Promise<{data: object | null, error: object | null}>}
 */
export async function fetchMerchantForStellarToml(supabase, merchantId, options = {}) {
  const { sleep, random } = options;
  return retrySupabaseRead(
    () =>
      supabase
        .from("merchants")
        .select(MERCHANT_TOML_FIELDS)
        .eq("id", merchantId)
        .is("deleted_at", null)
        .maybeSingle(),
    {
      resolved: resolveSep0001RetryOptions(options),
      label: "sep0001-merchant-lookup",
      shouldRetry: isTransientSep0001Error,
      sleep,
      random,
      onRetry: () => sep0001LookupRetriesTotal.inc({ result: "scheduled" }),
      onRecovered: () => sep0001LookupRetriesTotal.inc({ result: "recovered" }),
      onExhausted: () => sep0001LookupRetriesTotal.inc({ result: "exhausted" }),
    },
  );
}
