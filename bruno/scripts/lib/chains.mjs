import { createPublicClient, http, defineChain } from "viem";
import { base } from "viem/chains";

const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

export const BASE_CHAIN_ID = 8453;
export const ROBINHOOD_CHAIN_ID = 4663;

export const basePublicClient = createPublicClient({ chain: base, transport: http(BASE_RPC_URL, { timeout: 20000 }) });

// Not in viem/chains — Robinhood Chain's own published network details
// (docs.ponsfamily.com/network: chain ID 4663, rpc.mainnet.chain.robinhood.com).
export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC_URL] } },
});

export const robinhoodPublicClient = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL, { timeout: 20000 }) });
