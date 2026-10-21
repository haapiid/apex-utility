// Shared by the Solana and EVM trade services

// Errors with a message that is safe to show to the user as-is
class UserError extends Error {}
// The user already has a transaction running; background jobs retry on the next tick
class LockedError extends UserError {}

// One transaction at a time per user (across all chains): prevents double-clicks and racing balances
const locks = new Set();
async function withUserLock(userId, fn) {
  if (locks.has(userId)) throw new LockedError('Another transaction is still in progress. Please wait for it to finish.');
  locks.add(userId);
  try {
    return await fn();
  } finally {
    locks.delete(userId);
  }
}

// Reject if a network call hangs (ethers waits up to 5 minutes by default)
function withTimeout(promise, ms, message = 'Request timed out') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Turn any error into a short, user-friendly message
function friendlyError(err) {
  if (err instanceof UserError) return err.message;
  const msg = String(err?.shortMessage || err?.message || '');
  if (err?.response?.status === 429 || msg.includes('429') || msg.includes('Too Many Requests')) {
    return 'Too many requests right now (rate limited). Please try again in a few seconds.';
  }
  // ethers v6 error codes (EVM chains)
  switch (err?.code) {
    case 'INSUFFICIENT_FUNDS':
      return 'Not enough balance to cover the amount plus gas.';
    case 'CALL_EXCEPTION':
      return 'The transaction reverted on-chain (price moved beyond slippage or the token blocks trading).';
    case 'TIMEOUT':
      return 'The transaction was not confirmed in time. Check the explorer before trying again.';
    case 'NONCE_EXPIRED':
    case 'REPLACEMENT_UNDERPRICED':
      return 'A previous transaction is still pending. Please wait a moment.';
    case 'NETWORK_ERROR':
    case 'SERVER_ERROR':
      return 'The network (RPC) is not responding. Please try again.';
    default:
  }
  if (err?.isAxiosError) return 'The swap service is not responding. Please try again in a moment.';
  if (/timed out/i.test(msg)) return 'The network is not responding. Please try again.';
  if (/insufficient funds for rent/i.test(msg)) return 'The receiving wallet needs at least 0.00089 SOL. Send a larger amount.';
  if (/insufficient (funds|lamports)/i.test(msg)) return 'Not enough balance to cover the amount plus network fees.';
  if (/block height exceeded|expired/i.test(msg)) return 'The transaction expired before it was confirmed. Please try again.';
  if (/simulation failed/i.test(msg)) return 'Transaction simulation failed (the price moved or the token restricts trading). Try again or use a smaller amount.';
  return 'Something went wrong. Please try again.';
}

module.exports = { UserError, LockedError, withUserLock, withTimeout, friendlyError };
