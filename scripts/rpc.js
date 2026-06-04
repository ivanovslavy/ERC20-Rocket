/**
 * RPC fallback logika s Ankr API klyuchove.
 *
 * Chete ANKR_API_KEYS ot .env (zapeti-razdeleni). Za vsjaka veriga gradi spisak
 * ot RPC URL-i - po edin za vseki klyuch. Ako purviat RPC feilne, ethers
 * FallbackProvider avtomatichno minava na sledvashtia (quorum = 1).
 *
 * Optsionalen vanshen RPC (<NETWORK>_RPC_URL) se slaga s nai-visok prioritet.
 */
const { ethers } = require("ethers");

const ANKR_KEYS = (process.env.ANKR_API_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// network ime -> Ankr path + chainId
const NETWORKS = {
  ethereum: { path: "eth", chainId: 1 },
  sepolia: { path: "eth_sepolia", chainId: 11155111 },
  base: { path: "base", chainId: 8453 },
  bnb: { path: "bsc", chainId: 56 },
  polygon: { path: "polygon", chainId: 137 },
};

/** Vrashta masiv ot Ankr RPC URL-i za dadena veriga (po edin za vseki klyuch). */
function ankrUrls(networkName) {
  const cfg = NETWORKS[networkName];
  if (!cfg) return [];
  return ANKR_KEYS.map((key) => `https://rpc.ankr.com/${cfg.path}/${key}`);
}

/** Vrashta purvia Ankr URL za veriga (za hardhat.config / verify). */
function primaryUrl(networkName) {
  const urls = ankrUrls(networkName);
  return urls.length ? urls[0] : "";
}

/** Suzdava FallbackProvider s prioritet po reda na klyuchovete. */
function makeProvider(networkName) {
  const cfg = NETWORKS[networkName];
  if (!cfg) throw new Error(`Nepoznata mreja: ${networkName}`);

  const urls = [];
  const envUrl = process.env[`${networkName.toUpperCase()}_RPC_URL`];
  if (envUrl) urls.push(envUrl);
  urls.push(...ankrUrls(networkName));

  if (urls.length === 0) {
    throw new Error(
      `Nyama RPC za ${networkName}. Zaredi ANKR_API_KEYS ili ${networkName.toUpperCase()}_RPC_URL v .env`
    );
  }

  const configs = urls.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, cfg.chainId),
    priority: i + 1, // po-malko = po-visok prioritet
    stallTimeout: 2500,
    weight: 1,
  }));

  // quorum 1 -> stiga edin uspeshen otgovor; pri greshka minava nadolu po prioritet
  return new ethers.FallbackProvider(configs, cfg.chainId, { quorum: 1 });
}

/** Wallet signer, svurzan kam fallback provider-a. */
function makeSigner(networkName) {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY lipsva v .env");
  return new ethers.Wallet(pk, makeProvider(networkName));
}

module.exports = { NETWORKS, ankrUrls, primaryUrl, makeProvider, makeSigner };
