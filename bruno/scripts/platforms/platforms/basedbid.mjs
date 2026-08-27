// Ported from o1-creator-bot/src/api/basedBidClient.ts — uses the confirmed-working Uniswap V3 flash-launch
// route (customFlashLaunchV3) established after a long investigation into a real based.bid-side V4 hook bug
// (see that file's header comment). based.bid's own backend prepares the unsigned call args; this just
// re-encodes and hands off to Bankr instead of Bruno's own signer.
import { encodeFunctionData, getAddress } from "viem";
import { basePublicClient, BASE_CHAIN_ID } from "../lib/chains.mjs";

export const chainId = BASE_CHAIN_ID;

const CDN_BASE = "https://cdn.based.bid/api";
const SDK_API_BASE = "https://static.based.bid/api";
const DEFAULT_TOTAL_SUPPLY = 1_000_000_000;
const DEFAULT_MARKET_CAP_USD = 10_000;
const VIRTUAL_ETH_WEI_PER_MARKET_CAP_UNIT = 5498997997986328383n;
const MARKET_CAP_UNIT = 10_000n;

const V3_ABI = [
  {
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metaData", type: "string" },
      { name: "initialBuyAmount", type: "uint256" },
      {
        components: [
          { name: "positionManager", type: "address" },
          { name: "feeTier", type: "uint24" },
          { name: "decimals", type: "uint8" },
          { name: "isTokenBurn", type: "bool" },
          { name: "_padding1", type: "uint8" },
          { name: "virtualEth", type: "uint256" },
          { name: "totalSupply", type: "uint256" },
          { name: "baseToken", type: "address" },
          { name: "_padding2", type: "uint8" },
          { name: "maxWalletAmount", type: "uint256" },
          { name: "maxTxAmount", type: "uint256" },
          { name: "protectBlocks", type: "uint256" },
          { name: "sqrtPriceX96_1", type: "uint160" },
          { name: "_padding3", type: "uint8" },
          { name: "sqrtPriceX96_2", type: "uint160" },
          { name: "_padding4", type: "uint8" },
          { name: "tickLower_1", type: "int24" },
          { name: "tickUpper_1", type: "int24" },
          { name: "tickLower_2", type: "int24" },
          { name: "tickUpper_2", type: "int24" },
          { name: "_padding5", type: "uint8" },
        ],
        name: "poolInitialData",
        type: "tuple",
      },
      { name: "subBoardTitle", type: "string" },
      { name: "initCode", type: "bytes" },
      { name: "salt", type: "bytes32" },
      { name: "distributionWallets", type: "address[]" },
      { name: "distributionAmounts", type: "uint256[]" },
      { components: [{ name: "cooldownSeconds", type: "uint32" }, { name: "tradingStart", type: "uint32" }, { name: "tradingEnd", type: "uint32" }], name: "tokenOption", type: "tuple" },
      { components: [{ name: "description", type: "string" }, { name: "website", type: "string" }, { name: "image", type: "string" }, { name: "extraData", type: "bytes" }], name: "metadata", type: "tuple" },
    ],
    name: "customFlashLaunchV3",
    outputs: [{ name: "coin_address", type: "address" }],
    stateMutability: "payable",
    type: "function",
  },
];

async function uploadToCdn(path, init) {
  const res = await fetch(`${CDN_BASE}${path}`, init);
  const body = await res.json().catch(() => undefined);
  if (!res.ok || !body?.response?.url) throw new Error(`based.bid upload failed: ${res.status} ${JSON.stringify(body)}`);
  return body.response.url;
}

export async function build({ walletAddress, name, symbol, description, imageBuffer, imageContentType, username }) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(imageBuffer)], { type: imageContentType }), "logo");
  const logoUrl = await uploadToCdn("/upload", { method: "POST", body: form });

  const metadataUrl = await uploadToCdn("/upload/json", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      symbol,
      decimals: 18,
      totalSupply: DEFAULT_TOTAL_SUPPLY,
      logo: logoUrl,
      board: "",
      twitter: username ? `https://x.com/${username}` : "",
      telegram: "",
      website: "",
      discord: "",
      description: (description ?? "").slice(0, 789),
    }),
  });

  const marketCap = DEFAULT_MARKET_CAP_USD;
  const launchRes = await fetch(`${SDK_API_BASE}/create-flash`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      data: {
        isSandboxMode: false,
        chainId,
        initialBuySupplyPercent: 0,
        distributionWallets: [],
        distributionAmounts: [],
        token: { name, symbol, totalSupply: DEFAULT_TOTAL_SUPPLY, initialBuyAmount: 0, metadataUrl },
        sale: { marketCap, maxTxAmountPercent: 0.1, protectBlocks: 20 },
        dex: { version: "uniswap_v3", feeTier: 1 },
      },
    }),
  });
  const launch = await launchRes.json().catch(() => undefined);
  if (!launchRes.ok || !launch?.ok) throw new Error(`based.bid create-flash failed: ${launchRes.status} ${JSON.stringify(launch)}`);

  // Patch a null virtualEth the same way basedBidClient.ts's patchBasedBidFlashLaunchArgs does.
  const poolInitialData = launch.args[4];
  if (Array.isArray(poolInitialData) && poolInitialData[5] == null) {
    poolInitialData[5] = ((BigInt(Math.round(marketCap)) * VIRTUAL_ETH_WEI_PER_MARKET_CAP_UNIT) / MARKET_CAP_UNIT).toString();
  }

  if (launch.functionName !== "customFlashLaunchV3") {
    throw new Error(`based.bid returned an unexpected function (${launch.functionName}) — this port only supports the confirmed-working V3 route.`);
  }

  const data = encodeFunctionData({ abi: V3_ABI, functionName: "customFlashLaunchV3", args: launch.args });
  const value = BigInt(launch.value ?? "0");

  return {
    to: launch.address,
    data,
    value,
    chainId,
    logoUrl,
    decodeTokenAddress: () => decodeTokenAddress({ to: launch.address, data, value, walletAddress }),
    pageUrl,
  };
}

// Needs {to, data, value, walletAddress} rather than just a receipt, unlike the other 4 platforms — see
// the comment above: based.bid's function returns the new token address directly, so this simulates the
// same call again rather than decoding an event. A separate post-execution step (e.g. bankrbot's own
// sandbox, which builds the tx here but submits it with its own native tools outside the sandbox) needs to
// pass those same values back in, since it won't have re-run build().
export async function decodeTokenAddress({ to, data, value, walletAddress }) {
  const simulated = await basePublicClient.call({ account: walletAddress, to, data, value });
  return simulated.data ? getAddress(`0x${simulated.data.slice(-40)}`) : undefined;
}

export function pageUrl(tokenAddress) {
  return `https://basescan.org/token/${tokenAddress}`;
}
