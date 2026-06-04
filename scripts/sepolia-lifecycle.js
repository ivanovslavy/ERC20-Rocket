/**
 * Live lifecycle test on Sepolia, driven entirely by the DEPLOYER wallet.
 *
 * Because there are no exempt/privileged addresses, the deployer is subject to the same
 * guardian rules as everyone else - so the whole flow can be tested through the deployer
 * wallet without creating any throwaway wallet (nothing gets lost), and it directly proves
 * the owner is not privileged.
 *
 *   1. metadata + supply + immutable tiers
 *   2. guardian views before open
 *   3. add liquidity
 *   4. setLp (+ once-only revert)
 *   5. buy before open -> reverts (TradingNotOpen)
 *   6. executeTrading (+ once-only revert)
 *   7. deployer buy during tier 1 -> reverts (MaxWalletExceeded; owner is not exempt)
 *   8. deployer sells across tiers (50/40/30%) - taxes are burned
 *   9. after tier 3: deployer sell has no tax, deployer buy succeeds (no limit)
 *  10. remove liquidity back to the deployer; report ETH balances before/after
 *
 * Run: node scripts/sepolia-lifecycle.js   (uses latest deployed/sepolia_*.json)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { makeProvider } = require("./rpc");
const artifact = require("../artifacts/contracts/RocketToken.sol/RocketToken.json");

const ROUTER = "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3";
const FACTORY = "0xF62c03E08ada871A0bEb309762E260a7a6a880E6";
const WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

const ROUTER_ABI = [
  "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint, uint, uint)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)",
  "function removeLiquidityETH(address token, uint liquidity, uint amountTokenMin, uint amountETHMin, address to, uint deadline) returns (uint, uint)",
];
const FACTORY_ABI = ["function getPair(address,address) view returns (address)"];
const LP_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const DEADLINE = 9999999999n;
const SUPPLY = ethers.parseUnits("100000000000", 18);
const ONE_PERCENT = SUPPLY / 100n;
const TIERS = [5, 10, 15];

function expectedSellBps(g) {
  if (g === 0 || g > TIERS[2]) return 0n;
  if (g <= TIERS[0]) return 5000n;
  if (g <= TIERS[1]) return 4000n;
  return 3000n;
}
function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}
async function expectRevert(fn, label) {
  try {
    const tx = await fn();
    await tx.wait();
  } catch (e) {
    console.log(`   OK reverted: ${label}`);
    return;
  }
  throw new Error("Expected revert but succeeded: " + label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry a live transaction a few times - public Sepolia RPCs occasionally return
// transient execution errors that succeed on a retry.
async function sendRetry(fn, label, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const tx = await fn();
      return await tx.wait();
    } catch (e) {
      if (i === tries) throw e;
      console.log(`   retry ${label} (${i}/${tries}): ${e.shortMessage || e.message}`);
      await sleep(5000);
    }
  }
}

function loadAddress() {
  if (process.env.CONTRACT) return process.env.CONTRACT;
  const dir = path.join(__dirname, "..", "deployed");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("sepolia_") && f.endsWith(".json"))
    .sort();
  return JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]))).address;
}

async function main() {
  const provider = makeProvider("sepolia");
  const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const ADDRESS = loadAddress();

  const token = new ethers.Contract(ADDRESS, artifact.abi, deployer);
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, deployer);
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const tokenAddr = ADDRESS;

  console.log("Contract:", ADDRESS);
  console.log("Deployer:", deployer.address);
  const ethStart = await provider.getBalance(deployer.address);
  console.log("ETH at start:", ethers.formatEther(ethStart));

  async function waitForBlock(target) {
    let bn = await provider.getBlockNumber();
    while (bn < target) {
      process.stdout.write(`   waiting block ${bn} -> ${target}\r`);
      await sleep(6000);
      bn = await provider.getBlockNumber();
    }
    console.log(`   reached block ${bn}            `);
  }

  // ---- 1. metadata + supply + tiers ----
  console.log("\n[1] metadata + supply + tiers");
  assert((await token.name()) === "Rocket", "name");
  assert((await token.symbol()) === "RCT", "symbol");
  assert((await token.totalSupply()) === SUPPLY, "supply 100B");
  assert((await token.balanceOf(deployer.address)) === SUPPLY, "deployer holds 100B");
  assert((await token.tier1Blocks()) === 5n && (await token.tier2Blocks()) === 10n && (await token.tier3Blocks()) === 15n, "tiers 5/10/15");
  console.log("   name/symbol/supply OK; tiers 5/10/15 (immutable)");

  // ---- 2. guardian views before open ----
  console.log("\n[2] guardian views before open");
  assert((await token.guardianBlock()) === 0n, "guardianBlock 0");
  assert((await token.currentMaxWallet()) === 0n, "maxWallet 0");
  assert((await token.currentSellTaxBps()) === 0n, "sellTax 0");
  console.log("   all guardian views 0 OK");

  // ---- 3. add liquidity (while lpPair is unset) ----
  console.log("\n[3] add liquidity");
  let pair = await factory.getPair(tokenAddr, WETH);
  if (pair === ethers.ZeroAddress) {
    const tokenLiq = ethers.parseUnits("5000000000", 18); // 5B RCT
    const ethLiq = ethers.parseEther("0.05");
    await sendRetry(() => token.approve(ROUTER, ethers.MaxUint256), "approve token");
    await sendRetry(
      () => router.addLiquidityETH(tokenAddr, tokenLiq, 0, 0, deployer.address, DEADLINE, { value: ethLiq }),
      "add liquidity"
    );
    pair = await factory.getPair(tokenAddr, WETH);
    console.log("   liquidity added (5B RCT + 0.05 ETH)");
  } else {
    console.log("   pair already exists");
  }
  console.log("   pair:", pair);

  // ---- 4. setLp (+ once-only) ----
  console.log("\n[4] setLp");
  if ((await token.lpPair()) === ethers.ZeroAddress) {
    await (await token.setLp(pair)).wait();
    await expectRevert(() => token.setLp(pair), "setLp second call (once-only)");
  }
  assert((await token.lpPair()) === pair, "lpPair set");
  console.log("   setLp OK");

  // ---- 5. buy before open reverts ----
  if (!(await token.tradingOpen())) {
    console.log("\n[5] buy before open reverts");
    await expectRevert(
      () =>
        router.swapExactETHForTokensSupportingFeeOnTransferTokens(0, [WETH, tokenAddr], deployer.address, DEADLINE, {
          value: ethers.parseEther("0.002"),
        }),
      "buy before open"
    );
  }

  // ---- 6. executeTrading (+ once-only) ----
  console.log("\n[6] executeTrading");
  if (!(await token.tradingOpen())) {
    await (await token.executeTrading()).wait();
    await expectRevert(() => token.executeTrading(), "executeTrading second call (once-only)");
  }
  const openBlock = Number(await token.tradingOpenBlock());
  assert((await token.tradingOpen()) === true, "tradingOpen");
  console.log("   trading open at block", openBlock);

  // ---- 7. deployer buy during tier 1 -> MaxWalletExceeded (owner not exempt) ----
  console.log("\n[7] deployer buy during tier 1 -> MaxWalletExceeded (owner is not exempt)");
  assert((await token.balanceOf(deployer.address)) > ONE_PERCENT, "deployer holds > 1%");
  await expectRevert(
    () =>
      router.swapExactETHForTokensSupportingFeeOnTransferTokens(0, [WETH, tokenAddr], deployer.address, DEADLINE, {
        value: ethers.parseEther("0.002"),
      }),
    "deployer buy over max wallet"
  );

  // ---- 8. deployer sells across tiers (taxes burned) ----
  console.log("\n[8] deployer sells across tiers (taxes burned)");
  await (await token.approve(ROUTER, ethers.MaxUint256)).wait();
  const sellAmount = ethers.parseUnits("20000000", 18); // 20M RCT

  for (const tierStart of [openBlock + 1, openBlock + 6, openBlock + 11]) {
    await waitForBlock(tierStart);
    const supplyBefore = await token.totalSupply();
    const burnedBefore = await token.totalTaxBurned();
    const rec = await sendRetry(
      () =>
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
          sellAmount,
          0,
          [tokenAddr, WETH],
          deployer.address,
          DEADLINE
        ),
      "tier sell"
    );
    const g = rec.blockNumber - openBlock + 1;
    const expBurn = (sellAmount * expectedSellBps(g)) / 10000n;
    const burnedNow = (await token.totalTaxBurned()) - burnedBefore;
    const supplyDrop = supplyBefore - (await token.totalSupply());
    assert(burnedNow === expBurn, `burn at guardian block ${g}`);
    assert(supplyDrop === expBurn, `supply drop at guardian block ${g}`);
    console.log(`   guardian block ${g}: ${Number(expectedSellBps(g)) / 100}% -> burned ${ethers.formatUnits(expBurn, 18)} RCT`);
  }

  // ---- 9. after tier 3: no tax on sell, buy succeeds (no limit) ----
  console.log("\n[9] after tier 3 (no tax, no limit)");
  await waitForBlock(openBlock + 16);
  const burnedBefore = await token.totalTaxBurned();
  const rec = await sendRetry(
    () => router.swapExactTokensForETHSupportingFeeOnTransferTokens(sellAmount, 0, [tokenAddr, WETH], deployer.address, DEADLINE),
    "post-tier3 sell"
  );
  const g = rec.blockNumber - openBlock + 1;
  assert(g > TIERS[2], "past tier3");
  assert((await token.totalTaxBurned()) === burnedBefore, "no burn after tier3");
  console.log(`   guardian block ${g}: sell with no tax / no burn OK`);

  const balBeforeBuy = await token.balanceOf(deployer.address);
  await sendRetry(
    () =>
      router.swapExactETHForTokensSupportingFeeOnTransferTokens(0, [WETH, tokenAddr], deployer.address, DEADLINE, {
        value: ethers.parseEther("0.002"),
      }),
    "post-tier3 buy"
  );
  assert((await token.balanceOf(deployer.address)) > balBeforeBuy, "buy after tier3 succeeds (no limit)");
  console.log("   deployer buy after tier3 succeeds (no max wallet)");

  // ---- 10. remove liquidity back to the deployer ----
  console.log("\n[10] remove liquidity back to deployer");
  const lp = new ethers.Contract(pair, LP_ABI, deployer);
  const lpBal = await lp.balanceOf(deployer.address);
  const ethBeforeRemove = await provider.getBalance(deployer.address);
  if (lpBal > 0n) {
    await sendRetry(() => lp.approve(ROUTER, lpBal), "approve LP");
    await sendRetry(() => router.removeLiquidityETH(tokenAddr, lpBal, 0, 0, deployer.address, DEADLINE), "remove liquidity");
  }
  const ethAfter = await provider.getBalance(deployer.address);
  console.log("   ETH before remove:", ethers.formatEther(ethBeforeRemove));
  console.log("   ETH after remove :", ethers.formatEther(ethAfter));

  // ---- final report ----
  console.log("\n=== FINAL ===");
  console.log("totalSupply  :", ethers.formatUnits(await token.totalSupply(), 18), "RCT");
  console.log("totalTaxBurned:", ethers.formatUnits(await token.totalTaxBurned(), 18), "RCT");
  console.log("deployer RCT :", ethers.formatUnits(await token.balanceOf(deployer.address), 18));
  console.log("deployer ETH :", ethers.formatEther(ethAfter));
  console.log("ETH net (start -> end):", ethers.formatEther(ethAfter - ethStart), "(includes gas + LP round-trip)");
  console.log("\nALL SEPOLIA LIFECYCLE CHECKS PASSED (driven by the deployer wallet)");
}

main().catch((e) => {
  console.error("\nFAILED:", e.message || e);
  process.exit(1);
});
