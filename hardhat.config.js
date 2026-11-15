require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { primaryUrl } = require("./scripts/rpc");

/**
 * Etherscan API V2: a single API key works for ALL supported chains (Ethereum, Sepolia,
 * Base, Polygon, BNB...). That is why `apiKey` is a string. Requires
 * @nomicfoundation/hardhat-verify >= 2.0.8.
 *
 * RPC: by default the first Ankr key is used (see scripts/rpc.js). The full fallback logic
 * (ordered list of Ankr keys) lives in scripts/deploy.js.
 */

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

// Explicit RPC override or the first Ankr URL for a chain.
function rpc(networkName, fallback) {
  return (
    process.env[`${networkName.toUpperCase()}_RPC_URL`] ||
    primaryUrl(networkName) ||
    fallback ||
    ""
  );
}

// Mainnet fork for testing (FORK_URL or the first Ankr eth URL).
const FORK_URL = process.env.FORK_URL || primaryUrl("ethereum");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },

  networks: {
    hardhat: {
      chainId: 31337,
      forking: FORK_URL ? { url: FORK_URL } : undefined,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    sepolia: {
      url: rpc("sepolia", "https://rpc.sepolia.org"),
      accounts,
      chainId: 11155111,
    },
    ethereum: {
      url: rpc("ethereum", "https://eth.llamarpc.com"),
      accounts,
      chainId: 1,
    },
    base: {
      url: rpc("base", "https://mainnet.base.org"),
      accounts,
      chainId: 8453,
    },
    bnb: {
      url: rpc("bnb", "https://bsc-dataseed.binance.org"),
      accounts,
      chainId: 56,
    },
    polygon: {
      url: rpc("polygon", "https://polygon-rpc.com"),
      accounts,
      chainId: 137,
    },
    gembaTestnet: {
      url: rpc("gembaTestnet", "https://rpc1.gembascan.io"),
      accounts,
      chainId: 821207,
    },
    gembaMainnet: {
      url: rpc("gembaMainnet", "https://rpc.gembachain.io"),
      accounts,
      chainId: 821206,
    },
  },

  // Verify: Etherscan V2 (публични вериги) + Blockscout/GembaScan (Gemba).
  etherscan: {
    apiKey: {
      sepolia: process.env.ETHERSCAN_API_KEY || "",
      mainnet: process.env.ETHERSCAN_API_KEY || "",
      gembaTestnet: "blockscout",   // Blockscout не иска истински ключ
      gembaMainnet: "blockscout",
    },
    customChains: [
      { network: "gembaTestnet", chainId: 821207, urls: { apiURL: "https://testnet.gembascan.io/api", browserURL: "https://testnet.gembascan.io" } },
      { network: "gembaMainnet", chainId: 821206, urls: { apiURL: "https://gembascan.io/api", browserURL: "https://gembascan.io" } },
    ],
  },

  sourcify: {
    enabled: false,
  },
};
