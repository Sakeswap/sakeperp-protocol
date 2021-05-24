'use strict';

var HDWalletProvider = require("@truffle/hdwallet-provider")
require('dotenv-flow').config();

const isCoverage = process.env.COVERAGE === 'true'

module.exports = {
  networks: {
    // development: {
    //   host: 'localhost',
    //   port: 8545,
    //   gas: 12000000,
    //   gasPrice: 1 * 1000000000,
    //   network_id: '5777'
    // },

    local: {
      host: '127.0.0.1',
      port: 8545,
      gas: 6721975,
      gasPrice: 100 * 1000000000,
      network_id: '*'
    },

    rinkeby: {
      provider: () => new HDWalletProvider(
        process.env.HDWALLET_MNEMONIC,
        process.env.RINKEBY_RPC_URL
      ),
      skipDryRun: true,
      network_id: 4,
      gas: 10000000,
      gasPrice: 3 * 1000000000,
      networkCheckTimeout: 1000000000,
      timeoutBlocks: 1000,
      websockets: true,
      confirmations: 1
    },

    mainnet: {
      provider: () => new HDWalletProvider(
        process.env.HDWALLET_MNEMONIC,
        process.env.MAINNET_RPC_URL
      ),
      skipDryRun: true,
      network_id: 1,
      gas: 7000000,
      gasPrice: 3.01 * 1000000000
    },

    kovan: {
      provider: () => new HDWalletProvider(
        process.env.HDWALLET_MNEMONIC,
        process.env.KOVAN_RPC_URL
      ),
      skipDryRun: true,
      network_id: 42,
      gas: 10000000,
      gasPrice: 3 * 1000000000,
      networkCheckTimeout: 1000000000,
      timeoutBlocks: 1000,
      websockets: true,
      confirmations: 1
    },

    bsc_test: {
      provider: () => new HDWalletProvider(
        process.env.HDWALLET_MNEMONIC,
        process.env.BSC_TESTNET_RPC_URL
      ),
      skipDryRun: true,
      network_id: 97,
      gas: 10000000,
      gasPrice: 10000000000,
      networkCheckTimeout: 1000000000,
      timeoutBlocks: 1000,
      websockets: true
    },

    bsc: {
      provider: () => new HDWalletProvider(
        process.env.HDWALLET_MNEMONIC,
        process.env.BSC_MAINNET_RPC_URL
      ),
      skipDryRun: true,
      network_id: 56,
      gas: 10000000,
      gasPrice: 5000000000,
      networkCheckTimeout: 1000000000,
      timeoutBlocks: 1000,
      websockets: true
    },

    heco_test: {
      provider: () => new HDWalletProvider(
        process.env.HDWALLET_MNEMONIC,
        process.env.HECO_TESTNET_RPC_URL
      ),
      skipDryRun: true,
      network_id: 256,
      gas: 8000000,
      gasPrice: 10000000000,
      networkCheckTimeout: 1000000000,
      timeoutBlocks: 1000,
      websockets: true
    },

    heco: {
      provider: () => new HDWalletProvider(
        process.env.HDWALLET_MNEMONIC,
        process.env.HECO_MAINNET_RPC_URL
      ),
      skipDryRun: true,
      network_id: 128,
      gas: 8000000,
      gasPrice: 10000000000,
      networkCheckTimeout: 1000000000,
      timeoutBlocks: 1000,
      websockets: true
    },
  },

  plugins: [
    "solidity-coverage",
    "truffle-plugin-verify",
    "truffle-contract-size"
  ],

  api_keys: {
    etherscan: process.env.ETHERSCAN_APIKEY,
    bscscan: process.env.BSCSCAN_APIKEY,
    hecoscan: process.env.HECOSCAN_APIKEY
  },

  compilers: {
    solc: {
      version: "0.6.12",
      // docker: true,
      settings: {
        evmVersion: 'constantinpole'
      }
    }
  },

  // optimization breaks code coverage
  solc: {
    optimizer: {
      // enabled: !isCoverage,
      enabled: true,
      runs: 200
    }
  },

  mocha: isCoverage ? {
    reporter: 'mocha-junit-reporter',
  } : {
      reporter: 'eth-gas-reporter',
      reporterOptions: {
        currency: 'USD',
        gasPrice: 200
      }
    }
};