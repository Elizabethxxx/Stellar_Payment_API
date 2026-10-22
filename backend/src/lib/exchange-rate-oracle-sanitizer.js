/**
 * Payload sanitization and strict validation for the Exchange Rate Oracle
 * Cache (issue #1442).
 *
 * The cache sits between three trust boundaries:
 *
 *   1. Request parameters   (route -> getExchangeRateQuote)
 *        asset codes and issuers come from the query string, the amount from
 *        the database. They form the cache key and the Horizon query.
 *   2. Horizon responses    (findStrictReceivePaths -> cache)
 *        third-party data that becomes a payer's send_max.
 *   3. The shared store     (Redis -> ExchangeRateCoordinator -> cache)
 *        anything that can write to Redis can try to plant a quote.
 *
 * Every boundary goes through this module:
 *
 *   sanitizeQuoteRequest()  strict input validation + canonicalisation, so
 *                           equivalent requests share one cache key and
 *                           malformed ones never reach Horizon or the cache.
 *   sanitizeQuote()         allow-list rebuild of a quote. Unknown fields,
 *                           prototype keys and wrong types are dropped or
 *                           rejected, so a poisoned entry is a cache miss,
 *                           never a quote.
 *
 * Validation failures from the request side are 400s and carry
 * `retryable: false`, so the oracle retry wrapper never repeats them.
 */

/** Stellar amounts: up to 7 decimal places, no sign, exponent or spaces. */
const AMOUNT_PATTERN = /^\d{1,19}(\.\d{1,7})?$/;
/** Accepts extra trailing zeros (e.g. a NUMERIC column rendered as "10.50000000"). */
const LOOSE_AMOUNT_PATTERN = /^\d{1,19}(\.\d{1,20})?$/;
/** Largest amount Stellar can represent: (2^63 - 1) stroops. */
const MAX_AMOUNT_STROOPS = 9_223_372_036_854_775_807n;

const ASSET_CODE_PATTERN = /^[A-Z0-9]{1,12}$/;
const ACCOUNT_ID_PATTERN = /^G[A-Z2-7]{55}$/;
/** Matches resolveAsset() in stellar/validators.js: XLM is always native. */
const NATIVE_CODE = 'XLM';

/** Horizon allows at most 6 intermediate hops in a path payment. */
export const MAX_PATH_HOPS = 6;
export const MAX_SLIPPAGE = 0.5;

export const ORACLE_VALIDATION_ERROR_CODE = 'EXCHANGE_RATE_INVALID_PARAMS';

export class ExchangeRateValidationError extends Error {
  /**
   * @param {string} message
   * @param {string} field the offending parameter
   */
  constructor(message, field) {
    super(message);
    this.name = 'ExchangeRateValidationError';
    this.field = field;
    this.code = ORACLE_VALIDATION_ERROR_CODE;
    this.status = 400;
    this.statusCode = 400;
    this.retryable = false;
  }
}

function fail(field, message) {
  throw new ExchangeRateValidationError(message, field);
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ED25519_PUBLIC_KEY_VERSION_BYTE = 6 << 3; // 'G'

function crc16XModem(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * Full StrKey check for an ed25519 public key (version byte + CRC16
 * checksum), implemented locally so validation does not depend on how a test
 * suite mocks the Stellar SDK.
 */
export function isValidAccountId(value) {
  if (typeof value !== 'string' || !ACCOUNT_ID_PATTERN.test(value)) return false;

  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  // 56 chars * 5 bits = 280 bits = exactly 35 bytes, with no padding bits.
  if (bytes.length !== 35 || (buffer & ((1 << bits) - 1)) !== 0) return false;
  if (bytes[0] !== ED25519_PUBLIC_KEY_VERSION_BYTE) return false;

  const payload = bytes.slice(0, 33);
  const checksum = bytes[33] | (bytes[34] << 8);
  return crc16XModem(payload) === checksum;
}

function toStroops(amount) {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'));
}

/**
 * Validate a Stellar amount string.
 *
 * The caller's formatting is preserved ("50.0000000" stays "50.0000000") so
 * API responses do not change shape. The only rewrite is dropping zero
 * padding beyond 7 decimals (a NUMERIC column rendered as "10.500000000"),
 * which carries no value.
 *
 * @param {unknown} value
 * @param {{ allowZero?: boolean }} [opts]
 * @returns {string|null} the validated amount, or null when invalid
 */
export function normalizeAmount(value, { allowZero = false } = {}) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return null;
  }

  if (!AMOUNT_PATTERN.test(text)) {
    if (!LOOSE_AMOUNT_PATTERN.test(text)) return null;
    const [whole, fraction] = text.split('.');
    if (/[^0]/.test(fraction.slice(7))) return null; // more precision than a stroop
    text = `${whole}.${fraction.slice(0, 7)}`;
  }

  const stroops = toStroops(text);
  if (stroops > MAX_AMOUNT_STROOPS) return null;
  if (!allowZero && stroops === 0n) return null;
  return text;
}

/**
 * Validate one asset (code + optional issuer), mirroring resolveAsset() in
 * stellar/validators.js so the cache key matches what is sent to Horizon.
 *
 * @returns {{ code: string, issuer: string|null }} upper-cased code; XLM has no issuer
 */
