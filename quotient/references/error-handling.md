<!-- GENERATED from public/skill/references/error-handling.md — edit there, then npm run skill:build -->

# Error Handling (API Key and x402 Skill Paths)

This file documents the error contract for both supported auth paths: API key and x402.

## Status Codes

- `200` - Success.
- `401 invalid_api_key` - API key missing, invalid, or revoked.
- `401 gateway_required` - Gateway auth requirement not satisfied.
- `402 payment_required` - Payment challenge issued; read `PAYMENT-REQUIRED`, sign, retry with `PAYMENT-SIGNATURE`.
- `403 insufficient_credits` - Account credits are exhausted.
- `404` - Resource slug not found.
- `422` - Invalid request parameters or cursor mismatch.
- `429` - Rate limited; back off and retry.
- `502 upstream_unavailable` - A required upstream (Polymarket data-api) is down; see below.
- `5xx` - Upstream or gateway transient failure; retry with bounded backoff.

## 502 upstream_unavailable and Degraded Modes

- `GET /api/v1/portfolio` is **fail-closed**: if the Polymarket data-api is unavailable it returns `502 upstream_unavailable` rather than a partial position list. Retry with backoff; never treat a 502 as "no positions".
- The optional `perps` annex inside a portfolio response degrades **independently**: on perps-upstream failure the response is still `200` and the `perps` block carries `"error": "upstream_unavailable"`.
- `GET /api/v1/signals/oil` **never returns 502** for upstream failures — it responds `200` with `degraded: true` and the failed mark block set to `null` (and `reading_missing: true` when no reading exists). Check those flags instead of the status code.
- `GET /api/v1/signals` degrades pricing, not availability: if live CLOB midpoints are unavailable, items carry `live_priced: false` with graph-odds fallback values. Treat those convergence reads as stale.

## API Key-Specific Failure Cases

- `401 invalid_api_key`: rotate or replace key from the Quotient account/developer area.
- `403 insufficient_credits`: top up billing/credits or switch to x402 flow for paid requests.

## x402-Specific Failure Cases

- Missing `PAYMENT-REQUIRED` on `402`: treat as gateway/proxy error and stop.
- Missing `PAYMENT-RESPONSE` after paid success: treat response as incomplete; log request id.
- Payment signature rejected: request a new challenge and sign again.

## Deprecation Signals

- `GET /api/v1/narratives` accepts the legacy `x-api-key` header for one more release. Responses authorized that way carry a `Deprecation: true` header. Migrate to `x-quotient-api-key` (or x402) now; the legacy path is removed in the next release.
- Treat any `Deprecation: true` header as a migration signal, not an error — the response body is still valid.

## Script Exit Codes

The skill's helper scripts (`quotient.sh`, `pm.sh`, `signal-strategy.mjs`, `converge-monitor.sh`) use a shared exit-code contract:

- `0` - Success.
- `1` - API/HTTP error (non-2xx from Quotient or an external venue after retries).
- `2` - Config/usage error (missing `QUOTIENT_API_KEY`, bad arguments); fix inputs, do not retry.
- `3` - Partial data (some sub-reads degraded or unavailable — e.g. oil `degraded: true`, a null mark block, or `live_priced: false` rows); output is usable but flagged.

## Retry Guidance

- Use exponential backoff with jitter for `429`, `502`, and other `5xx`.
- Do not retry `422` without correcting inputs.
- Keep retries idempotent and bounded.
