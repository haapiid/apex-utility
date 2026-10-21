const axios = require('axios');
const logger = require('../utils/logger');

// Token safety scan via GoPlus (free public API) plus on-chain checks we can do ourselves.
// Result: { issues: [...], warnings: [...], source, unknown }
//   issues   → reasons not to trade (sniper skips the token when its safety filter is on)
//   unknown  → no scanner data (brand-new token or unsupported chain); only on-chain checks ran
const api = axios.create({ baseURL: 'https://api.gopluslabs.io/api/v1', timeout: 5_000 });

// GoPlus chain ids; HyperEVM and MegaETH aren't covered yet
const GOPLUS_CHAIN = { eth: '1', bsc: '56', base: '8453', hood: '4663' };
const MAX_TAX = 0.1; // 10%

const CACHE_MS = 10 * 60_000;
const cache = new Map();

const pct = (fraction) => `${Math.round(Number(fraction) * 1000) / 10}%`;
const flag = (v) => v === '1' || v === 1;

function evmFindings(r) {
  const issues = [];
  const warnings = [];
  if (flag(r.is_honeypot)) issues.push('Honeypot: tokens can’t be sold');
  if (flag(r.cannot_sell_all)) issues.push('You can’t sell your whole balance');
  if (Number(r.sell_tax) > MAX_TAX) issues.push(`Sell tax ${pct(r.sell_tax)}`);
  if (Number(r.buy_tax) > MAX_TAX) issues.push(`Buy tax ${pct(r.buy_tax)}`);
  if (flag(r.owner_change_balance)) issues.push('Owner can change balances');
  if (flag(r.is_blacklisted)) warnings.push('Has a blacklist');
  if (flag(r.transfer_pausable)) warnings.push('Transfers can be paused');
  if (flag(r.slippage_modifiable)) warnings.push('Owner can change taxes');
  if (flag(r.is_mintable)) warnings.push('Supply can be minted');
  if (flag(r.hidden_owner)) warnings.push('Hidden owner');
  if (r.is_open_source === '0') warnings.push('Contract source not verified');
  if (Number(r.sell_tax) > 0 && Number(r.sell_tax) <= MAX_TAX) warnings.push(`Sell tax ${pct(r.sell_tax)}`);
  return { issues, warnings };
}

function solanaFindings(r) {
  const issues = [];
  const warnings = [];
  // Big established tokens (USDC, ...) keep authorities on purpose; GoPlus marks them trusted
  if (r.trusted_token === 1 || r.trusted_token === '1') return { issues, warnings, trusted: true };
  if (r.balance_mutable_authority?.status === '1') issues.push('Authority can change balances');
  if (flag(r.non_transferable)) issues.push('Token is non-transferable');
  const feeRate = Number(r.transfer_fee?.current_fee_rate?.fee_rate || 0) / 10_000;
  if (feeRate > MAX_TAX) issues.push(`Transfer fee ${pct(feeRate)}`);
  if (r.transfer_hook?.length) warnings.push('Has a transfer hook');
  if (r.metadata_mutable?.status === '1') warnings.push('Metadata can be changed');
  return { issues, warnings };
}

async function goplus(chain, address) {
  try {
    if (chain.kind === 'sol') {
      const { data } = await api.get('/solana/token_security', { params: { contract_addresses: address } });
      const r = data.result?.[address];
      return r && Object.keys(r).length ? solanaFindings(r) : null;
    }
    const id = GOPLUS_CHAIN[chain.key];
    if (!id) return null;
    const { data } = await api.get(`/token_security/${id}`, { params: { contract_addresses: address } });
    const r = data.result?.[address.toLowerCase()];
    return r && Object.keys(r).length ? evmFindings(r) : null;
  } catch (err) {
    logger.debug({ err: err.message, chain: chain.key }, 'GoPlus scan failed');
    return null;
  }
}

/**
 * token: from the chain's getTokenInfo (Solana tokens carry mint/freeze authority).
 * canSell: optional async () => boolean, a sell-route check used when no scanner covers the chain.
 */
async function scan(chain, token, { canSell } = {}) {
  const key = `${chain.key}:${token.address}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.result;

  const found = await goplus(chain, token.address);
  const result = { issues: [], warnings: [], source: found ? 'GoPlus' : 'on-chain', unknown: !found };
  if (found) {
    result.issues.push(...found.issues);
    result.warnings.push(...found.warnings);
  }
  if (chain.kind === 'sol' && !found?.trusted) {
    if (token.freezeAuthority) result.issues.push('Freeze authority active: your tokens can be frozen');
    if (token.mintAuthority) result.warnings.push('Mint authority active: supply can grow');
  }
  if (!found && chain.kind === 'evm' && canSell && !(await canSell().catch(() => false))) {
    result.issues.push('No sell route found');
  }
  cache.set(key, { result, at: Date.now() });
  return result;
}

// One line for the token card
function summary(result) {
  if (result.issues.length) return `⚠️ <b>Risk:</b> ${result.issues.join(' • ')}`;
  const base = result.unknown ? '🛡️ No scanner data yet' : '🛡️ Safety scan: no red flags';
  return result.warnings.length ? `${base} (note: ${result.warnings.join(', ')})` : base;
}

module.exports = { scan, summary };
