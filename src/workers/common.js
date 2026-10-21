const { LockedError, UserError, friendlyError } = require('../services/tradeCommon');
const { escapeHtml } = require('../utils/format');

// Outcome of an automated trade attempt, so each worker can decide: done, retry later, or count a failure
//   'ok'      the trade went through
//   'busy'    the user has another transaction running: try again next tick, don't count it
//   'user'    a known problem (no balance, no route, ...): count it as a failed attempt
//   'error'   unexpected (network, RPC): also counted, logged by the caller
async function attempt(fn) {
  try {
    return { status: 'ok', result: await fn() };
  } catch (err) {
    if (err instanceof LockedError) return { status: 'busy', err };
    return { status: err instanceof UserError ? 'user' : 'error', err, message: friendlyError(err) };
  }
}

const MAX_ATTEMPTS = 3;
const esc = escapeHtml;

module.exports = { attempt, MAX_ATTEMPTS, esc };
