/**
 * SEP-0001 generator — payload sanitization and strict validation (#1457).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORG_NAME,
  SEP0001_INVALID_CONFIG,
  SEP0001_LIMITS,
  Sep0001ConfigError,
  generateStellarToml,
  generateStellarTomlReport,
  isValidEmail,
  isValidStellarAccount,
  isValidUrl,
  sanitizeOrgName,
  validateStellarToml,
} from "./sep0001-generator.js";

const ACCOUNT = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";
const SIGNING_PUBLIC = "GBTL47RTFR5EKMZSXWOQU735WBK7LRPPDIDK3JTNTCZZ7NUBBRDTVSK2";
const SIGNING_SECRET = "SAFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQX44I";
const BAD_CHECKSUM = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2BRUY4DQAT2B";

const ENV = Object.freeze({
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  API_BASE_URL: "https://api.example.com",
});

const merchant = (overrides = {}) => ({
  business_name: "Acme",
  email: "ops@acme.example",
  notification_email: "help@acme.example",
  recipient: ACCOUNT,
  branding_config: { homepage: "https://acme.example", logo_url: "https://acme.example/logo.png" },
  ...overrides,
});

const report = (m, env = {}) => generateStellarTomlReport(m, { env: { ...ENV, ...env } });

/** Parse top-level `KEY = "value"` lines and [ORG] keys, the way a strict reader would. */
function keysOf(toml) {
  return toml
    .split("\n")
    .filter((line) => /^[A-Za-z_]+ = /.test(line) || /^\[/.test(line))
    .map((line) => line.split(" = ")[0]);
}

describe("TOML injection resistance", () => {
  it.each([
    ['quote breakout', 'Acme"\nSIGNING_KEY = "GEVIL'],
    ["CRLF breakout", 'Acme\r\n[DOCUMENTATION]\r\nORG_URL = "https://evil"'],
    ["table header", "Acme\n[[CURRENCIES]]\ncode = \"FAKE\""],
    ["NUL and escape chars", "Acme\u0000\u001b[31m\u007f"],
    ["backslash before quote", 'Acme\\"\nX = "1'],
  ])("cannot inject keys or tables via %s in business_name", (_label, name) => {
    const { toml } = report(merchant({ business_name: name }));
    expect(keysOf(toml)).toEqual([
      "NETWORK_PASSPHRASE",
      "TRANSFER_SERVER",
      "ACCOUNTS",
      "DOCUMENTATION",
      "[ORG]",
      "name",
      "contact",
      "support",
      "homepage",
      "logo",
    ]);
    expect(validateStellarToml(toml)).toBe(true);
  });

  it("escapes control characters using TOML escape sequences", () => {
    const { toml } = report(merchant({ business_name: "A\tB\rC\u0001D\u007fE" }));
    expect(toml).toContain('name = "A\\tB\\rC\\u0001D\\u007fE"');
  });
});

describe("org name sanitization", () => {
  it("strips bidi override characters used for visual spoofing", () => {
    expect(sanitizeOrgName("Acme‮ moc.evil‬")).toEqual({ value: "Acme moc.evil", reason: "bidi_control" });
  });

  it("truncates by code point, not UTF-16 unit", () => {
    const { value, reason } = sanitizeOrgName("\u{1F600}".repeat(300));
    expect(reason).toBe("truncated");
    expect(Array.from(value)).toHaveLength(SEP0001_LIMITS.maxNameLength);
    expect(value).not.toMatch(/[\ud800-\udbff]$/); // no dangling surrogate
  });

  it.each([
    [undefined, null],
    [null, null],
    ["   ", "empty"],
    [42, "invalid_type"],
    [{ toString: () => "x" }, "invalid_type"],
  ])("falls back to the default name for %p", (input, reason) => {
    expect(sanitizeOrgName(input)).toEqual({ value: DEFAULT_ORG_NAME, reason });
  });
});

describe("field validation", () => {
  it("validates Stellar accounts including the StrKey checksum", () => {
    expect(isValidStellarAccount(ACCOUNT)).toBe(true);
    expect(isValidStellarAccount(BAD_CHECKSUM)).toBe(false);
    expect(isValidStellarAccount(SIGNING_SECRET)).toBe(false);
    expect(isValidStellarAccount(`${ACCOUNT}\n`)).toBe(false);
    expect(isValidStellarAccount(123)).toBe(false);
  });

  it("validates emails", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("a b@c.co")).toBe(false);
    expect(isValidEmail('x"@y.co')).toBe(false);
    expect(isValidEmail("no-at.example")).toBe(false);
    expect(isValidEmail(`${"a".repeat(250)}@b.co`)).toBe(false);
  });

  it("requires https merchant URLs without credentials", () => {
    expect(isValidUrl("https://acme.example/logo.png")).toBe(true);
    expect(isValidUrl("http://acme.example")).toBe(false);
    expect(isValidUrl("javascript:alert(1)")).toBe(false);
    expect(isValidUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isValidUrl("https://user:pass@acme.example")).toBe(false);
    expect(isValidUrl("https://acme.example/a b")).toBe(false);
    expect(isValidUrl(`https://acme.example/${"a".repeat(2100)}`)).toBe(false);
  });

  it("allows http only for localhost when explicitly permitted", () => {
    expect(isValidUrl("http://localhost:4000/api", { allowLocalHttp: true })).toBe(true);
    expect(isValidUrl("http://127.0.0.1/api", { allowLocalHttp: true })).toBe(true);
    expect(isValidUrl("http://api.example.com", { allowLocalHttp: true })).toBe(false);
  });
});

