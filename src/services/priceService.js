const { api } = require('./jupiterService');
const { SOL_MINT } = require('../config/solana');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 60_000;
let cache = { price: null, at: 0 };

async function getSolPriceUsd() {
  if (cache.price && Date.now() - cache.at < CACHE_TTL_MS) return cache.price;
  try {
    const { data } = await api.get('/price/v3', { params: { ids: SOL_MINT }, timeout: 5000 });
    cache = { price: data[SOL_MINT].usdPrice, at: Date.now() };
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to fetch SOL price');
  }
  return cache.price; // may be null if it never succeeded
}

module.exports = { getSolPriceUsd };
