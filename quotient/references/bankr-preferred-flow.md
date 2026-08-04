<!-- GENERATED from public/skill/references/bankr-preferred-flow.md — edit there, then npm run skill:build -->

# Bankr-Preferred x402 Flow

Use this flow when the agent has Bankr wallet/signing capability available.

## Why Bankr First

- Wallet provisioning is already handled in typical Bankr setups.
- Signing and submission tooling is streamlined for agents.
- Reduces integration friction for autonomous request loops.
- Bankr signing path requires `X-API-Key` credentials for Bankr Agent API calls (for example, `/agent/sign`).

## Runtime Requirements

- Runtime can call Bankr Agent API endpoints with `X-API-Key`.
- API key has Agent API access enabled and is not read-only, so typed-data signing is permitted.
- For USDG, the installed Bankr/x402 client supports the `exact` scheme on Robinhood Chain and
  the Bankr-controlled wallet holds the canonical USDG asset.

## Payment Options and Selection

Quotient can advertise Base USDC (`exact`, `eip155:8453`) and Robinhood Chain USDG
(`exact`, `eip155:4663`). The runtime challenge determines which options are live. The USDG
asset is the 6-decimal token at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`.

Bankr is supported for the x402 flow, but offer selection can depend on the installed Bankr CLI
and client version. Treat `PAYMENT-REQUIRED.accepts` as authoritative. If USDG is required,
select only the entry whose scheme is `exact`, network is `eip155:4663`, and asset matches the
canonical address case-insensitively. Do not infer the asset from the `USDG` symbol alone. If the
runtime cannot select or sign that offer, use Base USDC or the compatible client flow in
`references/vanilla-x402-flow.md`; do not rewrite the challenge.

## Request Sequence

1. Send request to a monetized Quotient endpoint with no payment header.
2. Receive `402 Payment Required` and parse `PAYMENT-REQUIRED`.
3. Select a payment requirement supported by the Bankr runtime; validate the full tuple when
   USDG is intended.
4. Produce a valid x402 payment signature using the Bankr-controlled wallet.
5. Retry the same request with `PAYMENT-SIGNATURE`.
6. Parse `PAYMENT-RESPONSE` from the successful response and confirm the settled option.

## Required Headers

- On paid retry: `PAYMENT-SIGNATURE`
- Optional idempotency extension if available from your client stack: `Payment-Identifier`

## Practical Notes

- Keep request method/path/query/body identical between initial and paid retry.
- Treat malformed challenge payloads as hard failures and do not guess values.
- A successful automatic `bankr x402 call` may use any compatible advertised offer. Inspect the
  challenge and settlement when the payment asset matters.
- If settlement succeeds, cache reusable session/payment state only if your client confirms it is valid.

## Implementation Reference

If your Bankr client does not provide native x402 request wrapping, use the shared implementation in:

- `references/vanilla-x402-flow.md` -> "Concrete TypeScript Example (x402 Client Wrapper)"
- `references/vanilla-x402-flow.md` -> "Bankr-Compatible Signer Adapter (If Needed)"

This gives Bankr and non-Bankr agents one common x402 execution path.
