import { log } from "console";
import { ethers } from "ethers";
import { proxyFactoryAbi, safeAbi } from "./abis";
import { erc1155Abi } from "./abis/erc1155Abi";
import { erc20Abi } from "./abis/erc20Abi";
import { safeFactoryAbi } from "./abis/safeFactoryAbi";
import {
  CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS,
  CTF_EXCHANGE_ADDRESS,
  NEG_RISK_ADAPTER_ADDRESS,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  PROXY_WALLET_FACTORY_ADDRESS,
  SAFE_FACTORY_ADDRESS,
  USDCE_DIGITS,
  USDC_ADDRESS,
} from "./constants";
import { encodeErc20Approve } from "./encode";
import {
  aggregateTransaction,
  signAndExecuteSafeTransaction,
} from "./safe-helpers";
import { OperationType, SafeTransaction } from "./types";

// Suppress noisy "Could not create api key" CLOB client logs (non-blocking warning)
const originalError = console.error;
console.error = (...args: any[]) => {
  const fullMsg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  if (fullMsg.includes("Could not create api key")) return;
  originalError.apply(console, args);
};

// ============================================================================
// CONSTANTS
// ============================================================================

export const CLOB_HOST = "https://clob.polymarket.com";
export const CHAIN_ID = 137;

export const OPERATORS = [
  { name: "CTF Exchange", address: CTF_EXCHANGE_ADDRESS },
  { name: "Neg Risk CTF Exchange", address: NEG_RISK_CTF_EXCHANGE_ADDRESS },
  { name: "Neg Risk Adapter", address: NEG_RISK_ADAPTER_ADDRESS },
];

// ============================================================================
// TYPES
// ============================================================================

export interface WalletInfo {
  address: string;
  type: "EOA" | "Proxy" | "Safe";
  deployed: boolean;
  signatureType: number;
}

export interface WalletStatus extends WalletInfo {
  canTrade: boolean;
  balance: ethers.BigNumber;
  stuckFunds?: ethers.BigNumber;
  stuckAddress?: string;
}

export interface MarketInfo {
  tokenId: string;
  price: number;
  tickSize: string;
  negRisk: boolean;
  question?: string;
}

export interface PositionInfo {
  tokenId: string;
  balance: ethers.BigNumber;
  price: number;
  tickSize: string;
  negRisk: boolean;
  isResolved: boolean;
}

// ============================================================================
// WALLET DISCOVERY
// ============================================================================

export async function getSafeAddress(
  eoaAddress: string,
  provider: ethers.providers.Provider,
): Promise<string | null> {
  try {
    const safeFactory = new ethers.Contract(
      SAFE_FACTORY_ADDRESS,
      safeFactoryAbi,
      provider,
    );
    const safeAddress = await safeFactory.computeProxyAddress(eoaAddress);
    const code = await provider.getCode(safeAddress);
    if (code !== "0x") {
      return safeAddress;
    }
  } catch {}
  return null;
}

export async function getProxyAddress(
  eoaAddress: string,
  provider: ethers.providers.Provider,
): Promise<{ address: string; deployed: boolean } | null> {
  // NOTE: The original minimal proxy calculation doesn't match what the factory deploys
  // This function returns the computed address but it may not match the actual deployed wallet
  // TODO: Fix the CREATE2 calculation to match the factory's actual bytecode
  try {
    const proxyFactory = new ethers.Contract(
      PROXY_WALLET_FACTORY_ADDRESS,
      proxyFactoryAbi,
      provider,
    );
    const implementation = await proxyFactory.getImplementation();
    if (implementation && implementation !== ethers.constants.AddressZero) {
      const proxyAddress = calculateProxyAddress(
        PROXY_WALLET_FACTORY_ADDRESS,
        eoaAddress,
        implementation,
      );
      const code = await provider.getCode(proxyAddress);
      // Only return if deployed, since undeployed addresses can't be accessed via factory
      if (code !== "0x") {
        return { address: proxyAddress, deployed: true };
      }
      // Check if there's USDC stuck at this address (computed but never deployed)
      const usdcContract = new ethers.Contract(
        USDC_ADDRESS,
        erc20Abi,
        provider,
      );
      const balance = await usdcContract.balanceOf(proxyAddress);
      if (balance.gt(0)) {
        log(
          `  Warning: ${ethers.utils.formatUnits(
            balance,
            USDCE_DIGITS,
          )} USDC stuck at undeployed proxy ${proxyAddress.slice(0, 10)}...`,
        );
      }
      return null; // Don't include undeployed proxies
    }
  } catch {}
  return null;
}

