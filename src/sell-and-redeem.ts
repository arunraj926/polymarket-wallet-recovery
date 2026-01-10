import { ClobClient, OrderType, Side, TickSize } from "@polymarket/clob-client";
import "dotenv/config";
import { ethers } from "ethers";
import { ctfAbi, proxyFactoryAbi, safeAbi } from "./abis";
import {
  CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS,
  PROXY_WALLET_FACTORY_ADDRESS,
  USDC_ADDRESS,
  USDCE_DIGITS,
} from "./constants";
import {
  CHAIN_ID,
  CLOB_HOST,
  discoverWalletsWithStatus,
  formatUSDC,
  getPositionsWithBalance,
  getUSDCBalance,
  printWalletStatus,
  WalletStatus,
  withdrawProxyUSDC,
  withdrawSafeUSDC,
} from "./polymarket";
import {
  aggregateTransaction,
  signAndExecuteSafeTransaction,
} from "./safe-helpers";
import { OperationType, SafeTransaction } from "./types";
import { walletConfig } from "./wallet-config";

async function sellPosition(
  clobClient: ClobClient,
  position: any,
  walletType: string,
): Promise<boolean> {
  const size = parseFloat(
    ethers.utils.formatUnits(position.balance, USDCE_DIGITS),
  );
  if (size < 0.01) {
    console.log(
      `  ${walletType}: skipping tiny position (${size.toFixed(4)} tokens)`,
    );
    return true;
  }
  if (position.price >= 0.999) {
    console.log(
      `  ${walletType}: skipping resolved position @ $${position.price.toFixed(
        3,
      )}`,
    );
    return true;
  }

  console.log(
    `  ${walletType}: selling ${size.toFixed(
      2,
    )} tokens @ $${position.price.toFixed(2)}`,
  );

  try {
    const result = await clobClient.createAndPostMarketOrder(
      { tokenID: position.tokenId, amount: size, side: Side.SELL },
      { tickSize: position.tickSize as TickSize, negRisk: position.negRisk },
      OrderType.FAK,
    );
    if (result.success) {
      console.log(
        `  ${walletType}: sold, received $${result.takingAmount || "?"}`,
      );
      return true;
    }
    console.log(
      `  ${walletType}: sell failed - ${result.errorMsg || "unknown"}`,
    );
  } catch (e) {
    console.log(
      `  ${walletType}: sell error - ${(e as Error).message.slice(0, 40)}`,
    );
  }
  return false;
}

// Returns array of token IDs that were actually sold
async function sellWalletPositions(
  wallet: ethers.Wallet,
  walletInfo: WalletStatus,
  positions: any[],
): Promise<string[]> {
  const activePositions = positions.filter(
    (p) => !p.isResolved && p.price < 0.999,
  );
  if (activePositions.length === 0) return [];

  console.log(
    `${walletInfo.type}: ${activePositions.length} position(s) to sell`,
  );

  const soldTokenIds: string[] = [];
  try {
    const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
    const creds = await tempClient.createOrDeriveApiKey();
    const clobClient = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      wallet,
      creds,
      walletInfo.signatureType,
      walletInfo.address,
    );

    for (const pos of activePositions) {
      const size = parseFloat(
        ethers.utils.formatUnits(pos.balance, USDCE_DIGITS),
      );
      // Skip tiny positions
      if (size < 0.01) {
        console.log(
          `  ${walletInfo.type}: skipping tiny position (${size.toFixed(4)} tokens)`,
        );
        continue;
      }
      if (await sellPosition(clobClient, pos, walletInfo.type)) {
        soldTokenIds.push(pos.tokenId);
      }
    }
  } catch (e) {
    console.log(
      `${walletInfo.type}: CLOB error - ${(e as Error).message.slice(0, 40)}`,
    );
  }
  return soldTokenIds;
}

