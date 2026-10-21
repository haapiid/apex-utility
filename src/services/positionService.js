const { db } = require('../db');

// Average-cost bookkeeping per wallet + chain + token, in raw units (bigint as text).
//   buy:  amount += tokens received, cost += native spent
//   sell: the sold share of cost is removed; realized += native received - that cost

const toPosition = (row) =>
  row && {
    walletId: row.wallet_id,
    chain: row.chain,
    token: row.token,
    symbol: row.symbol,
    decimals: row.decimals,
    amount: BigInt(row.amount),
    cost: BigInt(row.cost),
    realized: BigInt(row.realized),
    updatedAt: row.updated_at,
  };

function get(walletId, chain, token) {
  return toPosition(db.prepare('SELECT * FROM positions WHERE wallet_id = ? AND chain = ? AND token = ?').get(walletId, chain, token));
}

function save(p) {
  db.prepare(
    `INSERT INTO positions (wallet_id, chain, token, symbol, decimals, amount, cost, realized, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (wallet_id, chain, token) DO UPDATE SET
       symbol = excluded.symbol, amount = excluded.amount, cost = excluded.cost,
       realized = excluded.realized, updated_at = excluded.updated_at`,
  ).run(p.walletId, p.chain, p.token, p.symbol, p.decimals, p.amount.toString(), p.cost.toString(), p.realized.toString(), Date.now());
}

function recordBuy({ walletId, chain, token, symbol, decimals, tokenAmount, nativeSpent }) {
  if (tokenAmount <= 0n) return;
  const p = get(walletId, chain, token) || { walletId, chain, token, symbol, decimals, amount: 0n, cost: 0n, realized: 0n };
  save({ ...p, symbol, decimals, amount: p.amount + tokenAmount, cost: p.cost + nativeSpent });
}

function recordSell({ walletId, chain, token, symbol, decimals, tokenAmount, nativeReceived }) {
  const p = get(walletId, chain, token);
  if (!p) {
    // Tokens bought outside ApeX: no cost basis, the whole amount received counts as realized
    save({ walletId, chain, token, symbol, decimals, amount: 0n, cost: 0n, realized: nativeReceived });
    return;
  }
  const sold = tokenAmount > p.amount ? p.amount : tokenAmount;
  const costSold = p.amount > 0n ? (p.cost * sold) / p.amount : 0n;
  save({ ...p, amount: p.amount - sold, cost: p.cost - costSold, realized: p.realized + nativeReceived - costSold });
}

// Open positions (still holding tokens) of a wallet
function listOpen(walletId) {
  return db
    .prepare("SELECT * FROM positions WHERE wallet_id = ? AND amount != '0' ORDER BY updated_at DESC")
    .all(walletId)
    .map(toPosition);
}

module.exports = { get, recordBuy, recordSell, listOpen };