export function calculateProxyAddress(
  factoryAddress: string,
  ownerAddress: string,
  implementation: string,
): string {
  const salt = ethers.utils.solidityKeccak256(["address"], [ownerAddress]);
  const initCode = ethers.utils.solidityPack(
    ["bytes", "address", "bytes"],
    [
      "0x3d602d80600a3d3981f3363d3d373d3d3d363d73",
      implementation,
      "0x5af43d82803e903d91602b57fd5bf3",
    ],
  );
  return ethers.utils.getCreate2Address(
    factoryAddress,
    salt,
    ethers.utils.keccak256(initCode),
  );
}

export async function discoverWalletsWithStatus(
  wallet: ethers.Wallet,
  provider: ethers.providers.Provider,
): Promise<WalletStatus[]> {
  const statuses: WalletStatus[] = [];
  const usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);

  // EOA - always available and can trade
  const eoaBalance = await usdcContract.balanceOf(wallet.address);
  statuses.push({
    address: wallet.address,
    type: "EOA",
    deployed: true,
    signatureType: 0,
    canTrade: true,
    balance: eoaBalance,
  });

  // Proxy wallet - check status and stuck funds
  try {
    const proxyFactory = new ethers.Contract(
      PROXY_WALLET_FACTORY_ADDRESS,
      proxyFactoryAbi,
      provider,
    );
    const implementation = await proxyFactory.getImplementation();
    if (implementation && implementation !== ethers.constants.AddressZero) {
      const proxyAddress = calculateProxyAddress(
        PROXY_WALLET_FACTORY_ADDRESS,
        wallet.address,
        implementation,
      );
      const code = await provider.getCode(proxyAddress);
      const proxyBalance = await usdcContract.balanceOf(proxyAddress);
      const isDeployed = code !== "0x";

      statuses.push({
        address: proxyAddress,
        type: "Proxy",
        deployed: isDeployed,
        signatureType: 0,
        canTrade: false, // Proxy can't trade on CLOB without MagicLink
        balance: isDeployed ? proxyBalance : ethers.BigNumber.from(0),
        stuckFunds:
          !isDeployed && proxyBalance.gt(0) ? proxyBalance : undefined,
        stuckAddress:
          !isDeployed && proxyBalance.gt(0) ? proxyAddress : undefined,
      });
    }
  } catch {}

  // Safe wallet
  const safeAddress = await getSafeAddress(wallet.address, provider);
  if (safeAddress) {
    const safeBalance = await usdcContract.balanceOf(safeAddress);
    statuses.push({
      address: safeAddress,
      type: "Safe",
      deployed: true,
      signatureType: 2,
      canTrade: true,
      balance: safeBalance,
    });
  }

  return statuses;
}

export function printWalletStatus(statuses: WalletStatus[]): void {
  log("Wallet Status:");
  for (const s of statuses) {
    const balStr = formatUSDC(s.balance);
    if (s.type === "Proxy" && !s.deployed) {
      if (s.stuckFunds && s.stuckFunds.gt(0)) {
        log(
          `  Proxy: not deployed (${formatUSDC(
            s.stuckFunds,
          )} USDC stuck at ${s.stuckAddress?.slice(0, 10)}...)`,
        );
      } else {
        log(`  Proxy: not deployed`);
      }
    } else {
      const tradeStatus = s.canTrade ? "[can trade]" : "[no CLOB]";
      log(
        `  ${s.type}: ${s.address.slice(
          0,
          10,
        )}... (${balStr} USDC) ${tradeStatus}`,
      );
    }
  }
}

// ============================================================================
// POSITION SCANNING
// ============================================================================

