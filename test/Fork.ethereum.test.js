/**
 * Ethereum mainnet fork test.
 *
 * Forks mainnet (real Uniswap V2 + WETH) and runs the whole lifecycle without spending real
 * funds:
 *   1. deploy
 *   2. set LP (creates the RCT/WETH pair + adds liquidity)
 *   3. buy BEFORE trading is open -> must revert
 *   4. open trading
 *   5. buy (max wallet limit in tier 1)
 *   6. sell taxes (50/40/30%) - the collected tax is BURNED
 *   7. after tier 3 - no limit and no tax (normal)
 *
 * Run:
 *   FORK_URL=<eth rpc> npx hardhat test test/Fork.ethereum.test.js
 * (if FORK_URL is missing, the test is skipped)
 */
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; // UniswapV2Router02
const FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"; // UniswapV2Factory
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const ROUTER_ABI = [
  "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint, uint, uint)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)",
];
const FACTORY_ABI = ["function getPair(address,address) view returns (address)"];

const DEADLINE = 9999999999n; // far in the future
const SUPPLY = ethers.parseUnits("100000000000", 18); // 100B (= MAX_SUPPLY)
const ONE_PERCENT = SUPPLY / 100n;

// Tier blocks (must match the deploy below): ethereum = 5 / 10 / 15.
const TIERS = [5, 10, 15];

// JS mirror of the guardian logic.
function expectedSellBps(g) {
  if (g === 0 || g > TIERS[2]) return 0n;
  if (g <= TIERS[0]) return 5000n;
  if (g <= TIERS[1]) return 4000n;
  return 3000n;
}

const runner = process.env.FORK_URL || process.env.ANKR_API_KEYS ? describe : describe.skip;

