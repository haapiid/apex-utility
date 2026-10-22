# ApeX Utility — context for Claude

The owner writes in Indonesian; answer in Indonesian. Bot and website copy are in English.
This project was started on a phone (Termux / PRoot), so earlier work could not use a real browser.

## What this is

ApeX is a multi-chain trading **platform** (mascot: a monkey 🐒 with bananas 🍌), inspired by Banana Gun,
focused on Day-1 utility and revenue sharing. **Not only a Telegram bot** (owner, 2026-10-22):
- the Telegram bot @apex_utility_chain_bot,
- **ApeX Pro** (`webapp/`, like Banana Pro), a web trading terminal usable **without Telegram**,
- a static landing page in `website/`.
Bot and ApeX Pro share one account system, wallets, settings, positions, orders and rewards.
Chains: Solana (Jupiter) + Ethereum, BSC, Base, HyperEVM, MegaETH, Robinhood (KyberSwap). Stable is
listed as "coming soon" because no aggregator supports it yet.

## Commands

- `npm run dev` — run the bot + ApeX Pro (long polling, auto-restart on file change). Needs `.env`.
- `npm start` — run the bot + ApeX Pro without watch. ApeX Pro listens on `WEB_PORT` (8080) once the
  bot has connected to Telegram. **Without `BOT_TOKEN`** it runs ApeX Pro alone (workers on, wallet /
  Google login, Telegram login hidden) — ApeX is not only a Telegram bot.
- `npm run site` — serve `website/` on port 3000 (prints LAN IPs). `PORT=8080 npm run site` to change.
- No test suite yet.

`.env` is not in git. Copy `.env.example` and fill `BOT_TOKEN`, `WALLET_SECRET`, `TREASURY_ADDRESS`,
`EVM_TREASURY_ADDRESS` (and private `*_RPC_URL`s for launch).
`WALLET_SECRET` must never change once wallets exist (it decrypts every stored key).

## Bot architecture (Node.js, CommonJS)

- `index.js` — validates config, checks the RPC cluster, sets bot profile/commands, starts polling.
- `src/config/` — `index.js` (env, fees, paths), `solana.js` (SOL mint, lamports, token program ids),
  `chains.js` (chain registry: key, chainId, KyberSwap slug, native coin, RPC, explorer, buy presets).
