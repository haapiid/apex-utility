// Hardhat 2.19 on purpose: its EVM is plain JavaScript. Newer versions load a native EDR binary that
// Windows Smart App Control blocks on the owner's laptop. Robinhood (Arbitrum Orbit) runs Shanghai code.
require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
require('@nomicfoundation/hardhat-verify');
require('dotenv').config();

const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      { version: '0.8.28', settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai' } },
      { version: '0.5.16', settings: { optimizer: { enabled: true, runs: 999999 } } },
    ],
  },
  networks: {
    hood: {
      chainId: 4663,
      url: process.env.ROBINHOOD_RPC_URL || 'https://robinhood.drpc.org',
      accounts,
    },
    hoodTestnet: {
      chainId: 46630,
      url: process.env.ROBINHOOD_TESTNET_RPC_URL || 'https://robinhood-testnet.drpc.org',
      accounts,
    },
  },
  etherscan: {
    apiKey: { hood: 'blockscout', hoodTestnet: 'blockscout' },
    customChains: [
      {
        network: 'hood',
        chainId: 4663,
        urls: { apiURL: 'https://robinhoodchain.blockscout.com/api', browserURL: 'https://robinhoodchain.blockscout.com' },
      },
      {
        network: 'hoodTestnet',
        chainId: 46630,
        urls: {
          apiURL: 'https://explorer.testnet.chain.robinhood.com/api',
          browserURL: 'https://explorer.testnet.chain.robinhood.com',
        },
      },
    ],
  },
  sourcify: { enabled: false },
};
