// Ported from o1-creator-bot/src/api/apeStoreClient.ts. Unlike pools.fun/Pons, ape.store hosts the image
// itself (multipart upload to its own /api/token) and returns a signed draft — no Pinata needed here.
import { encodeFunctionData, decodeEventLog } from "viem";
import { ROBINHOOD_CHAIN_ID } from "../lib/chains.mjs";

export const chainId = ROBINHOOD_CHAIN_ID;

const ROUTER_ADDRESS = "0x6e4910ea5A04376032F6564da9a9E4E88B7a87C1";
const FEE_TIER = 10000;
const INITIAL_TICK = -208200;

const ROUTER_ABI = [
  {
    inputs: [
      { name: "id", type: "uint256" },
      { components: [{ name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "initialTick", type: "int24" }, { name: "fee", type: "uint24" }], name: "_token", type: "tuple" },
      { name: "signature", type: "bytes" },
    ],
    name: "deployToken",
    outputs: [{ name: "token", type: "address" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, name: "token", type: "address" }, { indexed: true, name: "id", type: "uint256" }],
    name: "CreateToken",
    type: "event",
  },
];

export async function build({ walletAddress, name, symbol, description, imageBuffer, imageContentType }) {
  const form = new FormData();
  form.append("files[]", new Blob([imageBuffer], { type: imageContentType }), "logo");
  form.append("data.Chain", "4663");
  form.append("data.Protocol", "30");
  form.append("data.Creator", walletAddress);
  form.append("data.Name", name);
  form.append("data.Symbol", symbol);
  if (description) form.append("data.Description", description);

  const res = await fetch("https://ape.store/api/token", { method: "POST", body: form });
  if (!res.ok) throw new Error(`ape.store POST /api/token failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const draft = await res.json();

  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "deployToken",
    args: [BigInt(draft.id), { name, symbol, initialTick: INITIAL_TICK, fee: FEE_TIER }, draft.signature],
  });

  return {
    to: ROUTER_ADDRESS,
    data,
    value: 0n,
    chainId,
    logoUrl: undefined,
    async decodeTokenAddress(receipt) {
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== ROUTER_ADDRESS.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({ abi: ROUTER_ABI, topics: log.topics, data: log.data });
          if (decoded.eventName === "CreateToken") return decoded.args.token;
        } catch {}
      }
      return undefined;
    },
    pageUrl: (tokenAddress) => `https://robinhoodchain.blockscout.com/token/${tokenAddress}`,
  };
}
