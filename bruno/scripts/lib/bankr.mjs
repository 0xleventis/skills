// Submits a raw EVM transaction via Bankr's Wallet API, signing/broadcasting with the installing user's
// own Bankr wallet. Requires BANKR_API_KEY in the environment (never hardcode a key here, and never accept
// one pasted into chat — env var or ~/.bankr/config.json only, same rule as clanker-legacy-rewards).

const BANKR_API_URL = process.env.BANKR_API_URL || "https://api.bankr.bot";
const BANKR_API_KEY = process.env.BANKR_API_KEY;

export function requireBankrApiKey() {
  if (!BANKR_API_KEY) {
    throw new Error(
      "BANKR_API_KEY isn't set. Run `bankr login` (or export BANKR_API_KEY / set it in ~/.bankr/config.json) before launching."
    );
  }
}

export async function bankrWhoami() {
  requireBankrApiKey();
  const res = await fetch(`${BANKR_API_URL}/wallet/me`, {
    headers: { "X-API-Key": BANKR_API_KEY },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Bankr /wallet/me failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

/** {to, data, value (wei, bigint|string), chainId} -> Bankr's /wallet/submit response
 * ({success, transactionHash, status, blockNumber, chainId, ...}). Retries transient failures the same
 * way clanker-legacy-rewards' submitTxBankr does. */
export async function submitTxBankr({ to, data, value = 0n, chainId, description }) {
  requireBankrApiKey();
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BANKR_API_URL}/wallet/submit`, {
        method: "POST",
        headers: { "X-API-Key": BANKR_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction: { to, data, value: value.toString(), chainId },
          description,
          waitForConfirmation: true,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`Bankr /wallet/submit failed (${res.status}): ${JSON.stringify(body)}`);
      }
      return body;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        console.error(`  retrying submit (attempt ${attempt} failed: ${err.message})`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw lastErr;
}
