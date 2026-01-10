// Per-wallet configuration for trading operations
// Set to true to enable, false to disable

export const walletConfig = {
  EOA: {
    marketBuy: false,
    limitOrder: false,
    cancelOrders: true,
    marketSell: true,
    redeem: true,
    withdraw: false, // EOA doesn't withdraw to itself
  },
  Proxy: {
    marketBuy: false, // Can't trade on CLOB without MagicLink
    limitOrder: false,
    cancelOrders: true,
    marketSell: true,
    redeem: true,
    withdraw: true,
  },
  Safe: {
    marketBuy: true,
    limitOrder: false,
    cancelOrders: true,
    marketSell: true,
    redeem: true,
    withdraw: true,
  },
} as const;
