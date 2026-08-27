#!/usr/bin/env node
// Launches a token on one of Bruno's launchpads using the installing user's own Bankr wallet.
//
// Two modes:
//
// 1. Full (default) — this script does everything, including submitting via Bankr's Wallet API.
//    Needs BANKR_API_KEY in the environment. Use this standalone (Claude Code, a plain terminal).
//      BANKR_API_KEY=bk_... node launch.mjs --platform o1exchange --name "Popo" --symbol POPO \
//        [--description "..."] [--image ./logo.png | --image https://...] [--username xhandle]
//
// 2. --build-only — this script only builds the transaction and prints it as JSON to stdout; it
//    does NOT submit anything and does NOT need BANKR_API_KEY. Use this inside bankrbot's own
//    sandbox, which has no ambient wallet credentials by design — bankrbot itself submits the
//    printed transaction using its own native onchain tools, already authenticated as the user.
//    Needs --wallet-address explicitly since there's no BANKR_API_KEY to look it up with.
//      node launch.mjs --platform o1exchange --name "Popo" --symbol POPO --build-only \
//        --wallet-address 0x...
//    After bankrbot submits it and has a tx hash, run decode-result.mjs to get the final
//    token address and a formatted confirmation message.
//
// pools.fun and Pons additionally need PINATA_JWT (see lib/pinata.mjs) in both modes.

import { bankrWhoami, submitTxBankr } from "./lib/bankr.mjs";
import { loadImage } from "./lib/image.mjs";
import { basePublicClient, robinhoodPublicClient, BASE_CHAIN_ID, ROBINHOOD_CHAIN_ID } from "./lib/chains.mjs";

const PLATFORM_LABELS = {
  o1exchange: "o1.exchange",
  basedbid: "based.bid",
  poolsfun: "pools.fun",
  pons: "Pons",
  apestore: "ape.store",
};

const SOLANA_ONLY_PLATFORMS = new Set(["pumpfun", "ansem", "blank"]);

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
  const platform = normalizePlatform(args.platform);

  if (!platform) {
    if (args.platform && SOLANA_ONLY_PLATFORMS.has(String(args.platform).toLowerCase())) {
      throw new Error(
        `"${args.platform}" is a Solana platform — this skill can't launch there yet (Bankr's Wallet API has no raw Solana transaction submission, only o1.exchange/based.bid/pools.fun/Pons/ape.store are supported).`
      );
    }
    throw new Error(`--platform is required and must be one of: ${Object.keys(PLATFORM_LABELS).join(", ")}`);
  }
  if (!args.name || !args.symbol) {
    throw new Error("--name and --symbol are required.");
  }

  const buildOnly = args["build-only"] === true;

  let walletAddress = args["wallet-address"];
  let username = args.username;
  if (!buildOnly) {
    console.log(`Checking Bankr wallet...`);
    const who = await bankrWhoami();
    walletAddress = who.wallets?.find((w) => w.chain === "evm")?.address;
    if (!walletAddress) throw new Error("Bankr account has no EVM wallet — run `bankr login` to provision one.");
    username = username || who.socialAccounts?.find((s) => s.platform === "twitter")?.username;
    console.log(`Wallet: ${walletAddress}`);
  } else if (!walletAddress) {
    throw new Error("--build-only requires --wallet-address (no BANKR_API_KEY available to look it up).");
  }

  console.log(`Loading image...`);
  const { buffer: imageBuffer, contentType: imageContentType } = await loadImage(args.image);

  console.log(`Building ${PLATFORM_LABELS[platform]} launch transaction...`);
  const platformModule = await import(`./platforms/${platform}.mjs`);
  const tx = await platformModule.build({
    walletAddress,
    name: args.name,
    symbol: args.symbol,
    description: args.description,
    imageBuffer,
    imageContentType,
    username,
  });

  if (buildOnly) {
    console.log(JSON.stringify({
      to: tx.to,
      data: tx.data,
      value: tx.value.toString(),
      chainId: tx.chainId,
      description: `Launch ${args.name} (${args.symbol}) on ${PLATFORM_LABELS[platform]} via bruno skill`,
    }));
    return;
  }

  console.log(`Submitting via Bankr (to: ${tx.to}, chainId: ${tx.chainId})...`);
  const submitResult = await submitTxBankr({
    to: tx.to,
    data: tx.data,
    value: tx.value,
    chainId: tx.chainId,
    description: `Launch ${args.name} (${args.symbol}) on ${PLATFORM_LABELS[platform]} via bruno skill`,
  });

  if (!submitResult.success) {
    throw new Error(`Bankr submit did not succeed: ${JSON.stringify(submitResult)}`);
  }
  const txHash = submitResult.transactionHash;
  console.log(`tx: ${txHash}`);

  const publicClient = tx.chainId === BASE_CHAIN_ID ? basePublicClient : robinhoodPublicClient;
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`Transaction reverted onchain. tx: ${txHash}`);
  }

  const tokenAddress = await tx.decodeTokenAddress(receipt);
  if (!tokenAddress) {
    console.log(`Launched, but couldn't decode the new token address from the receipt. tx: ${txHash}`);
    process.exit(0);
  }

  const pageUrl = tx.pageUrl(tokenAddress);
  console.log(`\n✅ Launched ${args.name} (${args.symbol}) on ${PLATFORM_LABELS[platform]}: ${tokenAddress}\n${pageUrl}\ntx: ${txHash}`);
}

function normalizePlatform(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const needle = raw.trim().toLowerCase().replace(/[.\s]/g, "");
  if (needle === "o1" || needle === "o1exchange") return "o1exchange";
  if (needle === "based" || needle === "basedbid") return "basedbid";
  if (needle === "pools" || needle === "poolsfun") return "poolsfun";
  if (needle === "pons") return "pons";
  if (needle === "ape" || needle === "apestore") return "apestore";
  return undefined;
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
});
