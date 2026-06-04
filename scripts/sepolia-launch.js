const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

/**
 * Sepolia launch: deploys a fresh RocketToken, adds liquidity on Uniswap v2,
 * opens trading, and LEAVES the liquidity in place (no removal).
 *
 *   1. deploy RocketToken (tiers 5/10/15)
 *   2. add liquidity: LIQUIDITY_ETH + 100% of supply (matches the site tokenomics)
 *   3. setLp(pair) -> executeTrading()
 *   4. verify on Etherscan + record under deployed/
 *
 * Run: npx hardhat run scripts/sepolia-launch.js --network sepolia
 */

// Sepolia Uniswap v2 (factory 0xF62c…80E6) + WETH.
const ROUTER = "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3";
const FACTORY = "0xF62c03E08ada871A0bEb309762E260a7a6a880E6";
const WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

const TIERS = [5, 10, 15];
const LIQUIDITY_ETH = "3"; // <-- ETH paired into the pool
const DEADLINE = 9999999999n;

const ROUTER_ABI = [
  "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint, uint, uint)",
];
const FACTORY_ABI = ["function getPair(address,address) view returns (address)"];

async function sendRetry(fn, label, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const tx = await fn();
      return await tx.wait();
    } catch (e) {
      if (i === tries) throw e;
      console.log(`  retry ${label} (${i}/${tries}): ${e.shortMessage || e.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const bal0 = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer:", deployer.address, "| ETH:", ethers.formatEther(bal0));

  // 1. deploy
  const Rocket = await ethers.getContractFactory("RocketToken", deployer);
  const token = await Rocket.deploy(deployer.address, ...TIERS);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  const deployTx = token.deploymentTransaction();
  console.log("Token deployed:", tokenAddr);

  const router = new ethers.Contract(ROUTER, ROUTER_ABI, deployer);
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, ethers.provider);

  // 2. add liquidity (100% of supply + LIQUIDITY_ETH) — BEFORE setLp so it is not
  //    treated as a sell (lpPair is still unset).
  const supply = await token.balanceOf(deployer.address);
  console.log(`Adding liquidity: ${ethers.formatUnits(supply, 18)} RCT + ${LIQUIDITY_ETH} ETH`);
  await sendRetry(() => token.approve(ROUTER, ethers.MaxUint256), "approve");
  await sendRetry(
    () =>
      router.addLiquidityETH(tokenAddr, supply, 0, 0, deployer.address, DEADLINE, {
        value: ethers.parseEther(LIQUIDITY_ETH),
      }),
    "addLiquidity"
  );
  const pair = await factory.getPair(tokenAddr, WETH);
  console.log("LP pair:", pair);

  // 3. setLp + executeTrading
  await sendRetry(() => token.setLp(pair), "setLp");
  await sendRetry(() => token.executeTrading(), "executeTrading");
  console.log("Trading opened at block", Number(await token.tradingOpenBlock()));

  // 4. record
  const now = new Date();
  const stamp = now.toISOString().replace(/:/g, "-").replace(/\..+$/, "");
  const dir = path.join(__dirname, "..", "deployed");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const info = {
    network: "sepolia",
    contract: "RocketToken",
    tokenCA: tokenAddr,
    lpPair: pair,
    liquidityToken_WETH: WETH,
    liquidityEth: LIQUIDITY_ETH,
    liquidityRct: ethers.formatUnits(supply, 18),
    tiers: { tier1: TIERS[0], tier2: TIERS[1], tier3: TIERS[2] },
    deployer: deployer.address,
    txHash: deployTx ? deployTx.hash : null,
    timestamp: now.toISOString(),
    constructorArgs: [deployer.address, ...TIERS],
  };
  fs.writeFileSync(path.join(dir, `sepolia-launch_${stamp}.json`), JSON.stringify(info, null, 2));

  // 5. verify
  console.log("\nWaiting 5 confirmations before verification...");
  if (deployTx) await deployTx.wait(5);
  try {
    await hre.run("verify:verify", { address: tokenAddr, constructorArguments: [deployer.address, ...TIERS] });
    console.log("Verified.");
  } catch (e) {
    const m = (e && e.message) || String(e);
    console.log(m.toLowerCase().includes("already verified") ? "Already verified." : "Verify failed: " + m);
  }

  console.log("\n================= LAUNCH REPORT =================");
  console.log("TOKEN CA              :", tokenAddr);
  console.log("LP CA (RCT/WETH pair) :", pair);
  console.log("LIQUIDITY TOKEN (WETH):", WETH);
  console.log("Liquidity             :", `${ethers.formatUnits(supply, 18)} RCT + ${LIQUIDITY_ETH} ETH`);
  console.log("Explorer              :", `https://sepolia.etherscan.io/address/${tokenAddr}`);
  console.log("================================================");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