export async function scanWalletForTokens(
  walletAddress: string,
  rpcUrl: string,
  daysBack: number = 90,
): Promise<Set<string>> {
  const tokenIds = new Set<string>();
  try {
    // Calculate fromBlock based on daysBack (assuming ~2s block time on Polygon)
    const blocksPerDay = (24 * 60 * 60) / 2;
    const blocksBack = Math.floor(blocksPerDay * daysBack);
    const currentBlockResp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
        params: [],
      }),
    });
    let fromBlock = "0x0";
    if (currentBlockResp.ok) {
      const blockData = await currentBlockResp.json();
      const currentBlock = parseInt(blockData.result, 16);
      fromBlock = "0x" + Math.max(0, currentBlock - blocksBack).toString(16);
    }

    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getAssetTransfers",
        params: [
          {
            fromBlock,
            toBlock: "latest",
            toAddress: walletAddress,
            contractAddresses: [CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS],
            category: ["erc1155"],
            withMetadata: false,
            maxCount: "0x3e8",
          },
        ],
      }),
    });
    if (response.ok) {
      const data = await response.json();
      for (const transfer of data.result?.transfers || []) {
        for (const meta of transfer.erc1155Metadata || []) {
          tokenIds.add(meta.tokenId);
        }
      }
    }
  } catch {}
  return tokenIds;
}

// Batch check balances for multiple tokens at once using JSON-RPC batch
export async function batchGetBalances(
  tokenIds: string[],
  walletAddress: string,
  rpcUrl: string,
): Promise<Map<string, ethers.BigNumber>> {
  const balances = new Map<string, ethers.BigNumber>();
  if (tokenIds.length === 0) return balances;

  const iface = new ethers.utils.Interface(erc1155Abi);
  const batchSize = 100; // Process in chunks to avoid RPC limits

  for (let i = 0; i < tokenIds.length; i += batchSize) {
    const chunk = tokenIds.slice(i, i + batchSize);
    const calls = chunk.map((tokenId, idx) => ({
      jsonrpc: "2.0",
      id: idx,
      method: "eth_call",
      params: [
        {
          to: CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS,
          data: iface.encodeFunctionData("balanceOf", [walletAddress, tokenId]),
        },
        "latest",
      ],
    }));

    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(calls),
      });
      if (response.ok) {
        const results = await response.json();
        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.result && result.result !== "0x") {
            const balance = ethers.BigNumber.from(result.result);
            if (balance.gt(0)) {
              balances.set(chunk[j], balance);
            }
          }
        }
      }
    } catch {}
  }

  return balances;
}

// Get positions with balance, batched for efficiency
export async function getPositionsWithBalance(
  walletAddress: string,
  rpcUrl: string,
  daysBack: number = 90,
): Promise<PositionInfo[]> {
  const tokenIds = await scanWalletForTokens(walletAddress, rpcUrl, daysBack);
  if (tokenIds.size === 0) return [];

  // Batch get all balances first
  const balances = await batchGetBalances(
    Array.from(tokenIds),
    walletAddress,
    rpcUrl,
  );
  if (balances.size === 0) return [];

  log(`  Found ${balances.size} position(s) with balance`);

  // Only fetch CLOB info for tokens with balance
  const positions: PositionInfo[] = [];
  const tokenArray = Array.from(balances.keys());

  // Batch CLOB API calls (parallel with limit)
  const batchSize = 10;
  for (let i = 0; i < tokenArray.length; i += batchSize) {
    const chunk = tokenArray.slice(i, i + batchSize);
    const promises = chunk.map(async (tokenId) => {
      const balance = balances.get(tokenId)!;
      const decimalTokenId = ethers.BigNumber.from(tokenId).toString();

      let price = 0,
        tickSize = "0.01",
        negRisk = false,
        marketActive = false;

      try {
        const tickResp = await fetch(
          `${CLOB_HOST}/tick-size?token_id=${decimalTokenId}`,
        );
        if (tickResp.ok) {
          const tickData = await tickResp.json();
          if (tickData.minimum_tick_size) {
            tickSize = tickData.minimum_tick_size.toString();
            marketActive = true;
          }
        }
      } catch {}

      if (marketActive) {
        try {
          const [priceResp, negRiskResp] = await Promise.all([
            fetch(`${CLOB_HOST}/price?token_id=${decimalTokenId}&side=sell`),
            fetch(`${CLOB_HOST}/neg-risk?token_id=${decimalTokenId}`),
          ]);
          if (priceResp.ok) {
            const priceData = await priceResp.json();
            price = parseFloat(priceData.price || "0");
          }
          if (negRiskResp.ok) {
            const negRiskData = await negRiskResp.json();
            negRisk = negRiskData.neg_risk || false;
          }
        } catch {}
      }

      return {
        tokenId: decimalTokenId,
        balance,
        price,
        tickSize,
        negRisk,
        isResolved: !marketActive || price >= 0.999,
      };
    });

    const results = await Promise.all(promises);
    positions.push(...results);
  }

  return positions;
}

