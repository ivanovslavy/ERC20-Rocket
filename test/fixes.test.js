// ============================================================================
//  SECURITY-FIX VERIFICATION SUITE
//  Proves the NEW RocketToken + NEW Launcher close the holes from the earlier audit:
//    #1 sniper WINDOW between add-liquidity and setLp  -> closed by the atomic Launcher
//    #2 tier3 can be set "effectively forever"         -> closed by MAX_TIER3 = 300 cap
//    #3 setLp accepts ANY address (wrong/unprotected)  -> closed by factory-pair validation
//    #A4 redundant nonReentrant on transfer/approve     -> removed, burns still emit RocketBurned
//  Local in-process Hardhat network ONLY. Reuses the existing Uniswap V2 venue helper.
//  Each it() PRINTS RAW VALUES FIRST, then asserts.
// ============================================================================
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");
const { deployVenue, pairAt } = require("./uniswap");

const E18 = 10n ** 18n;
const MAX_SUPPLY = 100_000_000_000n * E18; // 100B
const ONE_PCT = 1_000_000_000n * E18;      // 1% of supply = 1B
const fmt = (x) => ethers.formatUnits(x, 18);

async function deadline() {
  return (await ethers.provider.getBlock("latest")).timestamp + 3600;
}

// Capture the RAW revert of a tx-sending call.
async function rawRevert(fn) {
  try {
    const r = await fn();
    if (r && r.wait) await r.wait();
    return { reverted: false };
  } catch (e) {
    return {
      reverted: true,
      shortMessage: e.shortMessage,
      reason: e.reason,
      message: (e.message || "").split("\n")[0],
    };
  }
}

async function gotoGuardianBlock(token, G) {
  const open = await token.tradingOpenBlock();
  const target = open + BigInt(G) - 1n;
  const cur = BigInt(await ethers.provider.getBlockNumber());
  if (target > cur) await mine(Number(target - cur));
}

// NEW 6-arg constructor
async function deployToken(initialOwner, t1, t2, t3, factory, weth) {
  const Rocket = await ethers.getContractFactory("RocketToken");
  const token = await Rocket.deploy(initialOwner, t1, t2, t3, factory, weth);
  await token.waitForDeployment();
  return token;
}

// ============================================================================
describe("1. TIER3 CAP (#2 fixed): MAX_TIER3 = 300", function () {
  it("tier3 > 300 reverts InvalidTierConfig; tier3 == 300 (valid order) deploys; bad orderings still revert", async function () {
    const [owner] = await ethers.getSigners();
    const { factory, weth } = await deployVenue(owner);
    const F = await factory.getAddress();
    const W = await weth.getAddress();
    const Rocket = await ethers.getContractFactory("RocketToken");

    console.log("    MAX_TIER3 constant (from a deployed instance) is checked via revert boundary at 300/301");

    // --- tier3 = 301 -> revert ---
    const r301 = await rawRevert(() => Rocket.deploy(owner.address, 10, 20, 301, F, W).then(c => c.waitForDeployment()));
    console.log("    RAW tier3=301 :", JSON.stringify(r301));
    await expect(Rocket.deploy(owner.address, 10, 20, 301, F, W)).to.be.revertedWithCustomError(Rocket, "InvalidTierConfig");

    // --- tier3 = 10_000_000 (the old 'forever' honeypot value) -> revert ---
    const rBig = await rawRevert(() => Rocket.deploy(owner.address, 1, 2, 10_000_000, F, W).then(c => c.waitForDeployment()));
    console.log("    RAW tier3=10_000_000 :", JSON.stringify(rBig));
    await expect(Rocket.deploy(owner.address, 1, 2, 10_000_000, F, W)).to.be.revertedWithCustomError(Rocket, "InvalidTierConfig");

    // --- tier3 = 300 with valid t1<t2<300 -> deploys OK ---
    const ok = await deployToken(owner.address, 10, 20, 300, F, W);
    const t1 = await ok.tier1Blocks(), t2 = await ok.tier2Blocks(), t3 = await ok.tier3Blocks();
    const cap = await ok.MAX_TIER3();
    console.log("    RAW tier3=300 DEPLOYED. tier1/2/3 =", t1.toString(), t2.toString(), t3.toString(), " MAX_TIER3 =", cap.toString());
    console.log("    RAW totalSupply =", fmt(await ok.totalSupply()), " owner balance =", fmt(await ok.balanceOf(owner.address)));
    expect(t3).to.equal(300n);
    expect(cap).to.equal(300n);
    expect(await ok.totalSupply()).to.equal(MAX_SUPPLY);

    // --- old bad orderings STILL revert InvalidTierConfig ---
    for (const [a, b, c, label] of [[0, 1, 2, "tier1=0"], [5, 5, 10, "tier2<=tier1"], [5, 10, 10, "tier3<=tier2"]]) {
      const rr = await rawRevert(() => Rocket.deploy(owner.address, a, b, c, F, W).then(x => x.waitForDeployment()));
      console.log(`    RAW ${label} (${a},${b},${c}) :`, JSON.stringify(rr));
      await expect(Rocket.deploy(owner.address, a, b, c, F, W)).to.be.revertedWithCustomError(Rocket, "InvalidTierConfig");
    }
  });
});

