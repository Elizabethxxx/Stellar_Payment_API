# SEP-0001 stellar.toml Generator Guide

This guide explains how to use the SEP-0001 stellar.toml generator to expose your merchant business information according to the Stellar protocol standard.

## Overview

The SEP-0001 standard defines how Stellar anchors and payment processors should publish their business information. The Stellar Payment API automatically generates a `stellar.toml` file for each merchant based on their configuration.

## Accessing stellar.toml

The `stellar.toml` file is available at:

```
GET /.well-known/stellar.toml?merchant_id=<merchant_id>
```

### Public Access

If you're authenticated with an API key, you can omit the `merchant_id` parameter:

```
GET /.well-known/stellar.toml
```

The API will use your authenticated merchant's configuration.

### Example Request

```bash
curl https://api.example.com/.well-known/stellar.toml?merchant_id=550e8400-e29b-41d4-a716-446655440000
```

### Example Response

```toml
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
TRANSFER_SERVER = "https://api.example.com/api"
DOCUMENTATION = "https://api.example.com/api-docs"
ACCOUNTS = ["GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57"]

[ORG]
name = "Acme Payment Services"
contact = "merchant@acme.com"
support = "support@acme.com"
homepage = "https://acme.com"
logo = "https://acme.com/logo.png"
```

## Configuration

The stellar.toml is generated from:

1. **Environment Variables** (server-wide settings):
   - `STELLAR_NETWORK_PASSPHRASE`: Network to use (default: "Test SDF Network ; September 2015")
   - `TRANSFER_SERVER_URL`: Payment endpoint (default: `{API_BASE_URL}/api`)
   - `API_BASE_URL`: Base URL of the API (default: "http://localhost:4000")
   - `FEDERATION_SERVER_URL`: Optional federation server
   - `DOCS_URL`: Documentation URL (default: `{API_BASE_URL}/api-docs`)
   - `SIGNING_KEY`: Optional **public** signing key (`G...`). A secret seed (`S...`) is never published.

2. **Merchant Settings** (from database):
   - `business_name`: Organization name
   - `email`: Contact email
   - `notification_email`: Support email
   - `recipient`: Stellar account address
   - `branding_config.homepage`: Organization homepage
   - `branding_config.logo_url`: Organization logo URL

## Environment Setup

Configure these environment variables in your `.env` file:

```bash
# Required
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
API_BASE_URL="https://api.example.com"

# Optional
TRANSFER_SERVER_URL="https://api.example.com/api"
FEDERATION_SERVER_URL="https://federation.example.com"
DOCS_URL="https://docs.example.com"
SIGNING_KEY="GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57"
```

## Merchant Configuration

Merchants can configure their stellar.toml information through:

1. **Basic Information** (set during registration):
   - `business_name`: Your organization name
   - `email`: Contact email
   - `notification_email`: Support email

2. **Stellar Account** (set during registration):
   - `recipient`: Your Stellar account address (e.g., `GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57`)

3. **Branding Configuration** (via merchant settings):
   - `branding_config.homepage`: Your website URL
   - `branding_config.logo_url`: Your logo URL

### Example: Setting Branding Configuration

```bash
curl -X POST https://api.example.com/api/merchant-branding \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "homepage": "https://acme.com",
    "logo_url": "https://acme.com/logo.png"
  }'
```

## Generated Fields

### Required Fields

- **NETWORK_PASSPHRASE**: The Stellar network to use
  - Testnet: `"Test SDF Network ; September 2015"`
  - Public: `"Public Global Stellar Network ; September 2015"`

- **TRANSFER_SERVER**: URL of the payment API endpoint
  - Used by wallets to initiate payments
  - Example: `"https://api.example.com/api"`

### Optional Fields

- **FEDERATION_SERVER**: URL for name resolution
  - Allows users to send payments using `username*domain.com` format
  - Example: `"https://federation.example.com"`

- **ACCOUNTS**: List of Stellar accounts operated by the merchant
  - Example: `["GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57"]`

- **DOCUMENTATION**: URL to API documentation
  - Example: `"https://api.example.com/api-docs"`

- **SIGNING_KEY**: Public key for transaction signing
  - Example: `"GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57"`

### Organization Section

The `[ORG]` section contains merchant information:

- **name**: Organization name
- **contact**: Primary contact email
- **support**: Support email
- **homepage**: Organization website
- **logo**: Organization logo URL

## Validation

The stellar.toml is validated to ensure:

