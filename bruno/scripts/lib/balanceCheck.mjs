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