// ============================================================================
describe("2. setLp VALIDATION (#3 fixed): must equal factory.getPair(token, weth)", function () {
  it("setLp(WRONG) reverts InvalidPair; setLp(correct pair) sets lpPair", async function () {
    const [owner, rando] = await ethers.getSigners();
    const { factory, weth, router } = await deployVenue(owner);
    const F = await factory.getAddress();
    const W = await weth.getAddress();
    const token = await deployToken(owner.address, 10, 20, 30, F, W); // owned by EOA
    const tokenAddr = await token.getAddress();
    const routerAddr = await router.getAddress();

    // create the REAL pair via addLiquidity (lpPair still 0, so transfer to pair is allowed)
    const liq = 50_000_000_000n * E18;
    await (await token.approve(routerAddr, liq)).wait();
    await (await router.addLiquidityETH(tokenAddr, liq, 0, 0, owner.address, await deadline(), { value: ethers.parseEther("10") })).wait();
    const realPair = await factory.getPair(tokenAddr, W);
    console.log("    RAW factory.getPair(token,weth) =", realPair);
    console.log("    RAW lpPair before any setLp      =", await token.lpPair());

    // WRONG #1: the WETH address
    const wrong1 = await rawRevert(() => token.setLp(W));
    console.log("    RAW setLp(WETH address) =", JSON.stringify(wrong1));
    await expect(token.setLp(W)).to.be.revertedWithCustomError(token, "InvalidPair");

    // WRONG #2: a random EOA address
    const wrong2 = await rawRevert(() => token.setLp(rando.address));
    console.log("    RAW setLp(random EOA)   =", JSON.stringify(wrong2));
    await expect(token.setLp(rando.address)).to.be.revertedWithCustomError(token, "InvalidPair");

    // lpPair must still be unset
    console.log("    RAW lpPair after wrong attempts  =", await token.lpPair());
    expect(await token.lpPair()).to.equal(ethers.ZeroAddress);

    // CORRECT: the real factory pair
    await (await token.setLp(realPair)).wait();
    console.log("    RAW lpPair after setLp(realPair) =", await token.lpPair());
    expect((await token.lpPair()).toLowerCase()).to.equal(realPair.toLowerCase());
  });
});

