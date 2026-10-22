/**
 * SEP-0001 stellar.toml generator
 * Generates TOML content for merchant's Stellar business information
 *
 * Payload sanitization and strict validation (issue #1457):
 *   - Every value is TOML-escaped, including all control characters, so no
 *     merchant-controlled string can break out of its quoted value and
 *     inject keys or tables into the published document.
 *   - Unicode bidi overrides are stripped (visual spoofing of the org name).
 *   - Stellar accounts and SIGNING_KEY must be valid public keys (StrKey
 *     checksum). A secret seed configured as SIGNING_KEY is never published.
 *   - Emails and URLs are validated; merchant URLs must be https and URLs may
 *     not carry credentials. Invalid optional fields are omitted and reported.
 *   - Lengths are bounded and the whole document is capped at 100 KB, the
 *     SEP-0001 size limit.
 */

import * as StellarSdk from "stellar-sdk";

export const SEP0001_LIMITS = Object.freeze({
  maxNameLength: 256,
  maxEmailLength: 254,
  maxUrlLength: 2048,
  maxPassphraseLength: 128,
  maxDocumentBytes: 100 * 1024,
});

export const DEFAULT_ORG_NAME = "Stellar Payment Merchant";
const DEFAULT_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const DEFAULT_API_BASE_URL = "http://localhost:4000";

/** Error code for server configuration that cannot produce a valid stellar.toml. */
export const SEP0001_INVALID_CONFIG = "SEP0001_INVALID_CONFIG";

export class Sep0001ConfigError extends Error {
  constructor(field, message) {
    super(message);
    this.name = "Sep0001ConfigError";
    this.code = SEP0001_INVALID_CONFIG;
    this.field = field;
  }
}

const TOML_ESCAPES = {
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
};
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_TEST = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const RAW_CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏]/g;
const EMAIL_PATTERN = /^[^\s@"<>\\,;()[\]]+@[^\s@"<>\\,;()[\]]+\.[^\s@"<>\\,;()[\]]+$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Escape TOML string values
 */
function escapeTomlString(str) {
  if (!str) return '""';
  const escaped = String(str)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(
      CONTROL_CHARS,
      (ch) => TOML_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  return `"${escaped}"`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate a Stellar account id (G..., 56 chars, valid StrKey checksum). */
export function isValidStellarAccount(value) {
  return typeof value === "string" && StellarSdk.StrKey.isValidEd25519PublicKey(value);
}

/** Validate an email address for the [ORG] section. */
export function isValidEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= SEP0001_LIMITS.maxEmailLength &&
    EMAIL_PATTERN.test(value)
  );
}

/**
 * Validate a URL.
 *
 * @param {unknown} value
 * @param {{ allowLocalHttp?: boolean }} [options]  Allow http:// for localhost
 *   (development defaults). Everything else must be https.
 */
export function isValidUrl(value, { allowLocalHttp = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > SEP0001_LIMITS.maxUrlLength) {
    return false;
  }
  if (CONTROL_CHARS_TEST.test(value) || /\s/.test(value)) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === "https:") return true;
  return allowLocalHttp && parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname);
}

/**
 * Normalize the organisation name: strip bidi overrides, trim, cap length.
 * @returns {{ value: string, reason: string|null }}
 */
export function sanitizeOrgName(value) {
  if (typeof value !== "string") {
    return { value: DEFAULT_ORG_NAME, reason: value == null ? null : "invalid_type" };
  }
  let reason = null;
  let name = value.replace(BIDI_CONTROLS, () => {
    reason = "bidi_control";
    return "";
  });
  name = name.trim();
  if (!name) return { value: DEFAULT_ORG_NAME, reason: reason ?? "empty" };
  if (name.length > SEP0001_LIMITS.maxNameLength) {
    name = Array.from(name).slice(0, SEP0001_LIMITS.maxNameLength).join("");
    reason = "truncated";
  }
  return { value: name, reason };
}

function readEnvUrl(env, key, fallback, rejections, { required = false } = {}) {
  const raw = env[key];
  const value = raw === undefined || raw === "" ? fallback : String(raw).trim();
  if (value === undefined) return undefined;
  if (isValidUrl(value, { allowLocalHttp: true })) return value;
  if (required) {
    throw new Sep0001ConfigError(key, `${key} must be an https URL without credentials`);
  }
  rejections.push({ field: key, reason: "invalid_url" });
  return undefined;
}

/**
 * Generate TOML content plus a report of every field that was rejected or
 * altered by sanitization.
 *
 * @param {object} merchant
 * @param {{ env?: Record<string, string|undefined> }} [options]
 * @returns {{ toml: string, rejections: Array<{ field: string, reason: string }> }}
 * @throws {Error} "Merchant configuration required" for a missing/non-object merchant
 * @throws {Sep0001ConfigError} when server configuration makes a valid document impossible
 */