1. **Required fields present**: NETWORK_PASSPHRASE and TRANSFER_SERVER, each at the start of a line
2. **Valid TOML syntax**: Proper formatting and escaping
3. **Valid URLs**: Properly formatted URLs
4. **Valid Stellar addresses**: Properly formatted account addresses
5. **Size**: the document is at most 100 KB (the SEP-0001 limit)

### Payload sanitization and strict validation (issue #1457)

Every value comes from the merchant record or server environment, and the
generator treats all of it as untrusted.

| Input | Rule | If invalid |
|---|---|---|
| `merchant_id` query param | Single value, must be a UUID | `400`. The database is not queried. |
| `business_name` | Bidi override characters (U+202A–202E, U+2066–2069, U+200E/F) stripped, trimmed, max 256 characters | Falls back to `Stellar Payment Merchant` when empty or not a string |
| All string values | TOML-escaped, including `\r`, `\t`, and every other control character (`\uXXXX`) | A value can never close its quotes and inject keys or `[TABLES]` |
| `recipient` → `ACCOUNTS` | Valid Stellar public key, StrKey checksum included | `ACCOUNTS` omitted |
| `SIGNING_KEY` | Valid Stellar **public** key | Omitted. A secret seed is never published and is logged as an error (without the value). |
| `email`, `notification_email` | Email syntax, max 254 characters | Field omitted |
| `branding_config.homepage` / `logo_url` | `https` URL, no credentials, no whitespace, max 2048 characters | Field omitted |
| `TRANSFER_SERVER_URL` / `API_BASE_URL` | `https` URL. `http` is allowed only for `localhost`/`127.0.0.1`. No credentials. | `500 Failed to generate valid stellar.toml`. Details are logged, never returned. |
| `FEDERATION_SERVER_URL`, `DOCS_URL` | Same URL rules | Field omitted |
| `STELLAR_NETWORK_PASSPHRASE` | Printable, max 128 characters | `500`, as above |

Omitted or altered fields are logged (`SEP-0001: fields omitted or altered by
sanitization`) and counted in `sep0001_rejected_fields_total{field,reason}`.

Responses also send `Access-Control-Allow-Origin: *`, which SEP-0001 requires
so browser wallets can read the file, and `X-Content-Type-Options: nosniff`.

## Monitoring (issue #1458)

Metrics (merged into `GET /metrics`):

| Metric | Labels | Meaning |
|---|---|---|
| `sep0001_requests_total` | `outcome` = `success` / `invalid_request` / `not_found` / `lookup_error` / `generation_error` | Requests by outcome |
| `sep0001_generation_duration_seconds` | `outcome` | Lookup + generation latency |
| `sep0001_document_size_bytes` | — | Served document size |
| `sep0001_rejected_fields_total` | `field`, `reason` | Sanitization rejections |
| `sep0001_health_state` | — | `0` healthy, `1` degraded, `2` unhealthy |
| `sep0001_error_ratio` | — | Rolling-window server-error ratio |
| `sep0001_last_success_timestamp_seconds` | — | Last successful response |

All label values come from fixed sets. Merchant ids never become labels.

Health: `GET /health/sep0001` returns the rolling-window snapshot (5 minutes by
default). It responds `503` only when unhealthy. `/health` also reports
`services.sep0001_generator` for information.

| Status | Condition (with at least `SEP0001_HEALTH_MIN_SAMPLES`, default 10) |
|---|---|
| `unhealthy` | server-error ratio (`lookup_error` + `generation_error`) ≥ `SEP0001_UNHEALTHY_ERROR_RATIO` (default 0.25) |
| `degraded` | server-error ratio ≥ `SEP0001_DEGRADED_ERROR_RATIO` (default 0.05), or a secret seed was refused as `SIGNING_KEY` in the window |

`400` and `404` responses are client errors and do not affect health. The
window is set by `SEP0001_HEALTH_WINDOW_MS`. Alerting rules are in
`docs/alerts/sep0001-generator.rules.yml`.

## Caching

The stellar.toml endpoint includes caching headers:

```
Cache-Control: public, max-age=3600
```

This means:
- Responses are cached for 1 hour
- CDNs and browsers will cache the response
- Changes to merchant configuration may take up to 1 hour to propagate

To bypass caching during testing:

```bash
curl -H "Cache-Control: no-cache" https://api.example.com/.well-known/stellar.toml
```

## Integration with Stellar Wallets

Stellar wallets use stellar.toml to:

