/**
 * Live lifecycle test on Sepolia against the deployed RocketToken.
 *
 * Runs the full anti-bot flow on a real network with real Uniswap V2 and real blocks:
 *   1. metadata + supply
 *   2. guardian views before open
 *   3. add liquidity + setLp (+ once-only revert)
 *   4. buy before open -> reverts
 *   5. executeTrading
 *   6. tier 1: small buy OK, big buy (>1%) reverts (max wallet)
 *   7. sell taxes across tiers (50/40/30%) - burned (asserted against the real block)
 *   8. after block 30: no limit, no tax
 *
 * The deployer is exempt, so a fresh non-exempt trader wallet is generated and funded.
 *
 * Run:
 *   node scripts/sepolia-lifecycle.js          (uses latest deployed/sepolia_*.json)
 *   CONTRACT=0x... node scripts/sepolia-lifecycle.js
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
];
const FACTORY_ABI = ["function getPair(address,address) view returns (address)"];

const DEADLINE = 9999999999n;
const SUPPLY = ethers.parseUnits("100000000000", 18);
const ONE_PERCENT = SUPPLY / 100n;

function expectedSellBps(g) {
  if (g === 0 || g > 30) return 0n;
  if (g <= 10) return 5000n;
  if (g <= 20) return 4000n;
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

function loadAddress() {
  if (process.env.CONTRACT) return process.env.CONTRACT;
  const dir = path.join(__dirname, "..", "deployed");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("sepolia_") && f.endsWith(".json"))
    .sort();
  const info = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1])));
  return info.address;
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

  // ---- 1. metadata + supply ----
  console.log("\n[1] metadata + supply");
  assert((await token.name()) === "Rocket", "name");
  assert((await token.symbol()) === "RCT", "symbol");
  assert((await token.totalSupply()) === SUPPLY, "totalSupply == 100B");
  console.log("   name/symbol/supply OK, 100B minted to deployer");

  // ---- 2. guardian views before open ----
  console.log("\n[2] guardian views before open");
  if (!(await token.tradingOpen())) {
    assert((await token.guardianBlock()) === 0n, "guardianBlock 0");
    assert((await token.currentMaxWallet()) === 0n, "maxWallet 0");
    assert((await token.currentSellTaxBps()) === 0n, "sellTax 0");
    console.log("   tradingOpen=false, all guardian views 0 OK");
  } else {
    console.log("   trading already open (re-run) - skipping pre-open checks");
  }

  // ---- create + fund a non-exempt trader ----
  const trader = ethers.Wallet.createRandom().connect(provider);
  console.log("\n[*] funding trader", trader.address);
  await (await deployer.sendTransaction({ to: trader.address, value: ethers.parseEther("0.5") })).wait();

  // ---- 3. add liquidity + setLp ----
  console.log("\n[3] add liquidity + setLp");
  let pair = await factory.getPair(tokenAddr, WETH);
  if (pair === ethers.ZeroAddress) {
    const tokenLiq = ethers.parseUnits("10000000000", 18); // 10B RCT
    const ethLiq = ethers.parseEther("0.3");
    await (await token.approve(ROUTER, ethers.MaxUint256)).wait();
    await (
      await router.addLiquidityETH(tokenAddr, tokenLiq, 0, 0, deployer.address, DEADLINE, { value: ethLiq })
    ).wait();
    pair = await factory.getPair(tokenAddr, WETH);
    console.log("   liquidity added (10B RCT + 0.3 ETH)");
  } else {
    console.log("   pair already exists");
  }
  console.log("   pair:", pair);
  if ((await token.lpPair()) === ethers.ZeroAddress) {
    await (await token.setLp(pair)).wait();
    await expectRevert(() => token.setLp(pair), "setLp second call (once-only)");
  }
  assert((await token.lpPair()) === pair, "lpPair set");
  console.log("   setLp OK");

  // ---- 4. buy before open reverts ----
  if (!(await token.tradingOpen())) {
    console.log("\n[4] buy before open reverts");
    await expectRevert(
      () =>
        router
          .connect(trader)
          .swapExactETHForTokensSupportingFeeOnTransferTokens(0, [WETH, tokenAddr], trader.address, DEADLINE, {
            value: ethers.parseEther("0.005"),
          }),
      "buy before open"
    );
  }

  // ---- 5. executeTrading ----
  console.log("\n[5] executeTrading");
  if (!(await token.tradingOpen())) {
    await (await token.executeTrading()).wait();
    await expectRevert(() => token.executeTrading(), "executeTrading second call (once-only)");
  }
  const openBlock = Number(await token.tradingOpenBlock());
  assert((await token.tradingOpen()) === true, "tradingOpen true");
  console.log("   trading open at block", openBlock);

  // ---- 6. tier 1: small buy OK, big buy reverts ----
  console.log("\n[6] tier 1 max wallet");
  await (
    await router
      .connect(trader)
      .swapExactETHForTokensSupportingFeeOnTransferTokens(0, [WETH, tokenAddr], trader.address, DEADLINE, {
        value: ethers.parseEther("0.005"),
      })
  ).wait();
  const tbal = await token.balanceOf(trader.address);
  assert(tbal > 0n && tbal <= ONE_PERCENT, "small buy under 1%");
  console.log("   small buy:", ethers.formatUnits(tbal, 18), "RCT (< 1%) OK");
  await expectRevert(
    () =>
      router
        .connect(trader)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(0, [WETH, tokenAddr], trader.address, DEADLINE, {
          value: ethers.parseEther("0.2"),
        }),
    "big buy (>1%) max wallet"
  );

  // ---- 7. sell taxes across tiers ----
  console.log("\n[7] sell taxes across tiers (burned)");
  await (await token.connect(trader).approve(ROUTER, ethers.MaxUint256)).wait();
  const sellAmount = ethers.parseUnits("20000000", 18); // 20M RCT per sell

  async function waitForBlock(target) {
    let bn = await provider.getBlockNumber();
    while (bn < target) {
      process.stdout.write(`   waiting block ${bn} -> ${target}\r`);
      await sleep(6000);
      bn = await provider.getBlockNumber();
    }
    console.log(`   reached block ${bn}            `);
  }

  // tier 1 (now), tier 2 (open+10), tier 3 (open+20)
  for (const tierStart of [openBlock + 1, openBlock + 10, openBlock + 20]) {
    await waitForBlock(tierStart);
    const supplyBefore = await token.totalSupply();
    const burnedBefore = await token.totalTaxBurned();
    const tx = await router
      .connect(trader)
      .swapExactTokensForETHSupportingFeeOnTransferTokens(sellAmount, 0, [tokenAddr, WETH], trader.address, DEADLINE);
    const rec = await tx.wait();
    const g = rec.blockNumber - openBlock + 1;
    const expBurn = (sellAmount * expectedSellBps(g)) / 10000n;
    const burnedNow = (await token.totalTaxBurned()) - burnedBefore;
    const supplyDrop = supplyBefore - (await token.totalSupply());
    assert(burnedNow === expBurn, `burn at guardian block ${g}`);
    assert(supplyDrop === expBurn, `supply drop at guardian block ${g}`);
    console.log(
      `   guardian block ${g}: ${Number(expectedSellBps(g)) / 100}% -> burned ${ethers.formatUnits(expBurn, 18)} RCT`
    );
  }

  // ---- 8. after block 30: no limit, no tax ----
  console.log("\n[8] after block 30 (no limit, no tax)");
  await waitForBlock(openBlock + 30);
  const burnedBefore = await token.totalTaxBurned();
  const tx = await router
    .connect(trader)
    .swapExactTokensForETHSupportingFeeOnTransferTokens(sellAmount, 0, [tokenAddr, WETH], trader.address, DEADLINE);
  const rec = await tx.wait();
  const g = rec.blockNumber - openBlock + 1;
  assert(g > 30, "guardian block > 30");
  assert((await token.totalTaxBurned()) === burnedBefore, "no burn after block 30");
  console.log(`   guardian block ${g}: sell with no tax / no burn OK`);

  // ---- sweep trader leftover ETH back to deployer ----
  try {
    const bal = await provider.getBalance(trader.address);
    const fee = ethers.parseEther("0.001");
    if (bal > fee) {
      await (
        await trader.sendTransaction({ to: deployer.address, value: bal - fee })
      ).wait();
      console.log("\n[*] swept trader leftover ETH back to deployer");
    }
  } catch (_) {}

  console.log("\nALL SEPOLIA LIFECYCLE CHECKS PASSED");
}

main().catch((e) => {
  console.error("\nFAILED:", e.message || e);
  process.exit(1);
});
