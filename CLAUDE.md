# ApeX Utility — context for Claude

The owner writes in Indonesian; answer in Indonesian. Bot and website copy are in English.
This project was started on a phone (Termux / PRoot), so earlier work could not use a real browser.

## What this is

A Solana trading & utility bot for Telegram (mascot: a monkey 🐒 with bananas 🍌), inspired by
Banana Gun, focused on Day-1 utility and revenue sharing. Live bot: @apex_utility_chain_bot.
Plus a static landing page in `website/`.

## Commands

- `npm run dev` — run the bot (long polling, auto-restart on file change). Needs `.env`.
- `npm start` — run the bot without watch.
- `npm run site` — serve `website/` on port 3000 (prints LAN IPs). `PORT=8080 npm run site` to change.
- No test suite yet.

`.env` is not in git. Copy `.env.example` and fill `BOT_TOKEN`, `WALLET_SECRET`, `TREASURY_ADDRESS`.
`WALLET_SECRET` must never change once wallets exist (it decrypts every stored key).

## Bot architecture (Node.js, CommonJS)

- `index.js` — validates config, checks the RPC cluster, sets bot profile/commands, starts polling.
- `src/config/` — `index.js` (env, fees, paths), `solana.js` (SOL mint, lamports, token program ids).
- `src/services/`
  - `connection.js` — `@solana/web3.js` v1 Connection.
  - `jupiterService.js` — Jupiter lite API (quote, swap tx, token search) with 429 retry.
  - `tradeService.js` — buy/sell/withdraw, fee collection to treasury, per-user lock, `friendlyError()`.
  - `walletService.js` — Keypair per Telegram user, base58 key encrypted (AES-256-GCM) in `data/wallets.json`.
  - `statsService.js` — trade log in `data/stats.json` (30 days) for live revenue-share stats.
  - `revenueService.js` — revenue model + calculator scenarios.
  - `gasService.js` — priority fees (sampled on the Raydium SOL-USDC pool; unfiltered RPC returns zeros).
  - `priceService.js` — SOL/USD via Jupiter price API.
- `src/bot/` — grammY bot. `commands/*` register commands + callback handlers; `commands/text.js`
  must stay last (pending prompts, pasted token addresses). `keyboards/` builds inline keyboards.
  `helpers.js` has `respond()` (edit on button, reply on command), pending-input and confirmation stores.
- Storage is JSON files (`src/utils/jsonStore.js`, atomic writes). Fine for launch; move to a DB later.

Revenue model (from `.env`): fee 1% of each trade (`BOT_FEE_BPS=100`); 40% of fees to the community
(`REVENUE_SHARE_BPS=4000`), of which 70% to $APEX holders by holdings and 30% to active traders by
24h volume. Fees are only charged when `TREASURY_ADDRESS` is set; they are sent as a second transfer
after a confirmed swap.

## Decisions already made (don't revisit without asking)

- Chain is **Solana mainnet** via **Jupiter** (the owner uses Solana, not ETH). Jupiter has no devnet.
- All bot and site copy is **English**. The earlier demo / CLI demo mode was removed on purpose.
- Website: static HTML/CSS/JS, GSAP 3.12.5 + ScrollTrigger from cdnjs, font Archivo (Google Fonts).
  Design guidance followed: impeccable craft floor, taste-skill house rules (no eyebrows, gradients,
  glows, icon cards; one ground/ink/accent), GSAP best practices. Every animation has a
  reduced-motion fallback and content is visible without JS.

## Website owner preferences (from review rounds)

- Mascot: the owner **likes the monkey face** — keep it. The full-body mascot leans on the left edge
  of the bot phone screen in the hero. Outlined cartoon style; limbs behind the body; head overlaps
  the body (no neck gap). Regenerate it with `website/art/mascot.js`, the banana with `website/art/banana.js`.
- Hero must stay **compact**.
- "Where your 1% goes": the banana is **static** (already split 60/28/12) — no scroll effect on it.
  The three legend columns are **equal width**.
- "How it works": plain four-step layout. **No** sticky phone stage, no dimmed steps, no step counter.
- Motion the owner kept: hero load sequence (masked headline lines, mascot slides in), hero recedes on
  scroll, section headings rise line by line, list rows arrive per section, calculator numbers glide,
  footer wordmark rises. For the two sections above, **only the text animates**.
- When the owner asks to remove something they usually mean **undo to the previous version**.

## Before launch (open items)

- Revoke and replace the bot token (it was pasted in a chat once).
- Use a private Solana RPC (Helius/QuickNode); the public one rate-limits.
- Revenue distribution to holders/traders is tracked but **not paid out** yet.
- Run on a VPS 24/7; back up `WALLET_SECRET` and `data/`.
- Confirm site copy: "ApeX keeps 60%", $APEX supply 1,000,000 (placeholder from `.env`).
- A security review/audit of the custodial wallet code before real users.