// ============================================================================
describe("3. ATOMIC LAUNCH closes the WINDOW (#1 fixed) — KEY TEST", function () {
  it("one launch() tx: open+lpPair+guardian all set, guardian active immediately, no intermediate unprotected state", async function () {
    const [deployer, bot] = await ethers.getSigners();
    const { factory, weth, router } = await deployVenue(deployer);
    const F = await factory.getAddress();
    const W = await weth.getAddress();
    const routerAddr = await router.getAddress();

    // Launcher deployed BY the deployer; token deployed with initialOwner = Launcher (owns + holds supply)
    const Launcher = await ethers.getContractFactory("Launcher");
    const launcher = await Launcher.deploy();
    await launcher.waitForDeployment();
    const launcherAddr = await launcher.getAddress();
    const token = await deployToken(launcherAddr, 10, 20, 30, F, W);
    const tokenAddr = await token.getAddress();

    console.log("    RAW launcher.owner()          =", await launcher.owner(), "(deployer:", deployer.address, ")");
    console.log("    RAW token.owner()             =", await token.owner(), "(launcher:", launcherAddr, ")");
    console.log("    RAW launcher token balance    =", fmt(await token.balanceOf(launcherAddr)));
    console.log("    RAW BEFORE launch tradingOpen =", await token.tradingOpen());
    console.log("    RAW BEFORE launch lpPair      =", await token.lpPair());
    console.log("    RAW BEFORE launch guardianBlk =", (await token.guardianBlock()).toString());
    expect(await token.tradingOpen()).to.equal(false);
    expect(await token.lpPair()).to.equal(ethers.ZeroAddress);
    expect(await token.balanceOf(launcherAddr)).to.equal(MAX_SUPPLY);

    // ---- THE SINGLE ATOMIC TX ----
    const liqTokens = 50_000_000_000n * E18; // 50B
    const launchTx = await launcher.launch(tokenAddr, routerAddr, liqTokens, 0, 0, deployer.address, { value: ethers.parseEther("10") });
    const rc = await launchTx.wait();
    const pairAddr = await factory.getPair(tokenAddr, W);

    console.log("    --- AFTER the single launch() tx (block", rc.blockNumber, ") ---");
    console.log("    RAW tradingOpen     =", await token.tradingOpen());
    console.log("    RAW lpPair          =", await token.lpPair(), "(factory pair:", pairAddr, ")");
    console.log("    RAW tradingOpenBlock=", (await token.tradingOpenBlock()).toString());
    console.log("    RAW guardianBlock   =", (await token.guardianBlock()).toString());
    console.log("    RAW currentMaxWallet=", fmt(await token.currentMaxWallet()), " sellTaxBps =", (await token.currentSellTaxBps()).toString());
    console.log("    RAW pair token bal  =", fmt(await token.balanceOf(pairAddr)));

    expect(await token.tradingOpen()).to.equal(true);
    expect((await token.lpPair()).toLowerCase()).to.equal(pairAddr.toLowerCase());
    expect(pairAddr).to.not.equal(ethers.ZeroAddress);
    expect(await token.guardianBlock()).to.equal(1n); // opened this same block -> guardian block 1

    // ---- guardian is ACTIVE immediately: external bot buy > 1% must revert ----
    const quoteBig = await router.getAmountsOut(ethers.parseEther("1"), [W, tokenAddr]);
    console.log("    RAW quote for 1 ETH buy =", fmt(quoteBig[1]), "(> 1% =", quoteBig[1] > ONE_PCT, ")");
    const bigBuy = await rawRevert(async () =>
      router.connect(bot).swapExactETHForTokens(0, [W, tokenAddr], bot.address, await deadline(), { value: ethers.parseEther("1") })
    );
    console.log("    RAW bot buy >1% revert  =", JSON.stringify(bigBuy));
    expect(bigBuy.reverted).to.equal(true);
    expect((bigBuy.reason || bigBuy.shortMessage || bigBuy.message || "")).to.match(/TRANSFER_FAILED/);
    console.log("    RAW bot balance after failed big buy =", fmt(await token.balanceOf(bot.address)));
    expect(await token.balanceOf(bot.address)).to.equal(0n); // reverted, nothing acquired

    // ---- buy < 1% passes ----
    const before = await token.balanceOf(bot.address);
    await (await router.connect(bot).swapExactETHForTokens(0, [W, tokenAddr], bot.address, await deadline(), { value: ethers.parseEther("0.1") })).wait();
    const got = (await token.balanceOf(bot.address)) - before;
    console.log("    RAW bot buy <1% received =", fmt(got), " (< 1% =", got < ONE_PCT, ") guardianBlock:", (await token.guardianBlock()).toString());
    expect(got).to.be.gt(0n);
    expect(got).to.be.lt(ONE_PCT);

    console.log("    NOTE: add-liquidity + setLp + executeTrading executed in ONE tx (block " + rc.blockNumber + ").");
    console.log("          There is NO block in which the pool is live while lpPair==0, so the old");
    console.log("          3-separate-tx sniper window (bot bought ~4.5B untaxed) no longer exists.");
    console.log("          Test 6 proves the SAME new contract WITHOUT the launcher still leaves that window open.");
  });
});