1. **Discover payment endpoints**: Find the TRANSFER_SERVER URL
2. **Verify merchant identity**: Check the organization information
3. **Display branding**: Show the logo and homepage
4. **Validate accounts**: Verify the merchant's Stellar accounts

### Example: Wallet Integration

```javascript
// Fetch stellar.toml
const response = await fetch('https://api.example.com/.well-known/stellar.toml');
const toml = await response.text();

// Parse TOML (using a TOML parser library)
const config = parseToml(toml);

// Use configuration
console.log('Transfer Server:', config.TRANSFER_SERVER);
console.log('Organization:', config.ORG.name);
console.log('Logo:', config.ORG.logo);
```

## Testing

### Validate stellar.toml Format

Use the Stellar Laboratory to validate your stellar.toml:

1. Go to https://laboratory.stellar.org/
2. Select "SEP-0001" from the menu
3. Enter your stellar.toml URL
4. Click "Validate"

### Manual Testing

```bash
# Fetch stellar.toml
curl https://api.example.com/.well-known/stellar.toml

# Validate TOML syntax
curl https://api.example.com/.well-known/stellar.toml | toml-lint

# Check specific fields
curl https://api.example.com/.well-known/stellar.toml | grep TRANSFER_SERVER
```

### Test with Stellar SDK

```javascript
import { StellarTomlResolver } from 'stellar-sdk';

const domain = 'api.example.com';
const toml = await StellarTomlResolver.resolve(domain);

console.log('Transfer Server:', toml.TRANSFER_SERVER);
console.log('Accounts:', toml.ACCOUNTS);
```

## Troubleshooting

### stellar.toml Not Found

- Ensure the endpoint is accessible at `/.well-known/stellar.toml`
- Check that your merchant_id is valid
- Verify the merchant hasn't been deleted

### Invalid TOML Format

- Check for special characters in merchant information
- Ensure URLs are properly formatted
- Verify email addresses are valid

### Missing Fields

- Ensure merchant has a `business_name` set
- Verify `recipient` (Stellar account) is configured
- Check environment variables are set correctly

### Caching Issues

- Use `Cache-Control: no-cache` header to bypass cache
- Wait 1 hour for changes to propagate
- Clear CDN cache if using a CDN

## Retry with Exponential Backoff (#1459)

The only I/O behind `GET /.well-known/stellar.toml` is the merchant lookup.
It is retried when it fails transiently (`src/lib/sep0001-retry.js`):

- Retried: network errors, 408/429/5xx, connection-class Postgres errors.
- Not retried: unknown or invalid merchant ids, PostgREST client errors.
- Delay: full jitter, `random(0, min(max, base * 2^n))`.

| Variable | Default | Clamp |
|---|---|---|
| `SEP0001_RETRY_MAX_ATTEMPTS` | 3 | 1-5 |
| `SEP0001_RETRY_BASE_DELAY_MS` | 100 | 0-5000 |
| `SEP0001_RETRY_MAX_DELAY_MS` | 1000 | base-5000 |

If the lookup is still failing transiently after the last attempt, the
endpoint answers **503** with `Retry-After: 5` instead of 500, so wallets
retry later instead of treating the domain as having no stellar.toml.
Deterministic lookup errors still return 500. Every error response carries
`Cache-Control: no-store`, so a CDN never caches a failure for the hour that
successful responses are cached.

Retry outcomes are exported as
`sep0001_merchant_lookup_retries_total{result="scheduled|recovered|exhausted"}`
on `GET /metrics`. Logs carry the error code, attempt count and message, never
the merchant record.

## Security Considerations

1. **Public Information**: stellar.toml is publicly accessible
   - Don't include sensitive information
   - Only include information you want to share publicly
   - `SIGNING_KEY` must be the public key. If a secret seed is configured, the
     generator refuses to publish it and `Sep0001SecretSigningKeyRefused` fires.
     Treat that seed as exposed in config and rotate it.

2. **HTTPS Required**: Always use HTTPS for stellar.toml
   - Wallets will reject HTTP endpoints
   - Ensures data integrity

3. **Validation**: Wallets validate stellar.toml
   - Invalid TOML will be rejected
   - Test thoroughly before deploying

4. **Updates**: Changes may take time to propagate
   - Plan updates in advance
   - Communicate changes to users

## SEP-0001 Standard

For more information about the SEP-0001 standard, see:

- [SEP-0001 Specification](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0030.md)
- [Stellar Documentation](https://developers.stellar.org/docs/learn/fundamentals/stellar-toml)
- [Stellar Laboratory](https://laboratory.stellar.org/)
