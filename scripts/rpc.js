/**
 * RPC fallback logic using Ankr API keys.
 *
 * Reads ANKR_API_KEYS from .env (comma-separated). For each chain it builds a list of
 * RPC URLs - one per key. If the first RPC fails, the ethers FallbackProvider moves to
 * the next one automatically (quorum = 1).
 *
 * An optional explicit RPC (<NETWORK>_RPC_URL) is given the highest priority.
 */
const { ethers } = require("ethers");

const ANKR_KEYS = (process.env.ANKR_API_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// network name -> Ankr path + chainId
const NETWORKS = {
  ethereum: { path: "eth", chainId: 1 },
  sepolia: { path: "eth_sepolia", chainId: 11155111 },
  base: { path: "base", chainId: 8453 },
  bnb: { path: "bsc", chainId: 56 },
  polygon: { path: "polygon", chainId: 137 },
};

/** Returns the array of Ankr RPC URLs for a chain (one per key). */
function ankrUrls(networkName) {
  const cfg = NETWORKS[networkName];
  if (!cfg) return [];
  return ANKR_KEYS.map((key) => `https://rpc.ankr.com/${cfg.path}/${key}`);
}

/** Returns the first Ankr URL for a chain (used by hardhat.config / verify). */
function primaryUrl(networkName) {
  const urls = ankrUrls(networkName);
  return urls.length ? urls[0] : "";
}

/** Creates a FallbackProvider with priority following the order of the keys. */
function makeProvider(networkName) {
  const cfg = NETWORKS[networkName];
  if (!cfg) throw new Error(`Unknown network: ${networkName}`);

  const urls = [];
  const envUrl = process.env[`${networkName.toUpperCase()}_RPC_URL`];
  if (envUrl) urls.push(envUrl);
  urls.push(...ankrUrls(networkName));

  if (urls.length === 0) {
    throw new Error(
      `No RPC for ${networkName}. Set ANKR_API_KEYS or ${networkName.toUpperCase()}_RPC_URL in .env`
    );
  }

  const configs = urls.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, cfg.chainId),
    priority: i + 1, // lower = higher priority
    stallTimeout: 2500,
    weight: 1,
  }));

  // quorum 1 -> a single successful response is enough; on error it falls down by priority
  return new ethers.FallbackProvider(configs, cfg.chainId, { quorum: 1 });
}

/** Wallet signer connected to the fallback provider. */
function makeSigner(networkName) {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY missing in .env");
  return new ethers.Wallet(pk, makeProvider(networkName));
}

module.exports = { NETWORKS, ankrUrls, primaryUrl, makeProvider, makeSigner };