// ============================================================================
describe("4. GUARDIAN REGRESSION (still correct after the atomic launch)", function () {
  it("sell burns the tax (supply drop == totalTaxBurned == AntiBotTaxBurned), then tier transitions 1/2/3%->0 & 50/40/30%->0", async function () {
    const [deployer, bot] = await ethers.getSigners();
    const { factory, weth, router } = await deployVenue(deployer);
    const F = await factory.getAddress();
    const W = await weth.getAddress();
    const routerAddr = await router.getAddress();

    const Launcher = await ethers.getContractFactory("Launcher");
    const launcher = await Launcher.deploy();
    await launcher.waitForDeployment();
    const token = await deployToken(await launcher.getAddress(), 10, 20, 30, F, W);
    const tokenAddr = await token.getAddress();
    await (await launcher.launch(tokenAddr, routerAddr, 50_000_000_000n * E18, 0, 0, deployer.address, { value: ethers.parseEther("10") })).wait();
    const pairAddr = await factory.getPair(tokenAddr, W);

    // --- bot buys a small (<1%) amount, then SELLS via supporting-fee swap: tax BURNED ---
    await (await router.connect(bot).swapExactETHForTokens(0, [W, tokenAddr], bot.address, await deadline(), { value: ethers.parseEther("0.1") })).wait();
    const sellAmt = await token.balanceOf(bot.address);
    const taxBps = await token.currentSellTaxBps();
    const expectedTax = (sellAmt * taxBps) / 10000n;

    const supplyBefore = await token.totalSupply();
    const taxBurnedBefore = await token.totalTaxBurned();
    await (await token.connect(bot).approve(routerAddr, sellAmt)).wait();
    const sellTx = await router.connect(bot).swapExactTokensForETHSupportingFeeOnTransferTokens(
      sellAmt, 0, [tokenAddr, W], bot.address, await deadline()
    );
    const rc = await sellTx.wait();
    const supplyAfter = await token.totalSupply();
    const taxBurnedAfter = await token.totalTaxBurned();

    // decode AntiBotTaxBurned
    let taxEvt = null;
    for (const log of rc.logs) {
      try { const p = token.interface.parseLog(log); if (p && p.name === "AntiBotTaxBurned") taxEvt = p; } catch {}
    }
    const supplyDrop = supplyBefore - supplyAfter;
    const taxDelta = taxBurnedAfter - taxBurnedBefore;
    console.log("    RAW guardianBlock at sell =", (await token.guardianBlock()).toString(), " sellTaxBps =", taxBps.toString());
    console.log("    RAW sell amount           =", fmt(sellAmt));
    console.log("    RAW expected tax (50%)    =", fmt(expectedTax));
    console.log("    RAW totalSupply drop      =", fmt(supplyDrop));
    console.log("    RAW totalTaxBurned delta  =", fmt(taxDelta));
    console.log("    RAW AntiBotTaxBurned evt  =", taxEvt ? fmt(taxEvt.args[1]) : "NONE");
    expect(taxBps).to.equal(5000n);
    expect(supplyDrop).to.equal(expectedTax);
    expect(taxDelta).to.equal(expectedTax);
    expect(taxEvt).to.not.equal(null);
    expect(taxEvt.args[1]).to.equal(expectedTax);

    // --- tier transitions across boundaries (views of guardianBlock) ---
    const expected = (G) => {
      if (G <= 10) return [ONE_PCT, 5000n];
      if (G <= 20) return [ONE_PCT * 2n, 4000n];
      if (G <= 30) return [ONE_PCT * 3n, 3000n];
      return [0n, 0n];
    };
    const rows = [];
    for (const G of [1, 10, 11, 20, 21, 30, 31, 50]) {
      await gotoGuardianBlock(token, G);
      const mw = await token.currentMaxWallet();
      const tax = await token.currentSellTaxBps();
      const gb = await token.guardianBlock();
      const [emw, etax] = expected(G);
      rows.push({
        guardianBlock: gb.toString(),
        maxWallet_pctOfSupply: (mw === 0n ? "0 (no limit)" : (mw * 100n / MAX_SUPPLY) + "%"),
        maxWallet_raw: fmt(mw),
        sellTaxBps: tax.toString(),
      });
      expect(mw).to.equal(emw);
      expect(tax).to.equal(etax);
    }
    console.table(rows);
  });
});

