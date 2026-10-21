const axios = require('axios');
const bs58 = require('bs58').default;
const { config } = require('../config');

// Jito block engine: the transaction goes out as a single-transaction bundle (bundleOnly=true),
// so it never sits in a public queue and is dropped instead of landing if it would revert.
// The transaction must already pay a tip to a Jito tip account (Jupiter adds it via jitoTipLamports).
const api = axios.create({ baseURL: config.jito.url, timeout: 10_000 });

// Without an auth key Jito allows ~1 request per second per IP: retry once on 429
async function sendTransaction(rawTransaction) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendTransaction',
    params: [Buffer.from(rawTransaction).toString('base64'), { encoding: 'base64' }],
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const { data } = await api.post('/api/v1/transactions', body, { params: { bundleOnly: true } });
      if (data.error) throw new Error(`Jito: ${data.error.message || JSON.stringify(data.error)}`);
      return data.result; // transaction signature
    } catch (err) {
      if (err.response?.status === 429 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1100));
        continue;
      }
      throw err;
    }
  }
}

// Signature of a signed transaction without sending it (first signature, base58)
const signatureOf = (tx) => bs58.encode(tx.signatures[0]);

module.exports = { sendTransaction, signatureOf };
