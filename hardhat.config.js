require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { primaryUrl } = require("./scripts/rpc");

/**
 * Etherscan API V2: edin edinstven API klyuch raboti za VSICHKI podardjani
 * verigi (Ethereum, Sepolia, Base, Polygon, BNB...). Zatova `apiKey` e string.
 * Iziskva @nomicfoundation/hardhat-verify >= 2.0.8.
 *
 * RPC: po podrazbiranie se polzva purviat Ankr klyuch (vij scripts/rpc.js).
 * Pulnata fallback logika (red ot Ankr klyuchove) e v scripts/deploy.js.
 */

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

// Vanshen RPC override ili purviat Ankr URL za dadena veriga.
function rpc(networkName, fallback) {
  return (
    process.env[`${networkName.toUpperCase()}_RPC_URL`] ||
    primaryUrl(networkName) ||
    fallback ||
    ""
  );
}

// Mainnet fork za testvane (FORK_URL ili purviat Ankr eth).
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
  },

  // Etherscan API V2 - edin klyuch za vsichki verigi.
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },

  sourcify: {
    enabled: false,
  },
};
