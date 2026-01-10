# Polymarket Wallet Recovery Tools

Recover funds stuck in Polymarket smart contract wallets. If you've lost access to your Polymarket account or have funds trapped in proxy/safe wallets, these tools can help you retrieve your USDC and positions.

## What This Solves

Polymarket uses smart contract wallets internally. When you create an account:

- **Email/Magic accounts** use Proxy Wallets
- **Browser wallets** (MetaMask, Coinbase Wallet, Rainbow, etc.) use Safe Wallets

Your funds can get "stuck" in these wallets if:

- You lose access to your Polymarket account
- The website is unavailable
- You want to withdraw directly without using the UI
- You have unresolved winning positions that need redemption

## Features

- **Wallet Discovery**: Automatically finds all wallets (EOA, Proxy, Safe) associated with your private key
- **Position Scanning**: Detects all prediction market positions with balances
- **Market Selling**: Sells active positions at market price
- **Position Redemption**: Redeems winning positions from resolved markets
- **USDC Withdrawal**: Withdraws all USDC from smart contract wallets to your EOA

## Prerequisites

- [Bun](https://bun.com/)
- A Polygon RPC URL (Alchemy, Infura, or other provider)
- Your wallet's private key

## Quick Start

1. Clone the repository:

```bash
git clone https://github.com/0-don/polymarket-wallet-recovery.git
cd polymarket-wallet-recovery
```

2. Install dependencies:

```bash
bun install

```

3. Configure environment:

```bash
cp .env.example .env
```

Edit `.env`:

```
PK=your_private_key_here
RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
```

Get a free Polygon RPC URL at [alchemy.com/polygon](https://www.alchemy.com/polygon).

4. Run the recovery script:

```bash
bun run sell
```

## What the Script Does

1. **Discovers wallets** - Finds your EOA, Proxy wallet, and Safe wallet addresses
2. **Shows balances** - Displays USDC balance in each wallet
3. **Cancels buy orders** - Cancels any open buy orders (sells are kept)
4. **Sells positions** - Market sells all active prediction positions
5. **Redeems winnings** - Claims payouts from resolved markets
6. **Withdraws USDC** - Transfers all USDC to your EOA wallet

## Configuration

Edit [wallet-config.ts](src/wallet-config.ts) to enable/disable operations per wallet type:

```typescript
export const walletConfig = {
  EOA: { marketSell: true, redeem: true, ... },
  Proxy: { marketSell: true, redeem: true, withdraw: true, ... },
  Safe: { marketSell: true, redeem: true, withdraw: true, ... },
}
```

## Wallet Types Explained

| Wallet Type | Created By        | Can Trade on CLOB | Notes                          |
| ----------- | ----------------- | ----------------- | ------------------------------ |
| EOA         | You               | Yes               | Your main wallet               |
| Proxy       | Email/Magic login | No\*              | Requires MagicLink for trading |
| Safe        | Browser wallet    | Yes               | Modified Gnosis Safe           |

\*Proxy wallets can sell/redeem but cannot place new orders without MagicLink authentication.

## Important Notes

- Always test with a small amount first
- Keep your private key secure - never share it
- This tool requires MATIC for gas fees
- Positions may have slippage when market selling

## License

MIT
