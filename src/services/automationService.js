const { db } = require('../db');
const markets = require('./markets');
const walletService = require('./walletService');
const { UserError } = require('./tradeCommon');
const { isSolanaAddress } = require('../config');
const { isEvmAddress } = require('../config/chains');
const { toUnits, fromUnits } = require('../utils/format');

// Data + validation for limit orders, DCA plans, snipes and copy targets. src/workers runs them.

const DAY_MS = 24 * 60 * 60 * 1000;
const ORDER_TTL_MS = 7 * DAY_MS;
const SNIPE_TTL_MS = DAY_MS;
const MAX_OPEN = { orders: 20, dca: 10, snipes: 10, copy: 10 };
const ORDER_TYPES = ['limit_buy', 'take_profit', 'stop_loss'];

const toNum = (raw, decimals) => Number(fromUnits(raw, decimals));

// Price = native coin per whole token, measured with the order's own size so price impact is included
async function sellPrice(chain, token, amountRaw) {
  const value = await markets.serviceFor(chain).quoteValue(token, amountRaw);
  return toNum(value, chain.decimals) / toNum(amountRaw, token.decimals);
}

async function buyPrice(chain, token, nativeRaw) {
  const out = await markets.serviceFor(chain).quoteTokensFor(token, nativeRaw);
  if (out <= 0n) throw new UserError('No trading route found for this token.');
  return toNum(nativeRaw, chain.decimals) / toNum(out, token.decimals);
}

function parseNative(chain, amount) {
  try {
    const raw = toUnits(amount, chain.decimals);
    if (raw <= 0n) throw new Error();
    return raw;
  } catch {
    throw new UserError(`Invalid ${chain.native} amount.`);
  }
}

function parsePercent(value, min, max, label) {
  const n = Number(String(value).replace('%', ''));
  if (!Number.isFinite(n) || n < min || n > max) throw new UserError(`${label} must be between ${min} and ${max}%.`);
  return n;
}