// ============================================================================
// MARKET DISCOVERY
// ============================================================================

export async function findActiveMarkets(): Promise<{
  ctfMarket: MarketInfo | null;
  negRiskMarket: MarketInfo | null;
}> {
  let ctfMarket: MarketInfo | null = null;
  let negRiskMarket: MarketInfo | null = null;

  try {
    const resp = await fetch(`${CLOB_HOST}/sampling-markets?limit=100`);
    if (!resp.ok) return { ctfMarket, negRiskMarket };

    const data = await resp.json();
    const markets = data.data || data;
    if (!Array.isArray(markets)) return { ctfMarket, negRiskMarket };

    for (const market of markets) {
      if (!market.accepting_orders || market.closed || !market.tokens?.length)
        continue;
      const price = market.tokens[0].price || 0;
      if (price < 0.1 || price > 0.9) continue;

      const info: MarketInfo = {
        tokenId: market.tokens[0].token_id,
        price,
        tickSize: market.minimum_tick_size?.toString() || "0.01",
        negRisk: market.neg_risk || false,
        question: market.question?.slice(0, 50),
      };

      if (!market.neg_risk && !ctfMarket) {
        ctfMarket = info;
      } else if (market.neg_risk && !negRiskMarket) {
        negRiskMarket = info;
      }
      if (ctfMarket && negRiskMarket) break;
    }
  } catch {}

  return { ctfMarket, negRiskMarket };
}

// ============================================================================
// FUNDING
// ============================================================================

