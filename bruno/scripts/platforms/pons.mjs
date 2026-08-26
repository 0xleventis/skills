// Ported from o1-creator-bot/src/api/ponsClient.ts.
import { encodeFunctionData, decodeEventLog } from "viem";
import { robinhoodPublicClient, ROBINHOOD_CHAIN_ID } from "../lib/chains.mjs";
import { uploadImageToPinata } from "../lib/pinata.mjs";

export const chainId = ROBINHOOD_CHAIN_ID;

const FACTORY_ADDRESS = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const LAUNCH_CONFIG_ID = 0n;
const DEFAULT_CREATOR_TAX_BPS = 100;

const FACTORY_ABI = [
  { type: "function", name: "launchFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "previewLaunchEconomics",
    stateMutability: "view",
    inputs: [{ name: "launchConfigId", type: "uint256" }, { name: "pairToken", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "launchToken",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "logo", type: "string" },
          { name: "description", type: "string" },
          { name: "socials", type: "tuple", components: [{ name: "twitter", type: "string" }, { name: "telegram", type: "string" }, { name: "discord", type: "string" }, { name: "website", type: "string" }, { name: "farcaster", type: "string" }] },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "expectedEconomics", type: "bytes32" },
          { name: "salt", type: "bytes32" },
        ],
      },
      { name: "launchConfigId", type: "uint256" },
      { name: "pairToken", type: "address" },
      { name: "snipeTaxExemptions", type: "address[]" },
    ],
    outputs: [{ name: "token", type: "address" }, { name: "curve", type: "address" }],
  },
  {
    type: "event",
    name: "TokenLaunched",
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "curve", type: "address" },
      { indexed: true, name: "deployer", type: "address" },
      { indexed: false, name: "pairToken", type: "address" },
      { indexed: false, name: "launchConfigId", type: "uint256" },
      { indexed: false, name: "graduationThreshold", type: "uint256" },
    ],
  },
];

function randomSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export async function build({ walletAddress, name, symbol, description, imageBuffer, imageContentType }) {
  const logoUrl = await uploadImageToPinata(imageBuffer, imageContentType);

  const [fee, expectedEconomics] = await Promise.all([
    robinhoodPublicClient.readContract({ address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: "launchFee" }),
    robinhoodPublicClient.readContract({ address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: "previewLaunchEconomics", args: [LAUNCH_CONFIG_ID, ZERO_ADDRESS] }),
  ]);

  const params = {
    name,
    symbol,
    logo: logoUrl,
    description: description ?? "",
    socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
    creatorFeeRecipient: walletAddress,
    creatorTaxBps: DEFAULT_CREATOR_TAX_BPS,
    buybackEnabled: false,
    expectedEconomics,
    salt: randomSalt(),
  };

  const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: "launchToken", args: [params, LAUNCH_CONFIG_ID, ZERO_ADDRESS, []] });

  return {
    to: FACTORY_ADDRESS,
    data,
    value: fee,
    chainId,
    logoUrl,
    async decodeTokenAddress(receipt) {
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== FACTORY_ADDRESS.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({ abi: FACTORY_ABI, eventName: "TokenLaunched", topics: log.topics, data: log.data });
          return decoded.args.token;
        } catch {}
      }
      return undefined;
    },
    pageUrl: (tokenAddress) => `https://robinhoodchain.blockscout.com/token/${tokenAddress}`,
  };
}