- `src/services/`
  - `markets.js` — `serviceFor(chain)` picks the Solana or EVM trade service (same interface);
    `detectEvmChains(address)` finds which EVM chains have code at a 0x address.
  - `tradeCommon.js` — `UserError`, per-user lock (shared across chains), `withTimeout`, `friendlyError()`.
  - `connection.js` — `@solana/web3.js` v1 Connection.
  - `jupiterService.js` — Jupiter lite API (quote, swap tx, token search) with 429 retry.
  - `tradeService.js` — Solana buy/sell/withdraw, fee collection to treasury.
  - `evm/` — `provider.js` (ethers v6 JsonRpcProvider per chain), `kyberService.js` (routes + build,
    429 retry), `evmTradeService.js` (`forChain(chain)`: ERC-20 info, buy/sell with approval, withdraw).
  - `accountService.js` — accounts: user id > 0 = Telegram id (bot works), < 0 = web-only account.
    Identities (`sol` / `evm` wallet address, `google` id) are extra logins on a user. Sign-in with a
    wallet = signing a one-time message (nonce in `auth_nonces`, verified with Node's Ed25519 / ethers);
    Google = OAuth code flow + PKCE (only when `GOOGLE_CLIENT_ID/SECRET` are set). Linking Telegram to a
    web-only account **merges** it into the Telegram id (`mergeUsers` moves every user_id row).
    Sign-in wallets only prove identity; trading always uses ApeX's custodial wallets.
  - `webAuthService.js` — web sessions (hashed tokens, 30 days) and the Telegram login code (`/web`).
  - `notificationService.js` — `createNotifier(botApi)`: every worker/admin message is stored for ApeX Pro
    and also sent on Telegram when the user id is positive.
  - `marketData.js` — ApeX Pro market data: DexScreener (pairs, prices, search, boosted) and GeckoTerminal
    (trending, new pools, OHLCV, trades) behind a stale-while-revalidate cache; GeckoTerminal's free tier
    is strict, so its calls go through a 1-per-6.5 s queue.
  - `walletService.js` — up to 5 `sol` (base58) and 5 `evm` (0x hex) wallets per user, keys
    encrypted (AES-256-GCM). One active wallet per kind trades. Stored in SQLite.
  - `settingsService.js` — per-user settings (JSON on `users.settings`): MEV on/off, confirm trades,
    slippage per kind, Jito tip, max priority fee, EVM gas boost, buy/sell buttons. `tradeOptions()`
    gives a trade everything it needs, incl. the fee for its source (manual/snipe/limit/dca/copy).
  - `positionService.js` — average-cost positions per wallet+token (raw bigints as text); `portfolioService.js`
    values them at the current sell quote (3 at a time, free aggregator tiers rate-limit bursts).
  - `jitoService.js` — sends Solana swaps to Jito as single-tx bundles (`bundleOnly=true`); falls back to RPC.
  - `statsService.js` — trade log in the `trades` table. Solana trades in SOL, EVM in USD.
  - `revenueService.js` — revenue model + calculator scenarios.
  - `gasService.js` — Solana priority fees (sampled on the Raydium SOL-USDC pool) + EVM gas prices.
  - `priceService.js` — SOL/USD via Jupiter price API.
- `src/services/automationService.js` — data + validation for limit orders (limit_buy / take_profit /
  stop_loss), DCA plans, snipes and copy targets. Prices are "native coin per whole token", measured with
  the order's own size (`sellPrice` / `buyPrice`), so triggers include price impact.
- `src/services/safetyService.js` — token scan: GoPlus (Ethereum, BSC, Base, Robinhood, Solana) + Solana
  freeze/mint authority from the mint account; sell-route check where GoPlus has no coverage.
- `src/services/pumpFeed.js` + `pumpService.js` — pump.fun sniper. PumpPortal's free WebSocket
  (`PUMP_FEED_URL`, Node's built-in WebSocket) streams new tokens and migrations; it is connected only
  while a pump rule / migration snipe is active or ApeX Pro's live list was viewed in the last minute.
  Rules (`pump_rules`): `launch` (filters: keyword in name/symbol, max dev buy %) or `migration`, SOL per
  buy, `max_buys` budget. `pump_buys` dedupes per rule + mint (and per user + mint). Stage check via the
  Jupiter route label: `Pump.fun` = bonding curve, anything else (`Pump.fun Amm`, …) = migrated; Jupiter
  routes a fresh launch in ~2–5 s. Per-token snipes have `trigger` `tradable` | `migration` (7-day TTL).
  A rule stops itself (one message) when the wallet is out of SOL; launch-rule failures only show in
  the Recent list. Bot: `/pump`, `/snipe <mint> <sol> migration`. ApeX Pro: `#/pump`.
- ApeX Pro extras (2026-10-22):
  - `tokenMetrics.js` — holders / top 10 % / dev % (Solana: Jupiter Tokens API, 100 per call; EVM: GoPlus,
    one token per call, queued) and Solana launch stats (bundled = bought in the launch slot, snipers =
    first buys in the next 3 slots; program/pool owners excluded), stored in `token_launch`. Holders list:
    Jupiter's **undocumented** data API (`datapi.jup.ag`, top 100 + funding wallet → bubble-map clusters),
    falling back to the RPC's top 20. `marketData.topTraders` = realized PnL over the last 300 trades.
  - `solanaRpc.js` — raw JSON-RPC (paced, 429 retry) because web3.js v1 rejects **version-1
    transactions**; `walletActivity.js` (shared by copy trading and the wallet tracker) uses it.
  - Settings: top-level trade fields = buy side, `sell` = sell overrides (`sideSettings`,
    `tradeOptions(..., side)`). `maxImpactPct` blocks buys and manual sells only (`checkImpact`);
    automated sells (stop loss, `antirug` source, DCA, copy) always go through.
  - `historyService`, `watchlistService`, `trackerService` + `workers/tracker.js` (15 s, events kept 7 days),
    `pinService` (scrypt, 5 tries → 15 min lock; guards web export / import / remove, not the bot).
  - Bot (`commands/lists.js`): `/history`, `/watchlist` (⭐ Watch on token cards toggles), `/tracker`
    (add with `[chain] <address> [name]`, 🔔 toggle, 🗑 remove); `/settings` → 🔴 Sell settings
    ("Same as buy" copies the buy values into `sell` when turned off) and 📉 Max impact per side.
  - Executes take `walletId` (multi-wallet backend); the trade box UI for it and Discover card metrics /
    column filters were **not built** (stopped by a safety check — don't retry them).
  - Webapp: ticker, token tabs (Top traders, Holders, Bubble map, My trades, `?tab=`), Watchlist, Tracker,
    Positions → History, Settings buy/sell, Wallets import / remove / PIN. `replaceChildren()` prints a
    `null` child as text: pass `''` or filter. The header is `header.top` (`.row.top` collided with it).
- `src/workers/` — background jobs started in `index.js` after the bot connects (`startWorkers(notify)`):
  sniper 4 s, pump 2 s, copy 10 s, tracker 15 s, orders 15 s, anti-rug 20 s, DCA 30 s. Each never overlaps itself. `common.attempt()`
  classifies outcomes: `busy` (user lock, retry silently), `user`/`error` (count an attempt, 3 → failed).
  Everything trades from the user's **active** wallet. Copy trading only mirrors transactions the target
  signed (Solana: token balance deltas; EVM: ERC-20 Transfer logs + tx.value > 0 for buys). Anti-rug is
  reactive: sells 100% when value per token drops ≥ the user's threshold between two checks.
- `src/web/` — ApeX Pro server, started from `index.js` in the bot process (one per-user trade lock for
  bot and web). `server.js`: `node:http`, static `webapp/` (+ `/img/*` from `website/img/`), JSON API,
  HttpOnly SameSite=Strict cookie, mutating requests need `X-ApeX: 1` + JSON + allowed Origin, per-IP rate
  limits, strict CSP (**no inline styles or scripts**: use classes), `X-Frame-Options: DENY`.
  `routes.js`: every endpoint calls the same services as the bot. Market pages are public; trading,
  positions, orders, wallets, rewards, settings need a session.
- `webapp/` — ApeX Pro frontend, vanilla ES modules, no build step. `js/lib.js` `h()` builds DOM with text
  only (never innerHTML: token names come from third-party APIs); bot notifications are shown as plain
  text. Views in `js/views/` return a cleanup function. Chart = TradingView Lightweight Charts 5.2.1 from
  jsDelivr. Dark terminal look in the brand palette; green/red only for market direction.
  Check desktop and ≤ 860px after UI changes (headless Edge enforces a 504px minimum width).
- `src/bot/` — grammY bot. `commands/*` register commands + callback handlers; `commands/text.js`
  must stay last (pending prompts, pasted token addresses). `keyboards/` builds inline keyboards.
  `helpers.js` has `respond()` (edit on button, reply on command), pending-input and confirmation stores.
- Storage is SQLite via built-in `node:sqlite` (Node ≥ 22.13), `src/db/index.js`: schema migrations by
  `PRAGMA user_version`, `transaction()`, `meta` table. Old `data/wallets.json` / `stats.json` are imported
  once and renamed to `*.imported.json`.

Fees (from `.env`): 0.5% manual (`FEE_MANUAL_BPS=50`), 1% snipes (`FEE_SNIPE_BPS=100`), 0.5% limit/DCA/copy
(`FEE_AUTO_BPS=50`). Solana fees need `TREASURY_ADDRESS`; Jupiter takes them inside the swap into the
treasury's wSOL token account (`platformFeeBps` + `feeAccount`, verified by simulation: buys take the fee
from the SOL input, sells from the SOL output). Create that account once with `npm run setup:fee-account`;
until it exists fees fall back to a second SOL transfer. EVM fees need `EVM_TREASURY_ADDRESS`; KyberSwap
takes them inside the swap (`chargeFeeBy` currency_in on buys, currency_out on sells).

MEV protection (per-user setting, default on): Solana via Jito (Jupiter `jitoTipLamports` adds the tip),
Ethereum via Flashbots Protect, BSC via PancakeSwap MEV Guard (`protectRpcUrl` in `chains.js`, sends only;
receipts are read from the normal RPC). The L2s have no public mempool.

Rewards (`src/services/rewardsService.js`, called after every fee-charging trade via `onTradeFee`; lazy
`require` there because rewardsService → markets → trade services):
- referral cut = fee × `REFERRAL_SHARE_BPS` (25%) → the referrer, in the trade chain's native coin.
  Users bind via `/start ref_<code>` only before their first trade.
- holder pool += (fee − referral) × `REVENUE_SHARE_BPS` (40%), per chain (`revenue_pool`). The `revenue`
  worker distributes every `REVENUE_EPOCH_HOURS` to ApeX users holding ≥ `APEX_MIN_HOLD` $APEX across
  their wallets on the token's chain, pro-rata. Rounding dust stays in the pool.
- cashback = fee USD × `CASHBACK_MULTIPLIER`, paid in $APEX at the current price on claim.
- Claims are paid from the rewards wallet (`REWARDS_*_PRIVATE_KEY`, gas-free for users). A claim row is
  reserved as `pending` before sending and marked `failed` (not counted) if the send fails.
- Burning $APEX (SPL BurnChecked / ERC-20 to 0x…dEaD) gives credits; credits buy extra wallet slots.
- Everything $APEX-based is off until `APEX_TOKEN_ADDRESS` is set; pools, referral and cashback still accrue.
- `/admin` (`ADMIN_IDS`): owed vs. rewards wallet balance per chain, manual distribution. Fees land in the
  treasury: the owner must move what's owed to the rewards wallets.

Callback data is `<action>:<chain key>:<address>[:<amount>]`; the chain part is optional so pre-multi-chain
Solana buttons still work. Keep it under Telegram's 64-byte limit.

## Decisions already made (don't revisit without asking)

- **Multi-chain** (owner's request, 2026-10-21; replaces "Solana only"): Solana via **Jupiter**, EVM
  chains via **KyberSwap** (no API key). Mainnet only. One EVM wallet per user for all EVM chains.
- All bot and site copy is **English**. The earlier demo / CLI demo mode was removed on purpose.
- Website: static HTML/CSS/JS, GSAP 3.12.5 + ScrollTrigger from cdnjs, font Archivo (Google Fonts).
  Design guidance followed: impeccable craft floor, taste-skill house rules (no eyebrows, gradients,
  glows, icon cards; one ground/ink/accent), GSAP best practices. Every animation has a
  reduced-motion fallback and content is visible without JS.

## Tools (project MCP servers and plugin)

Configured in `.mcp.json` and `.claude/settings.json` (project scope). Start Claude Code **from this
folder** so they load; approve the two project MCP servers the first time.

- **Website checks — `playwright` MCP** (Microsoft, pinned `@playwright/mcp@0.0.83`, uses Edge because
  Chrome isn't installed). Workflow: `npm run site` (port 3000) → `browser_navigate` http://localhost:3000 →
  `browser_take_screenshot` at desktop width, then `browser_resize` to 390×844 and screenshot again →
  `browser_console_messages` for errors. Check both widths after every website change.
- **UI design — `frontend-design` skill** (official Anthropic plugin). Use it for website / web app UI
  work, but the owner preferences below and the mascot guide win over its defaults.
- **Images (free, preferred) — `huggingface` MCP** (official, `https://huggingface.co/mcp`, OAuth on
  first start, no key in the repo). The owner's laptop has no usable GPU (Radeon 610M, 5.7 GB RAM), so
  generation runs on Hugging Face ZeroGPU Spaces: free account ≈ 5 GPU-minutes/day (≈ 10–25 edits).
  - Use **`Qwen/Qwen-Image-Edit-2511`** (Apache-2.0: fine for a commercial mascot) for reference-based
    poses. `black-forest-labs/FLUX.1-Kontext-Dev` also works but its license is non-commercial / ambiguous
    for outputs — only for drafts.
  - The owner adds those Spaces at https://huggingface.co/settings/mcp ("Spaces Tools").
  - Space tools take the reference image as a **public URL**: the owner decides where the master is
    hosted (e.g. the deployed site's `img/` or a public HF dataset). Don't upload it anywhere yourself.
  - Same rules as below: look at every result, run the guide's checklist, only approved art goes into
    `assets/mascot/`.
- **Images (paid) — `nano-banana` MCP** (third-party `nano-banana-mcp@1.0.3`, reviewed: only calls Google's
  `@google/genai`). Needs the `GEMINI_API_KEY` environment variable on the owner's machine, and a
  **billing-enabled** Google AI project: the Gemini free tier doesn't include image generation.
  - Never call `configure_gemini_token`: it writes the key to `.nano-banana-config.json` in the project
    (gitignored, but keep keys out of the repo entirely). Never put keys in `.mcp.json` or chat.
  - For mascot art use `edit_image` with `imagePath` = `assets/mascot/apex-mascot-master.png` (or an
    approved pose) and `referenceImages` = the master, plus a prompt from the guide's template.
  - Results land in `%USERPROFILE%\Documents\nano-banana-images\`. Look at each result, check it against
    the guide's consistency checklist, and only copy owner-approved images into `assets/mascot/`.
  - Image models can't guarantee an exact copy of the reference: say so, and iterate with
    `continue_editing` instead of claiming a match.
  - It uses the `gemini-2.5-flash-image-preview` model; if Google has retired it, the tool errors.

## Mascot (source of truth)

- The owner approved the mascot in `assets/mascot/apex-mascot-master.png` (sunglasses, black hoodie with a
  yellow X, banana, brand palette ivory `#F4F0E7` / black `#171714` / yellow `#F2C94C`).
- **Before any mascot, logo, icon or sticker work: read `assets/mascot/DESIGN_GUIDE.md` and look at the
  master image.** Follow its fixed features, palette, expressions, poses and small-size rules.
- Never overwrite or edit the master. New approved art goes in `assets/mascot/poses/` or
  `assets/mascot/expressions/`; supporting references in `assets/mascot/references/`.
- Generate art only through the `nano-banana` MCP (see Tools). If it isn't connected or has no key,
  don't claim to have made artwork: write the prompt from the guide's template and say the image still
  has to be generated.
- The website uses images **cut from the master** by `website/art/crop-mascot.js` (no dependencies; it
  only reads the master) into `website/img/`: hero bust, trading / win / casual poses, face mark, wordmark,
  X mark, favicons and the touch icon. Paper is removed by flood fill from the crop border (so teeth and
  highlights survive); lettering is keyed. Re-run it after changing a crop, then check the edges on black.
- `website/art/mascot.js` (the old hand-drawn SVG monkey) is no longer used by the site.

## Website owner preferences (from review rounds)

- Look (2026-10-21): brand palette ivory / black / yellow from the mascot guide; header = face mark
  image + **"ApeX" as black text** (not the wordmark image); favicon = yellow X on black.
- Sections are **compact** (owner request): `--section` / `--stack` tokens in `styles.css`, smaller h2,
  tight lists, table rows and FAQ. Keep new sections on the same tokens.
- Footer has **no mascot image**: just the "ApeX Utility" name, the bot button and the disclaimer.
- Mascot: the master bust stands on the hero's bottom edge (flat-cut hoodie) left of the bot phone, its
  banana hand reaching over the phone's left edge. Below 700px it peeks over the phone's top instead.
  No other mascot images on the page (the owner removed the Features, Revenue and footer poses).
- Hero must stay **compact**.
- "ApeX Pro" section (2026-10-22, after Features): text + a dark HTML "screen" of ApeX Pro's pump.fun page
  (sample data, no images). Every ApeX Pro link has `data-pro`; on localhost/LAN `main.js` points them at
  port 8080, elsewhere the HTML `href` is used: `https://pro.apexutility.fun`.
- Domain (owner, 2026-10-22): `apexutility.fun` (landing) + `pro.apexutility.fun` (ApeX Pro), VPS at Rumahweb
  (Bogor, Ubuntu 24.04, systemd service `apex`, Nginx + Let's Encrypt, `WEB_HOST=127.0.0.1`, `WEB_TRUST_PROXY=1`).
- "Where your 0.5% goes" (2026-10-21): the owner **removed the split banana and the Win pose** (the
  scattered candles looked blotchy). It shows a clean, still trading chart (`website/art/chart.js` →
  paste `chart.inline.svg`), with its top-right corner kept free for **the mascot riding a rocket** —
  art still to be generated (nano-banana, see Tools); place it in `.chart-wrap` once the owner approves.
  The 45/30/25 legend stays as text, three **equal-width** columns. `website/art/banana.js` is unused.
- "How it works": plain four-step layout. **No** sticky phone stage, no dimmed steps, no step counter.
- Motion the owner kept: hero load sequence (masked headline lines, mascot slides in), hero recedes on
  scroll, section headings rise line by line, list rows arrive per section, calculator numbers glide,
  footer wordmark rises. For the two sections above, **only the text animates**.
- When the owner asks to remove something they usually mean **undo to the previous version**.

## Roadmap to Banana Gun parity (owner decisions, 2026-10-21)

Built in phases, each tested before the next:
1. ✅ SQLite, multi-wallet, per-user settings, positions/PnL, fees 0.5%/1%, MEV protection.
2. ✅ Limit orders (TP/SL), DCA, anti-rug (safety scan + reactive auto-sell), sniper, copy trading.
3. ✅ Referral, $APEX cashback + burn credits, revenue share + claim.
4. ✅ ApeX Pro web app (like Banana Pro: discover columns, trending, token page with chart / trades /
   market-limit-DCA trade box, positions, orders, wallets, rewards claim dashboard, settings, account)
   with standalone accounts: login with Phantom / MetaMask, Google, or the Telegram code; accounts link.

Decisions: revenue share = **40% of fees to $APEX holders only** (pro-rata by holdings, like Banana Gun;
traders are rewarded through cashback instead of the 70/30 split). **$APEX is not launched**: build
everything with the token address configurable in `.env`, never deploy a token. Claims are paid
**automatically from a dedicated rewards wallet** (separate from the treasury, key on the server, keep it
lightly funded).

## Before launch (open items)

- Revoke and replace the bot token (it was pasted in a chat once).
- Use private RPCs (Solana: Helius/QuickNode; EVM: Alchemy/QuickNode/dRPC); the public ones rate-limit.
- Stable: enable once an aggregator supports it (set `kyber` in `src/config/chains.js` or add a router).
- Free API tiers rate-limit (Jupiter lite-api, public Solana RPC, Jito without auth key). With the
  workers polling, get a Jupiter API key (api.jup.ag) and private RPCs before launch.
- Jupiter `/swap/v1` (Metis) is deprecated in favour of Swap V2; migrate before it is switched off.
- Revenue distribution to holders/traders is tracked but **not paid out** yet.
- Run on a VPS 24/7; back up `WALLET_SECRET` and `data/`.
- $APEX supply 1,000,000 (site calculator + `.env`) is a placeholder until the token launches.
- Revenue share counts only $APEX held in ApeX wallets. Wallets linked as logins in ApeX Pro are not
  counted yet (could be added to `snapshotHolders`).
- ApeX Pro needs HTTPS in production (`WEB_PUBLIC_URL=https://…` makes the cookie Secure) and a domain;
  register the Google redirect URI there.
- A security review/audit of the custodial wallet code before real users.