export function generateStellarTomlReport(merchant, { env = process.env } = {}) {
  if (!isPlainObject(merchant)) {
    throw new Error("Merchant configuration required");
  }

  const rejections = [];
  const lines = [];

  // NETWORK_PASSPHRASE - required for Stellar
  const networkPassphrase = env.STELLAR_NETWORK_PASSPHRASE || DEFAULT_NETWORK_PASSPHRASE;
  if (
    typeof networkPassphrase !== "string" ||
    networkPassphrase.length > SEP0001_LIMITS.maxPassphraseLength ||
    CONTROL_CHARS_TEST.test(networkPassphrase)
  ) {
    throw new Sep0001ConfigError(
      "STELLAR_NETWORK_PASSPHRASE",
      "STELLAR_NETWORK_PASSPHRASE must be a printable string of at most 128 characters",
    );
  }
  lines.push(`NETWORK_PASSPHRASE = ${escapeTomlString(networkPassphrase)}`);
  lines.push("");

  const apiBaseUrl = String(env.API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, "");

  // TRANSFER_SERVER - this API's payment endpoint
  const transferServer = readEnvUrl(env, "TRANSFER_SERVER_URL", `${apiBaseUrl}/api`, rejections, {
    required: true,
  });
  lines.push(`TRANSFER_SERVER = ${escapeTomlString(transferServer)}`);
  lines.push("");

  // FEDERATION_SERVER - optional, for name resolution
  const federationServer = readEnvUrl(env, "FEDERATION_SERVER_URL", undefined, rejections);
  if (federationServer) {
    lines.push(`FEDERATION_SERVER = ${escapeTomlString(federationServer)}`);
    lines.push("");
  }

  // ACCOUNTS - merchant's Stellar accounts
  if (merchant.recipient != null && merchant.recipient !== "") {
    if (isValidStellarAccount(merchant.recipient)) {
      lines.push(`ACCOUNTS = [${escapeTomlString(merchant.recipient)}]`);
      lines.push("");
    } else {
      rejections.push({ field: "recipient", reason: "invalid_account" });
    }
  }

  // DOCUMENTATION - link to API documentation
  const docsUrl = readEnvUrl(env, "DOCS_URL", `${apiBaseUrl}/api-docs`, rejections);
  if (docsUrl) {
    lines.push(`DOCUMENTATION = ${escapeTomlString(docsUrl)}`);
    lines.push("");
  }

  // SIGNING_KEY - optional; must be a PUBLIC key. Never publish a secret seed.
  if (env.SIGNING_KEY) {
    const signingKey = String(env.SIGNING_KEY).trim();
    if (isValidStellarAccount(signingKey)) {
      lines.push(`SIGNING_KEY = ${escapeTomlString(signingKey)}`);
      lines.push("");
    } else if (StellarSdk.StrKey.isValidEd25519SecretSeed(signingKey)) {
      rejections.push({ field: "SIGNING_KEY", reason: "secret_seed" });
    } else {
      rejections.push({ field: "SIGNING_KEY", reason: "invalid_account" });
    }
  }

  // ORG section with merchant information
  const orgName = sanitizeOrgName(merchant.business_name);
  if (orgName.reason) rejections.push({ field: "business_name", reason: orgName.reason });
  lines.push("[ORG]");
  lines.push(`name = ${escapeTomlString(orgName.value)}`);

  if (merchant.email) {
    if (isValidEmail(merchant.email)) {
      lines.push(`contact = ${escapeTomlString(merchant.email)}`);
    } else {
      rejections.push({ field: "email", reason: "invalid_email" });
    }
  }

  if (merchant.notification_email) {
    if (isValidEmail(merchant.notification_email)) {
      lines.push(`support = ${escapeTomlString(merchant.notification_email)}`);
    } else {
      rejections.push({ field: "notification_email", reason: "invalid_email" });
    }
  }

  const branding = isPlainObject(merchant.branding_config) ? merchant.branding_config : {};

  // Add homepage if available in branding config
  if (branding.homepage) {
    if (isValidUrl(branding.homepage)) {
      lines.push(`homepage = ${escapeTomlString(branding.homepage)}`);
    } else {
      rejections.push({ field: "homepage", reason: "invalid_url" });
    }
  }

  // Add logo if available in branding config
  if (branding.logo_url) {
    if (isValidUrl(branding.logo_url)) {
      lines.push(`logo = ${escapeTomlString(branding.logo_url)}`);
    } else {
      rejections.push({ field: "logo_url", reason: "invalid_url" });
    }
  }

  return { toml: lines.join("\n"), rejections };
}

/**
 * Generate TOML content from merchant configuration
 */
export function generateStellarToml(merchant, options) {
  return generateStellarTomlReport(merchant, options).toml;
}

/**
 * Validate TOML content: required keys at the start of a line, no raw
 * control characters, and within the SEP-0001 100 KB size limit.
 */
export function validateStellarToml(tomlContent) {
  if (!tomlContent || typeof tomlContent !== "string") return false;
  if (Buffer.byteLength(tomlContent, "utf8") > SEP0001_LIMITS.maxDocumentBytes) return false;
  if (RAW_CONTROL_EXCEPT_NEWLINE.test(tomlContent)) return false;

  // Check for required fields
  const hasNetworkPassphrase = /^NETWORK_PASSPHRASE = "/m.test(tomlContent);
  const hasTransferServer = /^TRANSFER_SERVER = "/m.test(tomlContent);

  return hasNetworkPassphrase && hasTransferServer;
}