runner("RocketToken - Ethereum fork (full flow)", function () {
  this.timeout(180000);

  let token, router, factory, pair;
  let owner, buyer1, buyer2;

  async function guardianBlock() {
    const open = Number(await token.tradingOpenBlock());
    const cur = await ethers.provider.getBlockNumber();
    // the next tx will be executed in block cur+1
    return cur + 1 - open + 1;
  }

  // Mine until the next tx lands in the given guardian block G.
  async function mineUntilGuardian(targetG) {
    const open = Number(await token.tradingOpenBlock());
    const targetBlock = open + targetG - 2; // tx in the next block -> guardian = targetG
    const cur = await ethers.provider.getBlockNumber();
    if (targetBlock > cur) {
      await network.provider.send("hardhat_mine", [
        "0x" + (targetBlock - cur).toString(16),
      ]);
    }
  }

  before(async function () {
    [owner, buyer1, buyer2] = await ethers.getSigners();

    const Rocket = await ethers.getContractFactory("RocketToken");
    token = await Rocket.connect(owner).deploy(owner.address, ...TIERS);
    await token.waitForDeployment();
    console.log("    RocketToken deployed:", await token.getAddress());

    router = new ethers.Contract(ROUTER, ROUTER_ABI, owner);
    factory = new ethers.Contract(FACTORY, FACTORY_ABI, owner);
  });

  it("1. adds liquidity and sets the LP (RCT/WETH pair)", async function () {
    const tokenLiq = ethers.parseUnits("20000000000", 18); // 20B RCT
    const ethLiq = ethers.parseEther("100");

    await (await token.approve(ROUTER, ethers.MaxUint256)).wait();
    await (
      await router.addLiquidityETH(
        await token.getAddress(),
        tokenLiq,
        0,
        0,
        owner.address,
        DEADLINE,
        { value: ethLiq }
      )
    ).wait();

    pair = await factory.getPair(await token.getAddress(), WETH);
    expect(pair).to.not.equal(ethers.ZeroAddress);

    await (await token.setLp(pair)).wait();
    expect(await token.lpPair()).to.equal(pair);
    console.log("    LP pair:", pair);
  });

  it("2. a buy BEFORE trading is open reverts", async function () {
    await expect(
      router
        .connect(buyer1)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [WETH, await token.getAddress()],
          buyer1.address,
          DEADLINE,
          { value: ethers.parseEther("0.5") }
        )
    ).to.be.reverted;
  });

  it("3. executeTrading opens trading", async function () {
    await (await token.executeTrading()).wait();
    expect(await token.tradingOpen()).to.equal(true);
    console.log("    tradingOpenBlock:", Number(await token.tradingOpenBlock()));
  });

  it("4. TIER 1: a small buy goes through, a large one (>1%) reverts (max wallet)", async function () {
    const tokenAddr = await token.getAddress();

    // small buy - below the 1% limit
    await (
      await router
        .connect(buyer1)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [WETH, tokenAddr],
          buyer1.address,
          DEADLINE,
          { value: ethers.parseEther("0.5") }
        )
    ).wait();
    const bal1 = await token.balanceOf(buyer1.address);
    expect(bal1).to.be.gt(0n);
    expect(bal1).to.be.lte(ONE_PERCENT);
    console.log("    buyer1 bought:", ethers.formatUnits(bal1, 18), "RCT (< 1%)");

    // large buy - above 1% -> MaxWalletExceeded
    await expect(
      router
        .connect(buyer2)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [WETH, tokenAddr],
          buyer2.address,
          DEADLINE,
          { value: ethers.parseEther("20") }
        )
    ).to.be.reverted;
    console.log("    large buy (>1%) reverted correctly");
  });

  it("5. SELL taxes across tiers (50/40/30%) - the tax is BURNED", async function () {
    const tokenAddr = await token.getAddress();
    await (await token.connect(buyer1).approve(ROUTER, ethers.MaxUint256)).wait();
    const sellAmount = ethers.parseUnits("10000000", 18); // 10M RCT per sell

    for (const targetG of [3, 8, 13]) {
      await mineUntilGuardian(targetG);

      const supplyBefore = await token.totalSupply();
      const burnedBefore = await token.totalTaxBurned();

      const tx = await router
        .connect(buyer1)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          sellAmount,
          0,
          [tokenAddr, WETH],
          buyer1.address,
          DEADLINE
        );
      const rec = await tx.wait();

      const open = Number(await token.tradingOpenBlock());
      const g = rec.blockNumber - open + 1;
      const expBps = expectedSellBps(g);
      const expBurn = (sellAmount * expBps) / 10000n;

      const burnedNow = (await token.totalTaxBurned()) - burnedBefore;
      const supplyDrop = supplyBefore - (await token.totalSupply());

      expect(burnedNow).to.equal(expBurn);
      expect(supplyDrop).to.equal(expBurn);
      console.log(
        `    guardian block ${g}: tax ${Number(expBps) / 100}% -> burned ${ethers.formatUnits(expBurn, 18)} RCT`
      );
    }
  });

  it("6. AFTER tier3 (block > 15): no max wallet and no tax (normal)", async function () {
    const tokenAddr = await token.getAddress();
    await mineUntilGuardian(18);

    // a large buy now goes through (no limit) and the balance may exceed 1%
    await (
      await router
        .connect(buyer2)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [WETH, tokenAddr],
          buyer2.address,
          DEADLINE,
          { value: ethers.parseEther("20") }
        )
    ).wait();
    const bal2 = await token.balanceOf(buyer2.address);
    expect(bal2).to.be.gt(ONE_PERCENT);
    console.log("    buyer2 bought", ethers.formatUnits(bal2, 18), "RCT (> 1%, no limit)");

    // sell now - no tax, no burn
    await (await token.connect(buyer2).approve(ROUTER, ethers.MaxUint256)).wait();
    const burnedBefore = await token.totalTaxBurned();
    const sellAmount = ethers.parseUnits("5000000", 18);

    await (
      await router
        .connect(buyer2)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          sellAmount,
          0,
          [tokenAddr, WETH],
          buyer2.address,
          DEADLINE
        )
    ).wait();

    expect(await token.totalTaxBurned()).to.equal(burnedBefore); // no new burn
    console.log("    sell after tier3: no tax, no burn - OK");
  });
});
