# ApeX Launchpad (Robinhood Chain)

pump.fun-style token launches on Robinhood Chain (chain 4663). Anyone creates a token; it trades on a
bonding curve until the curve sells out, then it graduates to Uniswap V2 with the LP tokens burned.
$APEX itself stays on Solana; the launchpad's fees go to the ApeX treasury.

## How it works

- `LaunchToken`: 1,000,000,000 supply, minted once to the launchpad. No owner, mint, tax or blacklist.
  Its Uniswap V2 pair is created in the constructor, and until graduation nobody can send tokens to that
  pair (so no one can open the pool at a fake price first). `burn()` is public.
- `ApeLaunchpad`: one contract holds every curve.
  - Constant product on virtual reserves, starting at 1.5 ETH / 1,073,000,000 tokens (pump.fun's
    ratios scaled to ETH). 793,100,000 tokens are sold on the curve, which raises about **4.25 ETH**.
    Market cap ≈ 1.4 ETH at launch and ≈ 20.5 ETH at graduation.
  - `createToken(name, symbol, metadataURI, minTokensOut, deadline)`: ETH sent above `createFee` is
    the creator's first buy.
  - `buy(token, minTokensOut, deadline)` / `sell(token, amount, minEthOut, deadline)` (sell needs an
    `approve`). `quoteBuy`, `quoteSell`, `price`, `progressBps` for the UI.
  - Graduation happens inside the buy that sells the curve out (the unused ETH is refunded): the graduation
    fee goes to the treasury, then the ETH (as WETH) and enough reserved tokens to match the curve's last
    price go straight into the pair, which mints LP tokens to `0x…dEaD`. Reserved tokens the pool doesn't
    need are burned. Funding the pair directly (instead of through the router) means a pair someone has
    pre-funded with WETH can't block graduation.
  - Fees accrue in the contract; the treasury and creators withdraw with `claimFees()`.
- Defaults: 1% trade fee (treasury), 0% creator fee, 2% graduation fee, no create fee. The owner can
  change them only up to hard caps: 2% trade, 1% creator, 10% graduation, 0.1 ETH create fee.
  `setLaunchParams` only affects new tokens. `setPaused` stops create and buy; **selling is never paused**.
- Events for indexers: `TokenCreated`, `Trade` (with the reserves after the trade), `Graduated`.

Uniswap V2 on Robinhood mainnet (checked on-chain 2026-10-25: router `0x89e5db8b…49eba` → these):
factory `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f`, WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`.

## Commands

```bash
cd contracts/launchpad
npm install
npm test                 # 17 tests against the real Uniswap V2 core
cp .env.example .env     # DEPLOYER_PRIVATE_KEY, EVM_TREASURY_ADDRESS, LAUNCHPAD_OWNER
npm run deploy:testnet   # chain 46630; deploys its own Uniswap V2 + WETH there
npm run deploy:mainnet   # chain 4663; uses Robinhood's Uniswap V2
npx hardhat verify --network hood --constructor-args deployments/hood.args.js <launchpad address>
```

Testnet ETH: the Robinhood Chain faucet (see docs.robinhood.com/chain). Deploy addresses are written to
`deployments/<network>.json`.

Hardhat is pinned to 2.19.5 on purpose: newer versions run a native EDR binary that Windows Smart App
Control blocks on this laptop. Contracts target the Shanghai EVM (supported by Robinhood / Arbitrum Orbit).

## Before mainnet

- External audit (the contract holds user ETH). Run the full flow on the testnet first.
- Owner = a multisig (Safe), not a hot key. The deployer key only needs gas.
- Legal check for the jurisdictions you serve.
- ApeX integration (next phase): index `Trade` / `TokenCreated`, show curve tokens in ApeX Pro and the bot,
  route buys/sells through `buy` / `sell` while not graduated (KyberSwap after), credit launchpad fees to
  the `hood` revenue pool.
