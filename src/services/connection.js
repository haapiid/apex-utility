const { Connection } = require('@solana/web3.js');
const { config } = require('../config');

const connection = new Connection(config.chain.rpcUrl, 'confirmed');

module.exports = connection;
