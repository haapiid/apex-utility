# ApeX Utility 🐒🍌

Solana trading & utility bot for Telegram, with revenue sharing for holders and active traders.
Paste a token address in the chat, tap Buy, confirm. Swaps are routed through Jupiter.

- Bot: [@apex_utility_chain_bot](https://t.me/apex_utility_chain_bot)
- Landing page: `website/`

## Setup

Requires Node.js 18+.

```bash
npm install
cp .env.example .env   # then fill BOT_TOKEN, WALLET_SECRET and TREASURY_ADDRESS
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

`/start` · `/wallet` · `/buy <mint> <SOL>` · `/sell <mint> <percent>` · `/withdraw <address> <amount|all>` · `/revenue` · `/fees` · `/help`

## Notes

- Trades run on Solana mainnet with real funds. Test with small amounts.
- User keys are encrypted with `WALLET_SECRET` and stored in `data/wallets.json`. Back up both; never commit them.
- The public Solana RPC is rate-limited. Use a private RPC for production.
