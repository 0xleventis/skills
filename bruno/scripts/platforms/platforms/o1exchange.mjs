// Ported from o1-creator-bot/src/api/o1ExchangeClient.ts (STANDARD factory only — the RWA/stock-paired
// route is a rarer edge case, skipped here to keep this port scoped to a plain launch, same "just launch
// it" default every other platform in this skill uses).
import { encodeFunctionData, decodeEventLog, zeroAddress } from "viem";
import { basePublicClient, BASE_CHAIN_ID } from "../lib/chains.mjs";

export const chainId = BASE_CHAIN_ID;

const FACTORY_ADDRESS = "0xa52ad458cE0282a971ecC71C051A32f28946bb9F";

const FACTORY_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "contractURI", type: "string" },
          { name: "salt", type: "bytes32" },
          { name: "quote", type: "address" },
          { name: "allocationRecipients", type: "address[]" },
          { name: "allocationAmounts", type: "uint256[]" },
          {
            name: "vestedAllocations",
            type: "tuple[]",
            components: [
              { name: "beneficiary", type: "address" },
              { name: "amount", type: "uint256" },
              { name: "steps", type: "tuple[]", components: [{ name: "delay", type: "uint32" }, { name: "cumulativeBps", type: "uint16" }] },
            ],
          },
          { name: "expectedConfigVersion", type: "uint64" },
          { name: "deadline", type: "uint64" },
          { name: "roleMode", type: "uint8" },
          { name: "metadataKeys", type: "string[]" },
          { name: "metadataValues", type: "string[]" },
        ],
        name: "p",
        type: "tuple",
      },
    ],
    name: "createLaunch",
    outputs: [{ name: "token", type: "address" }, { name: "poolId", type: "bytes32" }],
    stateMutability: "payable",
    type: "function",
  },
  { inputs: [], name: "configVersion", outputs: [{ type: "uint64" }], stateMutability: "view", type: "function" },
  {
    inputs: [{ name: "", type: "address" }],
    name: "quotes",
    outputs: [{ name: "registered", type: "bool" }, { name: "decimals", type: "uint8" }, { name: "startTickToken0Frame", type: "int24" }, { name: "creationFee", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "poolId", type: "bytes32" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: false, name: "quote", type: "address" },
      { indexed: false, name: "supply", type: "uint256" },
      { indexed: false, name: "tickSpacing", type: "int24" },
    ],
    name: "Launched",
    type: "event",
  },
];

async function pinMetadata({ name, symbol, description, imageBuffer, imageContentType }) {
  const res = await fetch("https://exciting-fox-990.convex.cloud/api/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "actions/pinMetadata:pin",
      args: { chainId: BASE_CHAIN_ID, name, symbol, description: description ?? "", imageBase64: imageBuffer.toString("base64"), imageType: imageContentType },
      format: "json",
    }),
  });
  if (!res.ok) throw new Error(`o1.exchange pinMetadata failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const json = await res.json();
  if (json.status !== "success" || !json.value) throw new Error(`o1.exchange pinMetadata failed: ${json.errorMessage ?? JSON.stringify(json)}`);
  return json.value; // { metadataUri, imageUrl }
}

export async function build({ name, symbol, description, imageBuffer, imageContentType }) {
  const pinned = await pinMetadata({ name, symbol, description, imageBuffer, imageContentType });
  const [expectedConfigVersion, quoteInfo] = await Promise.all([
    basePublicClient.readContract({ address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: "configVersion" }),
    basePublicClient
      .readContract({ address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: "quotes", args: [zeroAddress] })
      .then(([registered, decimals, startTickToken0Frame, creationFee]) => ({ registered, decimals, startTickToken0Frame, creationFee })),
  ]);

  const salt = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
  const data = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "createLaunch",
    args: [
      {
        name,
        symbol,
        contractURI: pinned.metadataUri,
        salt,
        quote: zeroAddress,
        allocationRecipients: [],
        allocationAmounts: [],
        vestedAllocations: [],
        expectedConfigVersion,
        deadline,
        roleMode: 0,
        metadataKeys: [],
        metadataValues: [],
      },
    ],
  });

  return {
    to: FACTORY_ADDRESS,
    data,
    value: quoteInfo.creationFee,
    chainId,
    logoUrl: pinned.imageUrl,
    decodeTokenAddress,
    pageUrl,
  };
}

// Standalone (doesn't need anything from build()) so a separate post-execution step — e.g. bankrbot's own
// sandbox, which builds the tx here but submits it with its own native tools outside the sandbox — can
// decode the result from just a receipt, without re-running build().
export async function decodeTokenAddress(receipt) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== FACTORY_ADDRESS.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: FACTORY_ABI, topics: log.topics, data: log.data });
      if (decoded.eventName === "Launched") return decoded.args.token;
    } catch {}
  }
  return undefined;
}

export function pageUrl(tokenAddress) {
  return `https://o1.exchange/base/detail/${tokenAddress.toLowerCase()}?ca=${tokenAddress.toLowerCase()}`;
}