async function redeemPositions(
  wallet: ethers.Wallet,
  walletInfo: WalletStatus,
  conditionIds: string[],
  provider: ethers.providers.Provider,
) {
  if (conditionIds.length === 0) return;
  console.log(
    `${walletInfo.type}: redeeming ${conditionIds.length} condition(s)`,
  );

  const gasPrice = await provider.getGasPrice();
  const ctfContract = new ethers.Contract(
    CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS,
    ctfAbi,
    wallet,
  );

  if (walletInfo.type === "EOA") {
    for (const conditionId of conditionIds) {
      try {
        const tx = await ctfContract.redeemPositions(
          USDC_ADDRESS,
          ethers.constants.HashZero,
          conditionId,
          [1, 2],
          { gasPrice: gasPrice.mul(2), gasLimit: 500000 },
        );
        await tx.wait();
        console.log(`  EOA: redeemed ${conditionId.slice(0, 15)}...`);
      } catch (e) {
        const msg = (e as Error).message;
        if (!msg.includes("payout is zero")) {
          console.log(`  EOA: redeem error - ${msg.slice(0, 40)}`);
        }
      }
    }
  } else if (walletInfo.type === "Proxy") {
    const factory = new ethers.Contract(
      PROXY_WALLET_FACTORY_ADDRESS,
      proxyFactoryAbi,
      wallet,
    );
    for (const conditionId of conditionIds) {
      try {
        const redeemData = new ethers.utils.Interface(
          ctfAbi,
        ).encodeFunctionData("redeemPositions", [
          USDC_ADDRESS,
          ethers.constants.HashZero,
          conditionId,
          [1, 2],
        ]);
        const tx = await factory.proxy(
          [
            {
              to: CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS,
              typeCode: 1,
              data: redeemData,
              value: 0,
            },
          ],
          { gasPrice: gasPrice.mul(2), gasLimit: 500000 },
        );
        await tx.wait();
        console.log(`  Proxy: redeemed ${conditionId.slice(0, 15)}...`);
      } catch (e) {
        const msg = (e as Error).message;
        if (!msg.includes("payout is zero")) {
          console.log(`  Proxy: redeem error - ${msg.slice(0, 40)}`);
        }
      }
    }
  } else if (walletInfo.type === "Safe") {
    try {
      const safe = new ethers.Contract(walletInfo.address, safeAbi, wallet);
      const safeTxns: SafeTransaction[] = conditionIds.map((conditionId) => ({
        to: CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS,
        data: new ethers.utils.Interface(ctfAbi).encodeFunctionData(
          "redeemPositions",
          [USDC_ADDRESS, ethers.constants.HashZero, conditionId, [1, 2]],
        ),
        operation: OperationType.Call,
        value: "0",
      }));
      const tx = await signAndExecuteSafeTransaction(
        wallet,
        safe,
        aggregateTransaction(safeTxns),
        {
          gasPrice: gasPrice.mul(2),
          gasLimit: 1000000,
        },
      );
      await tx.wait();
      console.log(`  Safe: redeemed ${conditionIds.length} condition(s)`);
    } catch (e) {
      console.log(
        `  Safe: redeem error - ${(e as Error).message.slice(0, 40)}`,
      );
    }
  }
}

