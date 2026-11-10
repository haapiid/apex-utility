const markets = require('./markets');
const accountService = require('./accountService');
const { getMeta, setMeta } = require('../db');
const { config } = require('../config');
const { getChain, addressLink } = require('../config/chains');

// The official $APEX contract address shown on the landing page and in ApeX Pro, set by an admin from
// ApeX Pro after launch. Display only: revenue share, cashback and burns stay off until the server's
// APEX_TOKEN_ADDRESS is set (rewardsService.apexToken), because those move real funds.

const KEY = 'official_token';

function get() {
  const raw = getMeta(KEY);
  if (!raw) return null;
  const t = JSON.parse(raw);
  const chain = getChain(t.chain);
  return chain ? { ...t, chainName: chain.name, explorer: addressLink(chain, t.address) } : null;
}

// Telegram admins (ADMIN_IDS) or a web login with a wallet listed in APEX_ADMIN_WALLETS
function isAdmin(userId) {
  if (!userId) return false;
  if (config.adminIds.includes(userId)) return true;
  const wallets = config.apex.adminWallets;
  if (!wallets.length) return false;
  return accountService
    .identities(userId)
    .list.some((i) => (i.provider === 'evm' && wallets.includes(i.subject.toLowerCase())) || (i.provider === 'sol' && wallets.includes(i.subject)));
}

// Checked on-chain first (the trade services refuse anything that is not a token), so a typo never goes live
async function set(chain, address) {
  const token = await markets.serviceFor(chain).getTokenInfo(address);
  const value = { chain: chain.key, address: token.address, name: String(token.name || '').slice(0, 64), symbol: String(token.symbol || '').slice(0, 24), setAt: Date.now() };
  setMeta(KEY, JSON.stringify(value));
  return get();
}

function clear() {
  setMeta(KEY, '');
}

module.exports = { get, isAdmin, set, clear };