// ============================================================================
describe("5. COSMETICS (#A4): burns emit RocketBurned; plain transfer not broken", function () {
  it("burn / burnFrom / burnRocket each emit RocketBurned; a plain transfer succeeds", async function () {
    const [owner, user] = await ethers.getSigners();
    const { factory, weth } = await deployVenue(owner);
    const token = await deployToken(owner.address, 10, 20, 30, await factory.getAddress(), await weth.getAddress());

    const s0 = await token.totalSupply();
    console.log("    RAW totalSupply start =", fmt(s0));

    // burnRocket
    const a1 = 1000n * E18;
    await expect(token.burnRocket(a1)).to.emit(token, "RocketBurned").withArgs(owner.address, a1);
    const s1 = await token.totalSupply();
    console.log("    RAW after burnRocket(1000): supply =", fmt(s1), " burned =", fmt(s0 - s1));

    // burn
    const a2 = 2000n * E18;
    await expect(token.burn(a2)).to.emit(token, "RocketBurned").withArgs(owner.address, a2);
    const s2 = await token.totalSupply();
    console.log("    RAW after burn(2000):       supply =", fmt(s2), " burned =", fmt(s1 - s2));

    // burnFrom: owner approves user, user burns from owner
    const a3 = 3000n * E18;
    await (await token.approve(user.address, a3)).wait();
    await expect(token.connect(user).burnFrom(owner.address, a3)).to.emit(token, "RocketBurned").withArgs(owner.address, a3);
    const s3 = await token.totalSupply();
    console.log("    RAW after burnFrom(3000):   supply =", fmt(s3), " burned =", fmt(s2 - s3));

    expect(s0 - s3).to.equal(a1 + a2 + a3);

    // plain transfer still works (no nonReentrant, no pair involved)
    const amt = 5_000_000n * E18;
    const uBefore = await token.balanceOf(user.address);
    const tx = await token.transfer(user.address, amt);
    await tx.wait();
    const uAfter = await token.balanceOf(user.address);
    console.log("    RAW plain transfer 5,000,000 RCT owner->user : user delta =", fmt(uAfter - uBefore));
    expect(uAfter - uBefore).to.equal(amt);
  });
});

// ============================================================================
describe("6. CONTRAST: the contract ALONE cannot close the window (sequencing property)", function () {
  it("NEW contract, NO launcher: addLiquidity then (before setLp) a buy still passes untaxed & over 1%", async function () {
    const [owner, bot] = await ethers.getSigners();
    const { factory, weth, router } = await deployVenue(owner);
    const W = await weth.getAddress();
    const token = await deployToken(owner.address, 10, 20, 30, await factory.getAddress(), W);
    const tokenAddr = await token.getAddress();
    const routerAddr = await router.getAddress();

    // add liquidity, but DO NOT setLp yet (the exact gap the launcher removes)
    const liq = 50_000_000_000n * E18;
    await (await token.approve(routerAddr, liq)).wait();
    await (await router.addLiquidityETH(tokenAddr, liq, 0, 0, owner.address, await deadline(), { value: ethers.parseEther("10") })).wait();

    const quoted = await router.getAmountsOut(ethers.parseEther("1"), [W, tokenAddr]);
    console.log("    RAW tradingOpen =", await token.tradingOpen(), " lpPair =", await token.lpPair());
    console.log("    RAW getAmountsOut(1 ETH) =", fmt(quoted[1]));

    const before = await token.balanceOf(bot.address);
    await (await router.connect(bot).swapExactETHForTokens(0, [W, tokenAddr], bot.address, await deadline(), { value: ethers.parseEther("1") })).wait();
    const got = (await token.balanceOf(bot.address)) - before;

    console.log("    RAW bot received (UNGUARDED window) =", fmt(got));
    console.log("    RAW 1% maxWallet would be           =", fmt(ONE_PCT));
    console.log("    RAW received == AMM quote (untaxed)? =", got === quoted[1]);
    console.log("    RAW received > 1% (over would-be cap)? =", got > ONE_PCT);
    console.log("    RAW totalTaxBurned                  =", fmt(await token.totalTaxBurned()));

    expect(await token.tradingOpen()).to.equal(false);
    expect(await token.lpPair()).to.equal(ethers.ZeroAddress);
    expect(got).to.equal(quoted[1]);   // untaxed
    expect(got).to.be.gt(ONE_PCT);     // over the would-be 1% cap, yet allowed
    expect(await token.totalTaxBurned()).to.equal(0n);
    console.log("    => The window is a SEQUENCING property: only the atomic Launcher (test 3) removes it.");
  });
});
