const { LAMPORTS_PER_SOL } = require('../config/solana');

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

function formatUsd(value) {
  return usdFormatter.format(Number(value) || 0);
}

const compactUsdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2,
});

// Large amounts like market cap: $271.4M
function formatCompactUsd(value) {
  return compactUsdFormatter.format(Number(value) || 0);
}

// Token prices: memecoins can be fractions of a cent, so keep ~4 significant digits
function formatPrice(value) {
  const n = Number(value) || 0;
  if (n >= 1 || n === 0) return formatUsd(n);
  const decimals = Math.min(12, 3 - Math.floor(Math.log10(n)));
  return `$${n.toFixed(decimals)}`;
}

function formatNumber(value, maxDecimals = 4) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: maxDecimals }).format(Number(value) || 0);
}

function formatToken(value, symbol, maxDecimals = 6) {
  return `${formatNumber(value, maxDecimals)} ${symbol}`;
}

// Raw integer amount (bigint) → decimal string, without losing precision
function fromUnits(raw, decimals) {
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

// Decimal string → raw integer amount (bigint); throws on invalid input
function toUnits(amount, decimals) {
  const text = String(amount).trim();
  if (!/^\d*\.?\d+$/.test(text)) throw new Error('Invalid amount');
  const [whole, frac = ''] = text.split('.');
  if (frac.length > decimals) throw new Error('Too many decimals');
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

const lamportsToSol = (lamports) => fromUnits(lamports, 9);
const solToLamports = (sol) => toUnits(sol, 9);
const formatSol = (lamports, maxDecimals = 6) => `${formatNumber(lamportsToSol(lamports), maxDecimals)} SOL`;
// Native coin of any chain (SOL, ETH, BNB, HYPE, ...) from its raw amount
const formatNative = (raw, chain, maxDecimals = 6) =>
  `${formatNumber(fromUnits(raw, chain.decimals), maxDecimals)} ${chain.native}`;

function shortAddress(address, chars = 4) {
  if (!address) return '-';
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function bpsToPercent(bps) {
  return `${formatNumber(bps / 100, 2)}%`;
}

module.exports = {
  formatUsd,
  formatPrice,
  formatCompactUsd,
  formatNumber,
  formatToken,
  fromUnits,
  toUnits,
  lamportsToSol,
  solToLamports,
  formatSol,
  formatNative,
  LAMPORTS_PER_SOL,
  shortAddress,
  escapeHtml,
  bpsToPercent,
};