export function sanitizeAsset(code, issuer, field) {
  if (typeof code !== 'string') fail(field, `${field} must be a string`);
  const normalized = code.trim().toUpperCase();
  if (!ASSET_CODE_PATTERN.test(normalized)) {
    fail(field, `${field} must be 1-12 alphanumeric characters`);
  }
  if (normalized === NATIVE_CODE) {
    // resolveAsset() ignores the issuer for XLM; drop it so it cannot split
    // the cache key for the same native asset.
    return { code: NATIVE_CODE, issuer: null };
  }

  if (issuer === undefined || issuer === null || issuer === '') {
    fail(`${field}Issuer`, `${field}Issuer is required for non-native assets`);
  }
  if (typeof issuer !== 'string' || !isValidAccountId(issuer.trim())) {
    fail(`${field}Issuer`, `${field}Issuer must be a valid Stellar public key`);
  }
  return { code: normalized, issuer: issuer.trim() };
}

/**
 * Strictly validate and canonicalise getExchangeRateQuote() parameters.
 *
 * @param {object} params
 * @returns {{
 *   sourceAssetCode: string, sourceAssetIssuer: string|null,
 *   destAssetCode: string, destAssetIssuer: string|null,
 *   destAmount: string, sourceAccount: string|null, slippage: number
 * }}
 * @throws {ExchangeRateValidationError}
 */
export function sanitizeQuoteRequest(params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    fail('params', 'Quote parameters must be an object');
  }

  const source = sanitizeAsset(params.sourceAssetCode, params.sourceAssetIssuer, 'sourceAsset');
  const dest = sanitizeAsset(params.destAssetCode, params.destAssetIssuer, 'destAsset');

  const destAmount = normalizeAmount(params.destAmount);
  if (destAmount === null) {
    fail('destAmount', 'destAmount must be a positive Stellar amount with at most 7 decimal places');
  }

  let sourceAccount = null;
  if (params.sourceAccount !== undefined && params.sourceAccount !== null && params.sourceAccount !== '') {
    if (typeof params.sourceAccount !== 'string' || !isValidAccountId(params.sourceAccount.trim())) {
      fail('sourceAccount', 'sourceAccount must be a valid Stellar public key');
    }
    sourceAccount = params.sourceAccount.trim();
  }

  const slippage = Number(params.slippage);
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > MAX_SLIPPAGE) {
    fail('slippage', `slippage must be a number between 0 and ${MAX_SLIPPAGE}`);
  }

  return {
    sourceAssetCode: source.code,
    sourceAssetIssuer: source.issuer,
    destAssetCode: dest.code,
    destAssetIssuer: dest.issuer,
    destAmount,
    sourceAccount,
    slippage,
  };
}

/**
 * Validate an asset inside a quote without rewriting it: Horizon's casing is
 * kept so responses do not change.
 */
function sanitizeQuoteAsset(code, issuer) {
  if (typeof code !== 'string' || !ASSET_CODE_PATTERN.test(code.toUpperCase())) return null;
  if (issuer === null || issuer === undefined || issuer === '') {
    // Only the native asset may omit its issuer.
    return code.toUpperCase() === NATIVE_CODE ? { code, issuer: null } : null;
  }
  return isValidAccountId(issuer) ? { code, issuer } : null;
}

/**
 * Rebuild a quote from an allow-list of fields.
 *
 * Accepts quotes produced by the service, read back from the in-process
 * cache, or deserialised from the shared Redis store. Returns a fresh object
 * containing only known fields, or null when anything is malformed. Extra
 * fields (including `__proto__` / `constructor` keys from JSON.parse) never
 * survive.
 *
 * @param {unknown} data
 * @returns {object|null}
 */
export function sanitizeQuote(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;

  const source = sanitizeQuoteAsset(data.sourceAsset, data.sourceAssetIssuer);
  const dest = sanitizeQuoteAsset(data.destinationAsset, data.destinationAssetIssuer);
  if (!source || !dest) return null;

  // Quotes always carry amounts as strings; a number would already have lost
  // precision somewhere upstream.
  if (![data.sourceAmount, data.sendMax, data.destinationAmount].every((v) => typeof v === 'string')) {
    return null;
  }
  const sourceAmount = normalizeAmount(data.sourceAmount);
  const sendMax = normalizeAmount(data.sendMax);
  const destinationAmount = normalizeAmount(data.destinationAmount);
  if (!sourceAmount || !sendMax || !destinationAmount) return null;
  // send_max is source_amount plus slippage; anything lower would make the
  // payment fail, so it signals a corrupted entry.
  if (toStroops(sendMax) < toStroops(sourceAmount)) return null;

  const slippage = Number(data.slippage);
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > MAX_SLIPPAGE) return null;

  if (!Array.isArray(data.path) || data.path.length > MAX_PATH_HOPS) return null;
  const path = [];
  for (const hop of data.path) {
    if (hop === null || typeof hop !== 'object' || Array.isArray(hop)) return null;
    const asset = sanitizeQuoteAsset(hop.asset_code, hop.asset_issuer);
    if (!asset) return null;
    path.push({ asset_code: asset.code, asset_issuer: asset.issuer });
  }

  return {
    sourceAsset: source.code,
    sourceAssetIssuer: source.issuer,
    sourceAmount,
    sendMax,
    destinationAsset: dest.code,
    destinationAssetIssuer: dest.issuer,
    destinationAmount,
    path,
    slippage,
    cached: data.cached === true,
  };
}

/**
 * Boolean form of sanitizeQuote(), used as the shared-store validator.
 * @param {unknown} data
 */
export function isValidSanitizedQuote(data) {
  return sanitizeQuote(data) !== null;
}