// "30m", "1h", "2d" → seconds (1 minute .. 30 days)
function parseInterval(text) {
  const m = /^(\d+)\s*(m|min|h|d)$/i.exec(String(text).trim());
  if (!m) throw new UserError('Interval looks like 30m, 1h or 1d.');
  const secs = Number(m[1]) * { m: 60, min: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
  if (secs < 60 || secs > 30 * 86400) throw new UserError('Interval must be between 1 minute and 30 days.');
  return secs;
}

function requireWallet(userId, chain) {
  const wallet = walletService.getWallet(userId, chain.kind);
  if (!wallet) throw new UserError(`Create a ${walletService.KIND_LABEL[chain.kind]} wallet first in /wallet.`);
  return wallet;
}

function countOpen(table, userId, statuses) {
  const marks = statuses.map(() => '?').join(',');
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ? AND status IN (${marks})`).get(userId, ...statuses).n;
}

// ---------- Limit orders / take profit / stop loss ----------

/**
 * limit_buy:   amount = native to spend, movePct = buy when the price is this % lower
 * take_profit: amount = % of the bag to sell, movePct = sell when the price is this % higher
 * stop_loss:   amount = % of the bag to sell, movePct = sell when the price is this % lower
 */
async function createOrder(userId, chain, address, type, amount, movePct) {
  if (!ORDER_TYPES.includes(type)) throw new UserError('Unknown order type.');
  if (countOpen('orders', userId, ['open']) >= MAX_OPEN.orders) throw new UserError(`You can have up to ${MAX_OPEN.orders} open orders.`);
  const wallet = requireWallet(userId, chain);
  const token = await markets.serviceFor(chain).getTokenInfo(address, wallet.address);

  let price;
  let trigger;
  let storedAmount;
  if (type === 'limit_buy') {
    const move = parsePercent(movePct, 1, 99, 'The price drop');
    const raw = parseNative(chain, amount);
    storedAmount = String(amount).trim();
    price = await buyPrice(chain, token, raw);
    trigger = price * (1 - move / 100);
  } else {
    const share = parsePercent(amount, 1, 100, 'The share of your bag');
    const move = type === 'take_profit' ? parsePercent(movePct, 1, 10_000, 'The price rise') : parsePercent(movePct, 1, 99, 'The price drop');
    const raw = (token.balance * BigInt(Math.round(share))) / 100n;
    if (raw <= 0n) throw new UserError(`You don’t hold any ${token.symbol} in your active wallet.`);
    storedAmount = String(Math.round(share));
    price = await sellPrice(chain, token, raw);
    trigger = type === 'take_profit' ? price * (1 + move / 100) : price * (1 - move / 100);
  }

  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO orders (user_id, chain, token, symbol, type, amount, ref_price, trigger_price, last_price, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, chain.key, token.address, token.symbol, type, storedAmount, price, trigger, price, now + ORDER_TTL_MS, now, now);
  return getOrder(userId, Number(lastInsertRowid));
}

const getOrder = (userId, id) => db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, userId) || null;
const listOrders = (userId) => db.prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'open' ORDER BY id").all(userId);
const openOrders = () => db.prepare("SELECT * FROM orders WHERE status = 'open' ORDER BY id").all();

function updateOrder(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    Date.now(),
    id,
  );
}

function cancelOrder(userId, id) {
  return db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'open'").run(Date.now(), id, userId)
    .changes > 0;
}

// ---------- DCA ----------

/**
 * buy:  amount = native per run
 * sell: amount = % of the current bag to sell in total, split evenly over the runs
 */
async function createDca(userId, chain, address, side, amount, runs, interval) {
  if (!['buy', 'sell'].includes(side)) throw new UserError('Side must be buy or sell.');
  if (countOpen('dca_plans', userId, ['open']) >= MAX_OPEN.dca) throw new UserError(`You can have up to ${MAX_OPEN.dca} DCA plans.`);
  const runsTotal = Number(runs);
  if (!Number.isInteger(runsTotal) || runsTotal < 2 || runsTotal > 100) throw new UserError('Runs must be a whole number from 2 to 100.');
  const intervalSec = parseInterval(interval);
  const wallet = requireWallet(userId, chain);
  const token = await markets.serviceFor(chain).getTokenInfo(address, wallet.address);

  let perRun;
  if (side === 'buy') {
    parseNative(chain, amount);
    perRun = String(amount).trim();
  } else {
    const share = parsePercent(amount, 1, 100, 'The share of your bag');
    const total = (token.balance * BigInt(Math.round(share))) / 100n;
    if (total <= 0n) throw new UserError(`You don’t hold any ${token.symbol} in your active wallet.`);
    perRun = (total / BigInt(runsTotal)).toString();
    if (perRun === '0') throw new UserError('That amount is too small to split into so many runs.');
  }

  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO dca_plans (user_id, chain, token, symbol, side, amount, runs_total, interval_sec, next_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, chain.key, token.address, token.symbol, side, perRun, runsTotal, intervalSec, now, now, now);
  return { plan: getDca(userId, Number(lastInsertRowid)), token };
}

const getDca = (userId, id) => db.prepare('SELECT * FROM dca_plans WHERE id = ? AND user_id = ?').get(id, userId) || null;
const listDca = (userId) => db.prepare("SELECT * FROM dca_plans WHERE user_id = ? AND status = 'open' ORDER BY id").all(userId);
const dueDca = () => db.prepare("SELECT * FROM dca_plans WHERE status = 'open' AND next_at <= ? ORDER BY next_at").all(Date.now());

function updateDca(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE dca_plans SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    Date.now(),
    id,
  );
}

const cancelDca = (userId, id) =>
  db.prepare("UPDATE dca_plans SET status = 'cancelled', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'open'").run(Date.now(), id, userId)
    .changes > 0;

// ---------- Snipes ----------

// The token may not exist or have liquidity yet: the sniper buys as soon as a route appears
function createSnipe(userId, chain, address, amount, safety = true) {
  if (chain.kind === 'sol' ? !isSolanaAddress(address) : !isEvmAddress(address)) throw new UserError(`That is not a ${chain.name} token address.`);
  if (countOpen('snipes', userId, ['waiting']) >= MAX_OPEN.snipes) throw new UserError(`You can have up to ${MAX_OPEN.snipes} active snipes.`);
  requireWallet(userId, chain);
  parseNative(chain, amount);
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO snipes (user_id, chain, token, amount, safety, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, chain.key, address, String(amount).trim(), safety ? 1 : 0, now + SNIPE_TTL_MS, now, now);
  return db.prepare('SELECT * FROM snipes WHERE id = ?').get(Number(lastInsertRowid));
}

const listSnipes = (userId) => db.prepare("SELECT * FROM snipes WHERE user_id = ? AND status = 'waiting' ORDER BY id").all(userId);
const waitingSnipes = () => db.prepare("SELECT * FROM snipes WHERE status = 'waiting' ORDER BY id").all();

function updateSnipe(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE snipes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    Date.now(),
    id,
  );
}

const cancelSnipe = (userId, id) =>
  db.prepare("UPDATE snipes SET status = 'cancelled', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'waiting'").run(Date.now(), id, userId)
    .changes > 0;

// ---------- Copy trading ----------

function addCopyTarget(userId, chain, address, buyAmount) {
  if (chain.kind === 'sol' ? !isSolanaAddress(address) : !isEvmAddress(address)) throw new UserError(`That is not a ${chain.name} wallet address.`);
  const count = db.prepare('SELECT COUNT(*) AS n FROM copy_targets WHERE user_id = ?').get(userId).n;
  if (count >= MAX_OPEN.copy) throw new UserError(`You can follow up to ${MAX_OPEN.copy} wallets.`);
  requireWallet(userId, chain);
  parseNative(chain, buyAmount);
  const own = walletService.listWallets(userId, chain.kind).some((w) => w.address.toLowerCase() === address.toLowerCase());
  if (own) throw new UserError('That is one of your own wallets.');
  const stored = chain.kind === 'evm' ? address.toLowerCase() : address;
  try {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO copy_targets (user_id, chain, address, label, buy_amount, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, chain.key, stored, `${address.slice(0, 4)}…${address.slice(-4)}`, String(buyAmount).trim(), Date.now());
    return db.prepare('SELECT * FROM copy_targets WHERE id = ?').get(Number(lastInsertRowid));
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw new UserError('You already follow that wallet on this chain.');
    throw err;
  }
}

const listCopyTargets = (userId) => db.prepare('SELECT * FROM copy_targets WHERE user_id = ? ORDER BY id').all(userId);
const activeCopyTargets = () => db.prepare('SELECT * FROM copy_targets WHERE active = 1 ORDER BY id').all();
const getCopyTarget = (userId, id) => db.prepare('SELECT * FROM copy_targets WHERE id = ? AND user_id = ?').get(id, userId) || null;
const setCopyCursor = (id, cursor) => db.prepare('UPDATE copy_targets SET cursor = ? WHERE id = ?').run(String(cursor), id);

function updateCopyTarget(userId, id, fields) {
  const keys = Object.keys(fields);
  return (
    db
      .prepare(`UPDATE copy_targets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...keys.map((k) => fields[k]), id, userId).changes > 0
  );
}

const removeCopyTarget = (userId, id) => db.prepare('DELETE FROM copy_targets WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;

module.exports = {
  ORDER_TYPES,
  sellPrice,
  buyPrice,
  parseInterval,
  createOrder,
  getOrder,
  listOrders,
  openOrders,
  updateOrder,
  cancelOrder,
  createDca,
  listDca,
  dueDca,
  updateDca,
  cancelDca,
  createSnipe,
  listSnipes,
  waitingSnipes,
  updateSnipe,
  cancelSnipe,
  addCopyTarget,
  listCopyTargets,
  activeCopyTargets,
  getCopyTarget,
  setCopyCursor,
  updateCopyTarget,
  removeCopyTarget,
};
