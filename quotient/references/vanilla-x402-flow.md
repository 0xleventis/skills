<!-- GENERATED from public/skill/references/vanilla-x402-flow.md — edit there, then npm run skill:build -->

# Vanilla x402 Flow (Non-Bankr Agents)

Use this flow for agents that do not use Bankr wallet tooling.

## Preconditions

- Agent has access to a wallet capable of the required x402 signing scheme.
- Agent can parse response headers and retry requests with modified headers.
- Agent reads pricing metadata from `GET https://quotient-api-gateway.onrender.com/api/public/pricing`.

## Domain Rule

- Use the gateway domain (`https://quotient-api-gateway.onrender.com`) for both execution and discovery.

## Accepted Payment Requirements

The gateway can advertise multiple entries in `PAYMENT-REQUIRED.accepts`:

- Base USDC: `scheme: exact`, `network: eip155:8453`.
- Robinhood Chain USDG: `scheme: exact`, `network: eip155:4663`, canonical asset
  `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals.

Treat the runtime challenge as authoritative. To pay with USDG, require the `exact` scheme and
match both `eip155:4663` and the canonical asset address (case-insensitively). Do not select an
offer by the `USDG` symbol or a display name alone, and do not substitute another token contract.
Use the amount and EIP-712 details supplied by the selected requirement rather than rebuilding
or rescaling them from static documentation.

## Protocol Flow

1. Send request without payment headers.
2. If status is `402`, read `PAYMENT-REQUIRED`.
3. Parse `accepts` and select a requirement supported by the wallet and client.
4. If USDG is intended, verify the selected requirement's scheme, network, and asset tuple.
5. Build the payment payload from that exact requirement and sign it with your wallet.
6. Retry the same request with `PAYMENT-SIGNATURE`.
7. On success, inspect `PAYMENT-RESPONSE` and confirm the settled payment option.

## Reliability Rules

- Do not mutate path/query/body between challenge and paid retry.
- Do not silently fall back to a different network or asset when a specific payment option was requested.
- Use bounded retry with backoff on `429` and transient `5xx`.
- If signature is rejected, fetch a fresh challenge and rebuild payment payload.
- Treat signature creation as deterministic for a given challenge and signer.

## Minimal Pseudocode

```ts
const first = await fetch(url, init);
if (first.status !== 402) return first;

const required = first.headers.get("PAYMENT-REQUIRED");
if (!required) throw new Error("missing_payment_required_header");

const challenge = decodePaymentRequired(required);
const requirement = challenge.accepts.find((offer) =>
  offer.scheme === "exact" &&
  offer.network === "eip155:4663" &&
  offer.asset.toLowerCase() ===
    "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168".toLowerCase()
);
if (!requirement) throw new Error("usdg_payment_requirement_unavailable");

const paymentSignature = await signX402Payment(challenge, requirement, wallet);

const paid = await fetch(url, {
  ...init,
  headers: {
    ...(init.headers || {}),
    "PAYMENT-SIGNATURE": paymentSignature
  }
});

const responseReceipt = paid.headers.get("PAYMENT-RESPONSE");
return { paid, responseReceipt };
```

## Concrete TypeScript Example (x402 Client Wrapper)

This follows the x402 buyer quickstart pattern and automatically handles:
- `402` detection,
- `PAYMENT-SIGNATURE` construction,
- paid retry flow.

```ts
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { x402HTTPClient } from "@x402/core/client";
import { privateKeyToAccount } from "viem/accounts";

const baseUrl = process.env.QUOTIENT_BASE_URL!;
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;

const signer = privateKeyToAccount(evmPrivateKey);

const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const response = await fetchWithPayment(`${baseUrl}/api/v1/markets/mispriced`, {
  method: "GET",
  headers: { "Content-Type": "application/json" }
});

if (!response.ok) {
  throw new Error(`request_failed:${response.status}:${await response.text()}`);
}

const data = await response.json();
const httpClient = new x402HTTPClient(client);
const settle = httpClient.getPaymentSettleResponse((name) => response.headers.get(name));

console.log("markets:", data.markets?.length ?? 0);
console.log("payment_settlement:", settle);
```

Registering `eip155:*` makes the signer available to the exact EVM scheme on both offered
networks; it does not guarantee which offer a wrapper selects. If the payment must be USDG, use
the client's requirement selector/filter when available, or use the explicit challenge flow
above, and verify the settlement. Otherwise the wrapper may validly choose Base USDC.

## Bankr-Compatible Signer Adapter (If Needed)

If your Bankr client does not expose native x402 helpers, you can adapt Bankr's typed-data signing
to the same x402 wrapper flow.

Requirements for this adapter path:
- Provide a Bankr API key through `X-API-Key`.
- Ensure that key has Agent API access enabled and is not read-only, so `/agent/sign` can execute `eth_signTypedData_v4`.
- For USDG, ensure the Bankr-controlled wallet and installed client support the canonical
  `exact` offer on `eip155:4663`; verify the full requirement tuple before signing.

```ts
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

type TypedDataRequest = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

async function createBankrSigner(apiKey: string) {
  const meRes = await fetch("https://api.bankr.bot/agent/me", {
    headers: { "X-API-Key": apiKey }
  });
  if (!meRes.ok) throw new Error(`bankr_me_failed:${meRes.status}`);
  const me = await meRes.json();
  const address = me.walletAddress as `0x${string}`;

  return {
    address,
    // x402 schemes need an EIP-712 typed-data signer.
    async signTypedData(payload: TypedDataRequest): Promise<`0x${string}`> {
      const signRes = await fetch("https://api.bankr.bot/agent/sign", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey
        },
        body: JSON.stringify({
          signatureType: "eth_signTypedData_v4",
          typedData: payload
        })
      });
      if (!signRes.ok) throw new Error(`bankr_sign_failed:${signRes.status}`);
      const signed = await signRes.json();
      return signed.signature as `0x${string}`;
    }
  };
}

const bankrSigner = await createBankrSigner(process.env.BANKR_API_KEY!);
const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(bankrSigner as never));

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const res = await fetchWithPayment(
  `${process.env.QUOTIENT_BASE_URL}/api/v1/markets`,
  { method: "GET" }
);
```

Use the private-key signer path by default. Use the Bankr adapter path when your runtime only has
Bankr API signing access.