async function main() {
  console.log("Sell & Redeem\n");

  const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PK!, provider);
  const rpcUrl = process.env.RPC_URL!;
  const ctfContract = new ethers.Contract(
    CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS,
    ctfAbi,
    wallet,
  );

  // Discover wallets and show status
  const walletStatuses = await discoverWalletsWithStatus(wallet, provider);
  printWalletStatus(walletStatuses);

  // Get tradeable wallets only
  const wallets = walletStatuses.filter((w) => w.deployed && w.canTrade);

  // Cancel BUY orders only (SELL orders are already trying to exit)
  console.log("\nCancelling open buy orders...");
  for (const w of wallets.filter((w) => w.deployed)) {
    if (!walletConfig[w.type]?.cancelOrders) {
      console.log(`  ${w.type}: cancel orders disabled`);
      continue;
    }
    try {
      const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
      const creds = await tempClient.createOrDeriveApiKey();
      const clobClient = new ClobClient(
        CLOB_HOST,
        CHAIN_ID,
        wallet,
        creds,
        w.signatureType,
        w.address,
      );
      const openOrders = await clobClient.getOpenOrders();
      const buyOrders = (openOrders || []).filter((o) => o.side === "BUY");
      const sellOrders = (openOrders || []).filter((o) => o.side === "SELL");

      if (buyOrders.length > 0) {
        for (const order of buyOrders) {
          await clobClient.cancelOrder({ orderID: order.id });
        }
        console.log(`  ${w.type}: cancelled ${buyOrders.length} buy order(s)`);
      }
      if (sellOrders.length > 0) {
        console.log(`  ${w.type}: ${sellOrders.length} sell order(s) pending`);
      }
      if (buyOrders.length === 0 && sellOrders.length === 0) {
        console.log(`  ${w.type}: no open orders`);
      }
    } catch (e) {
      console.log(
        `  ${w.type}: could not check orders - ${(e as Error).message.slice(
          0,
          30,
        )}`,
      );
    }
  }

  // Scan and sell positions
  console.log("\nSelling positions...");
  const walletPositions = new Map<string, any[]>();
  let hadSales = false;
  for (const w of wallets.filter((w) => w.deployed)) {
    console.log(`${w.type}: scanning...`);
    const positions = await getPositionsWithBalance(w.address, rpcUrl);
    walletPositions.set(w.address, positions);
    if (!walletConfig[w.type]?.marketSell) {
      console.log(`  ${w.type}: market sell disabled`);
      continue;
    }
    const sold = await sellWalletPositions(wallet, w, positions);
    if (sold.length > 0) hadSales = true;
  }

  // Find resolved conditions from positions we already scanned
  console.log("\nRedeeming positions...");
  const allConditionIds = new Set<string>();
  for (const [_, positions] of walletPositions) {
    for (const pos of positions) {
      try {
        const conditionId = ethers.utils.hexZeroPad(
          ethers.BigNumber.from(pos.tokenId).toHexString(),
          32,
        );
        allConditionIds.add(conditionId);
      } catch {}
    }
  }

  const resolvedConditions: string[] = [];
  for (const conditionId of allConditionIds) {
    try {
      const payoutDenom = await ctfContract.payoutDenominator(conditionId);
      if (payoutDenom.gt(0)) resolvedConditions.push(conditionId);
    } catch {}
  }

  if (resolvedConditions.length > 0) {
    for (const w of wallets.filter((w) => w.deployed)) {
      if (!walletConfig[w.type]?.redeem) {
        console.log(`  ${w.type}: redeem disabled`);
        continue;
      }
      await redeemPositions(wallet, w, resolvedConditions, provider);
    }
  } else {
    console.log("  No resolved conditions found");
  }

  // Wait for positions to settle by re-checking balances
  if (hadSales) {
    console.log("\nWaiting for positions to settle...");
    const maxWait = 30000;
    const pollInterval = 3000;
    let waited = 0;

    while (waited < maxWait) {
      // Re-fetch positions with balance, filter by same threshold we use for selling
      let totalRemaining = 0;
      for (const w of wallets.filter((w) => w.deployed)) {
        const positions = await getPositionsWithBalance(w.address, rpcUrl);
        const sellable = positions.filter((p) => {
          const size = parseFloat(
            ethers.utils.formatUnits(p.balance, USDCE_DIGITS),
          );
          return !p.isResolved && p.price < 0.999 && size >= 0.01;
        });
        totalRemaining += sellable.length;
      }

      if (totalRemaining === 0) {
        console.log("  All positions settled");
        break;
      }

      console.log(`  ${totalRemaining} position(s) still settling...`);
      await new Promise((r) => setTimeout(r, pollInterval));
      waited += pollInterval;
    }

    if (waited >= maxWait) {
      console.log("  Timeout waiting for settlement, proceeding anyway");
    }
  }

  // Withdraw USDC to EOA
  console.log("Withdrawing to EOA...");
  for (const w of wallets.filter((w) => w.type !== "EOA")) {
    if (!walletConfig[w.type]?.withdraw) {
      console.log(`  ${w.type}: withdraw disabled`);
      continue;
    }
    if (w.type === "Proxy") {
      // Proxy withdrawal works even if not deployed (factory deploys on first call)
      const withdrawn = await withdrawProxyUSDC(wallet, w.address, provider);
      if (withdrawn.gt(0))
        console.log(`  Proxy: withdrawn ${formatUSDC(withdrawn)} USDC`);
    } else if (w.type === "Safe" && w.deployed) {
      const withdrawn = await withdrawSafeUSDC(wallet, w.address, provider);
      if (withdrawn.gt(0))
        console.log(`  Safe: withdrawn ${formatUSDC(withdrawn)} USDC`);
    }
  }

  // Final balance
  const finalBalance = await getUSDCBalance(wallet.address, provider);
  console.log(`\nFinal EOA balance: ${formatUSDC(finalBalance)} USDC`);
}

main().catch(console.error);