export async function fundWallet(
  wallet: ethers.Wallet,
  toAddress: string,
  amount: ethers.BigNumber,
  provider: ethers.providers.Provider,
): Promise<boolean> {
  try {
    const usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, wallet);
    const gasPrice = await provider.getGasPrice();
    const tx = await usdcContract.transfer(toAddress, amount, {
      gasPrice: gasPrice.mul(2),
      gasLimit: 100000,
    });
    await tx.wait();
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// APPROVALS
// ============================================================================

export async function setupEOAApprovals(
  wallet: ethers.Wallet,
  provider: ethers.providers.Provider,
): Promise<boolean> {
  try {
    const ctfContract = new ethers.Contract(
      CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS,
      erc1155Abi,
      wallet,
    );
    const usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, wallet);
    const gasPrice = await provider.getGasPrice();

    for (const op of OPERATORS) {
      const isApproved = await ctfContract.isApprovedForAll(
        wallet.address,
        op.address,
      );
      if (!isApproved) {
        const tx = await ctfContract.setApprovalForAll(op.address, true, {
          gasPrice: gasPrice.mul(2),
          gasLimit: 100000,
        });
        await tx.wait();
      }

      const allowance = await usdcContract.allowance(
        wallet.address,
        op.address,
      );
      if (allowance.lt(ethers.utils.parseUnits("1000", USDCE_DIGITS))) {
        const tx = await usdcContract.approve(
          op.address,
          ethers.constants.MaxUint256,
          { gasPrice: gasPrice.mul(2), gasLimit: 100000 },
        );
        await tx.wait();
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function setupSafeApprovals(
  wallet: ethers.Wallet,
  safeAddress: string,
  provider: ethers.providers.Provider,
): Promise<boolean> {
  try {
    const safe = new ethers.Contract(safeAddress, safeAbi, wallet);
    const ctfContract = new ethers.Contract(
      CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS,
      erc1155Abi,
      provider,
    );
    const usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
    const gasPrice = await provider.getGasPrice();
    const safeTxns: SafeTransaction[] = [];

    for (const op of OPERATORS) {
      const isApproved = await ctfContract.isApprovedForAll(
        safeAddress,
        op.address,
      );
      if (!isApproved) {
        safeTxns.push({
          to: CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS,
          data: new ethers.utils.Interface(erc1155Abi).encodeFunctionData(
            "setApprovalForAll",
            [op.address, true],
          ),
          operation: OperationType.Call,
          value: "0",
        });
      }

      const allowance = await usdcContract.allowance(safeAddress, op.address);
      if (allowance.lt(ethers.utils.parseUnits("1000", USDCE_DIGITS))) {
        safeTxns.push({
          to: USDC_ADDRESS,
          data: encodeErc20Approve(op.address, ethers.constants.MaxUint256),
          operation: OperationType.Call,
          value: "0",
        });
      }
    }

    if (safeTxns.length > 0) {
      const tx = await signAndExecuteSafeTransaction(
        wallet,
        safe,
        aggregateTransaction(safeTxns),
        {
          gasPrice: gasPrice.mul(2),
          gasLimit: 500000,
        },
      );
      await tx.wait();
    }
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// WITHDRAWALS
// ============================================================================

export async function withdrawProxyUSDC(
  wallet: ethers.Wallet,
  proxyAddress: string,
  provider: ethers.providers.Provider,
): Promise<ethers.BigNumber> {
  const usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
  const balance = await usdcContract.balanceOf(proxyAddress);
  if (balance.lte(0)) return ethers.BigNumber.from(0);

  try {
    const factory = new ethers.Contract(
      PROXY_WALLET_FACTORY_ADDRESS,
      proxyFactoryAbi,
      wallet,
    );
    const transferData = new ethers.utils.Interface(
      erc20Abi,
    ).encodeFunctionData("transfer", [wallet.address, balance]);
    const gasPrice = await provider.getGasPrice();
    const tx = await factory.proxy(
      [{ to: USDC_ADDRESS, typeCode: 1, data: transferData, value: 0 }],
      { gasPrice: gasPrice.mul(2), gasLimit: 500000 },
    );
    await tx.wait();
    return balance;
  } catch (e) {
    log(`  Proxy withdraw error: ${(e as Error).message.slice(0, 50)}`);
    return ethers.BigNumber.from(0);
  }
}

export async function withdrawSafeUSDC(
  wallet: ethers.Wallet,
  safeAddress: string,
  provider: ethers.providers.Provider,
): Promise<ethers.BigNumber> {
  const usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
  const balance = await usdcContract.balanceOf(safeAddress);
  if (balance.lte(0)) return ethers.BigNumber.from(0);

  try {
    const safe = new ethers.Contract(safeAddress, safeAbi, wallet);
    const transferData = new ethers.utils.Interface(
      erc20Abi,
    ).encodeFunctionData("transfer", [wallet.address, balance]);
    const gasPrice = await provider.getGasPrice();
    const tx = await signAndExecuteSafeTransaction(
      wallet,
      safe,
      {
        to: USDC_ADDRESS,
        data: transferData,
        operation: OperationType.Call,
        value: "0",
      },
      { gasPrice: gasPrice.mul(2), gasLimit: 200000 },
    );
    await tx.wait();
    return balance;
  } catch {
    return ethers.BigNumber.from(0);
  }
}

// ============================================================================
// UTILITY
// ============================================================================

export function formatUSDC(amount: ethers.BigNumber): string {
  return ethers.utils.formatUnits(amount, USDCE_DIGITS);
}

export function parseUSDC(amount: string): ethers.BigNumber {
  return ethers.utils.parseUnits(amount, USDCE_DIGITS);
}

export async function getUSDCBalance(
  address: string,
  provider: ethers.providers.Provider,
): Promise<ethers.BigNumber> {
  const usdcContract = new ethers.Contract(USDC_ADDRESS, erc20Abi, provider);
  return usdcContract.balanceOf(address);
}
