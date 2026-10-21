# ApeX Utility 🐒🍌

Multi-chain trading platform with revenue sharing: a **Telegram bot** and **ApeX Pro**, a web trading
terminal that works without Telegram. Both share the same accounts, wallets, settings and rewards.
Paste a token address, tap Buy, confirm. The chain is detected from the address.

**ApeX Pro** (`webapp/`, served on `WEB_PORT`): discover (new pairs / trending / boosted), trending
table, token pages with a live chart, trade tape and a Market / Limit / DCA trade box, positions with
PnL, orders (limit, TP/SL, DCA, snipes, copy trading), wallets, a rewards claim dashboard, settings and
notifications. Log in with Phantom / MetaMask (sign a message), Google (optional), or a one-time code
from the bot (`/web`); logins can be linked to one account. Market data: DexScreener + GeckoTerminal.

| Chain | Swaps via | Native |
|---|---|---|
| Solana | Jupiter | SOL |
| Ethereum, Base, MegaETH, Robinhood | KyberSwap | ETH |
| BSC | KyberSwap | BNB |
| HyperEVM | KyberSwap | HYPE |
| Stable | coming soon (no aggregator yet) | USDT0 |

Each user can hold up to 5 Solana and 5 EVM wallets (an EVM wallet has the same address on every EVM
chain); the active one trades. Also: positions with PnL, per-user settings (slippage, MEV protection,
Jito tip, gas boost, buy/sell buttons, instant trades), and MEV protection via Jito / Flashbots /
PancakeSwap MEV Guard. Fees: 0.5% manual trades, 1% snipes.

Automation (background workers): limit buys, take profit / stop loss, DCA buy/sell, a sniper that buys
the moment a token becomes tradable (with a safety filter), copy trading of any wallet, and a reactive
anti-rug that sells a position when its value suddenly collapses. Token cards show a safety scan
(GoPlus + on-chain checks).

Rewards: referral links (25% of invited users' fees), revenue share (40% of fees after referrals to
$APEX holders, distributed every 24 h), cashback in $APEX, and burning $APEX for credits. Claims are paid
gas-free from a separate rewards wallet. $APEX features switch on once `APEX_TOKEN_ADDRESS` is set.

- Bot: [@apex_utility_chain_bot](https://t.me/apex_utility_chain_bot)
- ApeX Pro: http://localhost:8080 when running locally (`WEB_PUBLIC_URL` in production, behind HTTPS)
- Landing page: `website/`

## Setup

Requires Node.js 22.13+ (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env   # then fill BOT_TOKEN, WALLET_SECRET, TREASURY_ADDRESS and EVM_TREASURY_ADDRESS
```

Generate a wallet secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Run

| Command | What it does |
|---|---|
| `npm run dev` | Run the Telegram bot and restart on changes |
| `npm start` | Run the Telegram bot |
| `npm run site` | Serve the landing page at http://localhost:3000 |

## Bot commands

`/start` · `/wallet` · `/positions` · `/rewards` · `/referral` · `/admin` · `/orders` · `/snipe [chain] <token> <amount>` · `/copy` · `/settings` · `/buy [chain] <token> <amount>` · `/sell [chain] <token> <percent>` · `/withdraw [chain] <address> <amount|all>` · `/revenue` · `/fees` · `/help`

Chain keys: `sol`, `eth`, `bsc`, `base`, `hyper`, `mega`, `hood`. The chain is optional for buy/sell
(detected from the address) and required for EVM withdrawals.

## Notes

- Trades run on mainnet with real funds. Test with small amounts.
- User keys are encrypted with `WALLET_SECRET` and stored in `data/apex.db` (SQLite). Back up both; never
  commit them. An old `data/wallets.json` / `stats.json` is imported automatically on first start.
- Solana fees are taken inside the swap once the treasury's wSOL account exists:
  `SETUP_PAYER_KEY=<base58 key of any funded wallet> npm run setup:fee-account` (one time, ~0.002 SOL rent).
- The default RPCs are public and rate-limited. Use private RPCs for production (`*_RPC_URL` in `.env`).
- EVM fees are taken inside the KyberSwap swap (no extra transaction). Selling a token on EVM needs a
  one-time approval transaction per token.
