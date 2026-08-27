import { basePublicClient, robinhoodPublicClient, BASE_CHAIN_ID } from "./chains.mjs";

// bankrbot's own pre-flight check (confirmed directly from bankrbot, not guessed) rejects a tx if
// balance < gasLimit * maxFeePerGas + value — and it buffers gasLimit well above the gas actually
// expected to be used (observed ~2.5-3x on a real ape.store attempt: ~1.05M gas estimated,
// 3,000,000 gas limit requested). A caller whose own estimate only covers *expected* gas can look
// "clearly sufficient" and still get rejected at broadcast — this happened twice for real (ape.store,
// then o1.exchange) before being traced back to this. Applying the same ~3x buffer here so a low
// balance gets caught with a clear message before ever reaching bankrbot's own check, instead of a
// confusing mismatch between "my estimate says enough" and "bankrbot says insufficient".
const GAS_LIMIT_SAFETY_MULTIPLIER = 3n;

export async function checkSufficientBalance({ chainId, walletAddress, to, data, value }) {
  const publicClient = chainId === BASE_CHAIN_ID ? basePublicClient : robinhoodPublicClient;
  const [gasEstimate, gasPrice, balance] = await Promise.all([
    publicClient.estimateGas({ account: walletAddress, to, data, value }),
    publicClient.getGasPrice(),
    publicClient.getBalance({ address: walletAddress }),
  ]);
  const bufferedGasCost = gasEstimate * GAS_LIMIT_SAFETY_MULTIPLIER * gasPrice;
  const required = value + bufferedGasCost;
  return { sufficient: balance >= required, balance, required, gasEstimate, gasPrice, value };
}

export function formatEthShort(wei) {
  return (Number(wei) / 1e18).toFixed(6);
}

// Confirmed directly from bankrbot (not guessed): its own execution/relayer layer enforces a hard
// ~8,000,000 gas ceiling per transaction, separate from any chain-level block gas limit, and applies
// its own ~1.1-1.2x safety buffer to the estimated gas before checking against it. A call whose raw
// estimate is already close to 8M (based.bid's flash-launch is a large Uniswap V4 Diamond call,
// confirmed live at ~7.9M gas) gets pushed over the ceiling by that buffer alone, even though the
// call itself is completely valid on-chain — confirmed by independently re-simulating the exact same
// call via eth_call, which succeeded with no revert. This is bankrbot's own infrastructure limit, not
// something a skill's code can raise or work around — only relevant to the --build-only flow
// (bankrbot's sandbox); whether the raw Bankr Wallet API used by standalone mode shares the same
// ceiling hasn't been confirmed (untested — would require actually spending funds to check).
const BANKR_GAS_CEILING = 8_000_000n;
const BANKR_GAS_SAFETY_BUFFER_NUMERATOR = 12n; // ~1.2x
const BANKR_GAS_SAFETY_BUFFER_DENOMINATOR = 10n;

export function checkGasCeiling(gasEstimate) {
  const bufferedGas = (gasEstimate * BANKR_GAS_SAFETY_BUFFER_NUMERATOR) / BANKR_GAS_SAFETY_BUFFER_DENOMINATOR;
  return { withinCeiling: bufferedGas <= BANKR_GAS_CEILING, bufferedGas, ceiling: BANKR_GAS_CEILING };
}
