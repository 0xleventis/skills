#!/usr/bin/env node
// Second step of the --build-only flow (see launch.mjs's header comment): after bankrbot has submitted
// the transaction launch.mjs --build-only printed, using its own native onchain tools, call this with the
// resulting tx hash to get the new token's address and a formatted confirmation message.
//
// Usage:
//   node decode-result.mjs --platform o1exchange --name "Popo" --symbol POPO --tx-hash 0x...
//
// based.bid additionally needs --to, --data, --value, --wallet-address (the same values launch.mjs
// --build-only printed) — its token address comes from re-simulating the call, not the receipt's logs.

import { basePublicClient, robinhoodPublicClient, BASE_CHAIN_ID, ROBINHOOD_CHAIN_ID } from "./lib/chains.mjs";

const PLATFORM_LABELS = {
  o1exchange: "o1.exchange",
  basedbid: "based.bid",
  poolsfun: "pools.fun",
  pons: "Pons",
  apestore: "ape.store",
};

const PLATFORM_CHAIN = {
  o1exchange: BASE_CHAIN_ID,
  basedbid: BASE_CHAIN_ID,
  poolsfun: ROBINHOOD_CHAIN_ID,
  pons: ROBINHOOD_CHAIN_ID,
  apestore: ROBINHOOD_CHAIN_ID,
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = args.platform;
  if (!platform || !PLATFORM_LABELS[platform]) {
    throw new Error(`--platform is required and must be one of: ${Object.keys(PLATFORM_LABELS).join(", ")}`);
  }
  if (!args["tx-hash"]) throw new Error("--tx-hash is required.");
  if (!args.name || !args.symbol) throw new Error("--name and --symbol are required.");

  const chainId = PLATFORM_CHAIN[platform];
  const publicClient = chainId === BASE_CHAIN_ID ? basePublicClient : robinhoodPublicClient;

  const receipt = await publicClient.getTransactionReceipt({ hash: args["tx-hash"] });
  if (receipt.status !== "success") {
    throw new Error(`Transaction reverted onchain. tx: ${args["tx-hash"]}`);
  }

  const platformModule = await import(`./platforms/${platform}.mjs`);
  const tokenAddress =
    platform === "basedbid"
      ? await platformModule.decodeTokenAddress({ to: args.to, data: args.data, value: BigInt(args.value ?? "0"), walletAddress: args["wallet-address"] })
      : await platformModule.decodeTokenAddress(receipt);

  if (!tokenAddress) {
    console.log(`Launched, but couldn't decode the new token address. tx: ${args["tx-hash"]}`);
    return;
  }

  const pageUrl = platformModule.pageUrl(tokenAddress);
  console.log(`\n✅ Launched ${args.name} (${args.symbol}) on ${PLATFORM_LABELS[platform]}: ${tokenAddress}\n${pageUrl}\ntx: ${args["tx-hash"]}`);
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
});
