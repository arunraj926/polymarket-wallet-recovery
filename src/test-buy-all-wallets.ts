import { ClobClient, OrderType, Side, TickSize } from "@polymarket/clob-client";
import { error, log } from "console";
import "dotenv/config";
import { ethers } from "ethers";
import {
  CHAIN_ID,
  CLOB_HOST,
  discoverWalletsWithStatus,
  findActiveMarkets,
  formatUSDC,
  fundWallet,
  getUSDCBalance,
  MarketInfo,
  parseUSDC,
  printWalletStatus,
  setupEOAApprovals,
  setupSafeApprovals,
  WalletStatus,
} from "./polymarket";
import { walletConfig } from "./wallet-config";

const FUNDING_PER_WALLET = parseUSDC("5");
const TRADE_AMOUNT = 1;

async function getClobClient(
  wallet: ethers.Wallet,
  walletInfo: WalletStatus,
): Promise<ClobClient> {
  const tempClient = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    wallet,
    undefined,
    walletInfo.signatureType,
    walletInfo.address,
  );
  const creds = await tempClient.createOrDeriveApiKey();
  return new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    wallet,
    creds,
    walletInfo.signatureType,
    walletInfo.address,
  );
}

async function buyForWallet(
  wallet: ethers.Wallet,
  walletInfo: WalletStatus,
  market: MarketInfo,
  marketType: string,
): Promise<boolean> {
  try {
    const clobClient = await getClobClient(wallet, walletInfo);

    const size = TRADE_AMOUNT / market.price;
    log(
      `  ${walletInfo.type}: buying ~${size.toFixed(
        2,
      )} tokens @ $${market.price.toFixed(2)} (${marketType})`,
    );

    const result = await clobClient.createAndPostMarketOrder(
      { tokenID: market.tokenId, amount: TRADE_AMOUNT, side: Side.BUY },
      { tickSize: market.tickSize as TickSize, negRisk: market.negRisk },
      OrderType.FOK,
    );

    if (result.success) {
      log(`  ${walletInfo.type}: bought ${size.toFixed(2)} tokens`);
      return true;
    }
    log(`  ${walletInfo.type}: buy failed - ${result.errorMsg || "unknown"}`);
  } catch (e) {
    log(
      `  ${walletInfo.type}: buy error - ${(e as Error).message.slice(0, 40)}`,
    );
  }
  return false;
}

// Place a limit order at a price unlikely to fill (for testing sellAndRedeem)
async function placeLimitOrder(
  wallet: ethers.Wallet,
  walletInfo: WalletStatus,
  market: MarketInfo,
  marketType: string,
): Promise<boolean> {
  try {
    const clobClient = await getClobClient(wallet, walletInfo);

    // Place buy order at very low price (won't fill, can be cancelled by sellAndRedeem)
    // Minimum size is 5 tokens for limit orders
    const limitPrice = Math.max(0.01, market.price - 0.2);
    const size = Math.max(5, TRADE_AMOUNT / limitPrice);

    log(
      `  ${walletInfo.type}: limit buy ~${size.toFixed(
        2,
      )} tokens @ $${limitPrice.toFixed(2)} (${marketType})`,
    );

    const order = await clobClient.createOrder(
      {
        tokenID: market.tokenId,
        price: limitPrice,
        size,
        side: Side.BUY,
      },
      { tickSize: market.tickSize as TickSize, negRisk: market.negRisk },
    );

    const result = await clobClient.postOrder(order, OrderType.GTC);

    if (result.success) {
      log(
        `  ${walletInfo.type}: limit order placed (id: ${result.orderID?.slice(
          0,
          8,
        )}...)`,
      );
      return true;
    }
    log(
      `  ${walletInfo.type}: limit order failed - ${
        result.errorMsg || "unknown"
      }`,
    );
  } catch (e) {
    log(
      `  ${walletInfo.type}: limit error - ${(e as Error).message.slice(
        0,
        40,
      )}`,
    );
  }
  return false;
}

async function main() {
  log("Buy Test\n");

  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PK!, provider);

  // Discover wallets and show status
  const allWallets = await discoverWalletsWithStatus(wallet, provider);
  printWalletStatus(allWallets);

  // Filter to tradeable wallets only (EOA + Safe, Proxy can't trade on CLOB without MagicLink)
  const wallets = allWallets.filter((w) => w.canTrade && w.deployed);

  // Fund Safe wallet if needed
  const safeWallet = wallets.find((w) => w.type === "Safe");
  if (safeWallet) {
    const currentBalance = await getUSDCBalance(safeWallet.address, provider);
    if (currentBalance.lt(FUNDING_PER_WALLET)) {
      const needed = FUNDING_PER_WALLET.sub(currentBalance);
      log(`\nFunding Safe with ${formatUSDC(needed)} USDC...`);
      if (await fundWallet(wallet, safeWallet.address, needed, provider)) {
        log("  Funded");
      }
    }
  }

  // Set up approvals
  log("\nSetting up approvals...");
  if (await setupEOAApprovals(wallet, provider)) {
    log("  EOA approvals set");
  }
  if (safeWallet) {
    if (await setupSafeApprovals(wallet, safeWallet.address, provider)) {
      log("  Safe approvals set");
    }
  }

  // Find active markets
  log("\nFinding markets...");
  const { ctfMarket, negRiskMarket } = await findActiveMarkets();

  if (ctfMarket) {
    log(`  CTF: ${ctfMarket.question}... @ $${ctfMarket.price.toFixed(2)}`);
  }
  if (negRiskMarket) {
    log(
      `  NegRisk: ${negRiskMarket.question}... @ $${negRiskMarket.price.toFixed(
        2,
      )}`,
    );
  }

  if (!ctfMarket && !negRiskMarket) {
    log("  No markets found - exiting");
    return;
  }

  // Place both market orders and limit orders
  log("\nBuying positions (market orders)...");
  let marketCount = 0;
  let limitCount = 0;

  for (const w of wallets) {
    if (!walletConfig[w.type]?.marketBuy) {
      log(`  ${w.type}: market buy disabled`);
      continue;
    }
    if (ctfMarket) {
      if (await buyForWallet(wallet, w, ctfMarket, "CTF")) marketCount++;
    }
    if (negRiskMarket) {
      if (await buyForWallet(wallet, w, negRiskMarket, "NegRisk"))
        marketCount++;
    }
  }

  log("\nPlacing limit orders...");
  for (const w of wallets) {
    if (!walletConfig[w.type]?.limitOrder) {
      log(`  ${w.type}: limit orders disabled`);
      continue;
    }
    if (ctfMarket) {
      if (await placeLimitOrder(wallet, w, ctfMarket, "CTF")) limitCount++;
    }
    if (negRiskMarket) {
      if (await placeLimitOrder(wallet, w, negRiskMarket, "NegRisk"))
        limitCount++;
    }
  }

  log("\nSummary:");
  for (const w of wallets) {
    const bal = await getUSDCBalance(w.address, provider);
    log(`  ${w.type}: ${formatUSDC(bal)} USDC`);
  }
  log(`\nMarket buys: ${marketCount}, Limit orders: ${limitCount}`);
  log("\nNext: run bun src/sellAndRedeem.ts");
}

main().catch(error);
