// Ported from o1-creator-bot/src/api/poolsfunClient.ts.
import { encodeFunctionData, decodeEventLog } from "viem";
import { robinhoodPublicClient, ROBINHOOD_CHAIN_ID } from "../lib/chains.mjs";
import { uploadImageToPinata, uploadJsonToPinata } from "../lib/pinata.mjs";

export const chainId = ROBINHOOD_CHAIN_ID;

const FACTORY_ADDRESS = "0x626C3d09B65bF5d1D40E0D5F25e19fa49783B3D4";
const DEFAULT_PAIRED_ASSET = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const FACTORY_ABI = [
  {
    type: "function",
    name: "launch",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataUri", type: "string" },
      { name: "salt", type: "bytes32" },
      { name: "pairedAsset", type: "address" },
      { name: "expectedStartTick", type: "int24" },
      { name: "deadline", type: "uint256" },
      { name: "creator", type: "address" },
      { name: "feeRecipient", type: "address" },
      { name: "devBuyAmountIn", type: "uint256" },
      { name: "devBuyMinOut", type: "uint256" },
    ],
    outputs: [{ name: "token", type: "address" }, { name: "pool", type: "address" }, { name: "devBuyOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "computeTokenAddress",
    stateMutability: "view",
    inputs: [{ name: "deployer", type: "address" }, { name: "salt", type: "bytes32" }, { name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "metadataUri", type: "string" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "startTickFor",
    stateMutability: "view",
    inputs: [{ name: "pairedAsset", type: "address" }],
    outputs: [{ name: "tick", type: "int24" }, { name: "live", type: "bool" }],
  },
  {
    type: "event",
    name: "TokenLaunched",
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "pool", type: "address" },
      { indexed: false, name: "pairedAsset", type: "address" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: false, name: "deployer", type: "address" },
      { indexed: false, name: "feeRecipient", type: "address" },
      { indexed: false, name: "startTick", type: "int24" },
      { indexed: false, name: "metadataUri", type: "string" },
      { indexed: false, name: "devBuyAmountOut", type: "uint256" },
    ],
  },
];

function randomSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

// launch() reverts with TokenNotToken0() unless the token address sorts below the paired asset's address
// — true odds are pairedAsset / 2^160 (~4.6% for the current DEFAULT_PAIRED_ASSET), not a 50/50 coin flip.
// See poolsfunClient.ts's comment for the full story (a wrong "~50%" assumption caused real launch
// failures before this was corrected).
async function findValidSalt(deployer, name, symbol, metadataUri) {
  const maxAttempts = 200;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const salt = randomSalt();
    const predicted = await robinhoodPublicClient.readContract({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: "computeTokenAddress",
      args: [deployer, salt, name, symbol, metadataUri],
    });
    if (BigInt(predicted) < BigInt(DEFAULT_PAIRED_ASSET)) return { salt, predicted };
  }
  throw new Error("Couldn't find a token address that sorts below the paired asset after 200 attempts — try again.");
}

export async function build({ walletAddress, name, symbol, description, imageBuffer, imageContentType }) {
  const logoUrl = await uploadImageToPinata(imageBuffer, imageContentType);
  const metadataUri = await uploadJsonToPinata({ name, symbol, description: description ?? "", image: logoUrl });

  const { salt } = await findValidSalt(walletAddress, name, symbol, metadataUri);
  const [tick, live] = await robinhoodPublicClient.readContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: "startTickFor",
    args: [DEFAULT_PAIRED_ASSET],
  });
  if (!live) throw new Error("pools.fun's price oracle for the default quote asset is currently stale — try again later.");

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const data = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "launch",
    args: [name, symbol, metadataUri, salt, DEFAULT_PAIRED_ASSET, tick, deadline, walletAddress, walletAddress, 0n, 0n],
  });

  return {
    to: FACTORY_ADDRESS,
    data,
    value: 0n,
    chainId,
    logoUrl,
    // launch() can revert with StartTickChanged() if the live price moves between quoting and confirming —
    // caller (launch.mjs) should surface that clearly rather than treat it as an unknown failure.
    async decodeTokenAddress(receipt) {
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== FACTORY_ADDRESS.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({ abi: FACTORY_ABI, topics: log.topics, data: log.data });
          if (decoded.eventName === "TokenLaunched") return decoded.args.token;
        } catch {}
      }
      return undefined;
    },
    pageUrl: (tokenAddress) => `https://robinhoodchain.blockscout.com/token/${tokenAddress}`,
  };
}