describe("generateStellarTomlReport", () => {
  it("returns no rejections for a clean merchant", () => {
    const { toml, rejections } = report(merchant(), { SIGNING_KEY: SIGNING_PUBLIC });
    expect(rejections).toEqual([]);
    expect(toml).toContain(`ACCOUNTS = ["${ACCOUNT}"]`);
    expect(toml).toContain(`SIGNING_KEY = "${SIGNING_PUBLIC}"`);
  });

  it("never publishes a secret seed as SIGNING_KEY and reports it", () => {
    const { toml, rejections } = report(merchant(), { SIGNING_KEY: SIGNING_SECRET });
    expect(toml).not.toContain(SIGNING_SECRET);
    expect(toml).not.toContain("SIGNING_KEY");
    expect(rejections).toContainEqual({ field: "SIGNING_KEY", reason: "secret_seed" });
  });

  it("omits and reports invalid optional fields instead of publishing them", () => {
    const { toml, rejections } = report(
      merchant({
        recipient: BAD_CHECKSUM,
        email: "not-an-email",
        notification_email: "x@y",
        branding_config: { homepage: "javascript:alert(1)", logo_url: "http://insecure.example/logo.png" },
      }),
      { SIGNING_KEY: "GARBAGE", FEDERATION_SERVER_URL: "ftp://fed.example", DOCS_URL: "https://u:p@docs.example" },
    );
    expect(rejections).toEqual([
      { field: "FEDERATION_SERVER_URL", reason: "invalid_url" },
      { field: "recipient", reason: "invalid_account" },
      { field: "DOCS_URL", reason: "invalid_url" },
      { field: "SIGNING_KEY", reason: "invalid_account" },
      { field: "email", reason: "invalid_email" },
      { field: "notification_email", reason: "invalid_email" },
      { field: "homepage", reason: "invalid_url" },
      { field: "logo_url", reason: "invalid_url" },
    ]);
    expect(keysOf(toml)).toEqual(["NETWORK_PASSPHRASE", "TRANSFER_SERVER", "[ORG]", "name"]);
    expect(validateStellarToml(toml)).toBe(true);
  });

  it("ignores a non-object branding_config", () => {
    const { toml } = report(merchant({ branding_config: "https://evil.example" }));
    expect(toml).not.toContain("homepage");
  });

  it.each([null, undefined, "merchant", 42, ["a"]])("rejects a non-object merchant (%p)", (input) => {
    expect(() => report(input)).toThrow("Merchant configuration required");
  });

  it("throws a typed config error for an invalid TRANSFER_SERVER", () => {
    expect(() => report(merchant(), { TRANSFER_SERVER_URL: "http://public.example/api" })).toThrow(
      Sep0001ConfigError,
    );
    expect(() => report(merchant(), { API_BASE_URL: "ftp://broken" })).toThrow(
      expect.objectContaining({ code: SEP0001_INVALID_CONFIG, field: "TRANSFER_SERVER_URL" }),
    );
  });

  it.each([
    "x".repeat(SEP0001_LIMITS.maxPassphraseLength + 1),
    "Test SDF Network\n[ORG]",
  ])("throws a typed config error for an unsafe network passphrase", (passphrase) => {
    expect(() => report(merchant(), { STELLAR_NETWORK_PASSPHRASE: passphrase })).toThrow(
      expect.objectContaining({ field: "STELLAR_NETWORK_PASSPHRASE" }),
    );
  });

  it("normalises a trailing slash on API_BASE_URL", () => {
    const { toml } = report(merchant(), { API_BASE_URL: "https://api.example.com/" });
    expect(toml).toContain('TRANSFER_SERVER = "https://api.example.com/api"');
    expect(toml).toContain('DOCUMENTATION = "https://api.example.com/api-docs"');
  });

  it("keeps generateStellarToml backwards compatible (string output)", () => {
    expect(typeof generateStellarToml(merchant(), { env: ENV })).toBe("string");
  });
});

describe("validateStellarToml strictness", () => {
  const base = 'NETWORK_PASSPHRASE = "x"\nTRANSFER_SERVER = "https://a"';

  it("requires the keys at the start of a line", () => {
    expect(validateStellarToml(base)).toBe(true);
    expect(validateStellarToml('name = "NETWORK_PASSPHRASE TRANSFER_SERVER"')).toBe(false);
  });

  it("rejects raw control characters and oversized documents", () => {
    expect(validateStellarToml(`${base}\r\nX = "1"`)).toBe(false);
    expect(validateStellarToml(`${base}\u0000`)).toBe(false);
    expect(validateStellarToml(`${base}\n# ${"a".repeat(SEP0001_LIMITS.maxDocumentBytes)}`)).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(validateStellarToml({ toString: () => base })).toBe(false);
  });
});
