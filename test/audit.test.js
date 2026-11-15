const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");
const { deployVenue, pairAt, PairArt } = require("./uniswap");

// ---------- helpers ----------
const E18 = 10n ** 18n;
const MAX_SUPPLY = 100_000_000_000n * E18; // 100B
const ONE_PCT = 1_000_000_000n * E18; // 1% of supply = 1B
const fmt = (x) => ethers.formatUnits(x, 18);

async function deadline() {
  return (await ethers.provider.getBlock("latest")).timestamp + 3600;
}

// Capture the RAW revert of a tx-sending call (ethers rejects at estimateGas/send).
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

async function deployToken(owner, factoryAddr, wethAddr, t1 = 10, t2 = 20, t3 = 30, initialOwner = null) {
  const Rocket = await ethers.getContractFactory("RocketToken");
  const token = await Rocket.deploy(initialOwner || owner.address, t1, t2, t3, factoryAddr, wethAddr);
  await token.waitForDeployment();
  return token;
}

// venue + token + liquidity (owner), WITHOUT setLp / executeTrading
async function baseSetup(tiers = [10, 20, 30], tokenLiq = 50_000_000_000n, ethLiq = "10") {
  const [owner, bot, user, user2] = await ethers.getSigners();
  const { factory, weth, router } = await deployVenue(owner);
  const token = await deployToken(owner, await factory.getAddress(), await weth.getAddress(), ...tiers);
  const routerAddr = await router.getAddress();
  const tokenAddr = await token.getAddress();
  const wethAddr = await weth.getAddress();

  const liqAmt = tokenLiq * E18;
  await (await token.approve(routerAddr, liqAmt)).wait();
  await (
    await router.addLiquidityETH(tokenAddr, liqAmt, 0, 0, owner.address, await deadline(), {
      value: ethers.parseEther(ethLiq),
    })
  ).wait();
  const pairAddr = await factory.getPair(tokenAddr, wethAddr);
  const pair = pairAt(pairAddr, owner);
  return {
    owner, bot, user, user2, factory, weth, router, token,
    routerAddr, tokenAddr, wethAddr, pairAddr, pair,
  };
}

async function buyETH(ctx, signer, ethAmount, to = null, supporting = false) {
  const path = [ctx.wethAddr, ctx.tokenAddr];
  const fn = supporting
    ? ctx.router.connect(signer).swapExactETHForTokensSupportingFeeOnTransferTokens
    : ctx.router.connect(signer).swapExactETHForTokens;
  return fn(0, path, to || signer.address, await deadline(), {
    value: ethers.parseEther(ethAmount),
  });
}

async function gotoGuardianBlock(token, G) {
  const open = await token.tradingOpenBlock();
  const target = open + BigInt(G) - 1n;
  const cur = BigInt(await ethers.provider.getBlockNumber());
  if (target > cur) await mine(Number(target - cur));
}

// ============================================================================
describe("A. WINDOW: buy before setLp/executeTrading (unguarded)", function () {
  it("buy succeeds, UNTAXED, OVER 1% maxWallet, while tradingOpen=false & lpPair=0", async function () {
    const ctx = await baseSetup();
    const path = [ctx.wethAddr, ctx.tokenAddr];
    const ethIn = ethers.parseEther("1");
    const quoted = await ctx.router.getAmountsOut(ethIn, path);
    console.log("    tradingOpen():", await ctx.token.tradingOpen());
    console.log("    lpPair():", await ctx.token.lpPair());
    console.log("    getAmountsOut tokens:", fmt(quoted[1]));

    const before = await ctx.token.balanceOf(ctx.bot.address);
    await (
      await ctx.router.connect(ctx.bot).swapExactETHForTokens(
        0, path, ctx.bot.address, await deadline(), { value: ethIn }
      )
    ).wait();
    const got = (await ctx.token.balanceOf(ctx.bot.address)) - before;

    console.log("    RAW bot received:", fmt(got));
    console.log("    RAW 1% maxWallet would be:", fmt(ONE_PCT));
    console.log("    received == getAmountsOut (untaxed)?", got === quoted[1]);
    console.log("    received > 1% (over would-be maxWallet)?", got > ONE_PCT);
    console.log("    totalTaxBurned:", fmt(await ctx.token.totalTaxBurned()));
    console.log("    totalSupply:", fmt(await ctx.token.totalSupply()));

    expect(await ctx.token.tradingOpen()).to.equal(false);
    expect(await ctx.token.lpPair()).to.equal(ethers.ZeroAddress);
    expect(got).to.equal(quoted[1]); // untaxed: exactly the AMM quote
    expect(got).to.be.gt(ONE_PCT); // exceeds would-be 1% limit, yet passes
    expect(await ctx.token.totalTaxBurned()).to.equal(0n);
  });
});

// ============================================================================
describe("B. AFTER setLp, BEFORE executeTrading", function () {
  it("buy reverts (cause = TradingNotOpen)", async function () {
    const ctx = await baseSetup();
    await (await ctx.token.setLp(ctx.pairAddr)).wait();
    console.log("    lpPair():", await ctx.token.lpPair());
    console.log("    tradingOpen():", await ctx.token.tradingOpen());

    const res = await rawRevert(() => buyETH(ctx, ctx.bot, "1"));
    console.log("    RAW buy-via-DEX revert:", JSON.stringify(res));
    // direct transfer TO the pair (to==pair) surfaces the RAW custom error (not masked by the DEX)
    const resDirect = await rawRevert(() =>
      ctx.token.transfer(ctx.pairAddr, 1_000n * E18)
    );
    console.log("    RAW direct transfer->pair revert:", JSON.stringify(resDirect));
    expect(res.reverted).to.equal(true);
    expect(resDirect.reverted).to.equal(true);
  });
});

// ============================================================================
describe("C. AFTER executeTrading (tier1 window)", function () {
  it("buy>1% reverts; buy<1% passes; supporting sell burns 50%; plain sell reverts", async function () {
    const ctx = await baseSetup();
    await (await ctx.token.setLp(ctx.pairAddr)).wait();
    await (await ctx.token.executeTrading()).wait();
    console.log("    tradingOpenBlock:", (await ctx.token.tradingOpenBlock()).toString());
    console.log("    guardianBlock (view now):", (await ctx.token.guardianBlock()).toString());
    console.log("    currentMaxWallet:", fmt(await ctx.token.currentMaxWallet()));
    console.log("    currentSellTaxBps:", (await ctx.token.currentSellTaxBps()).toString());

    // --- buy ABOVE 1% (1 ETH ~ 4.5B) ---
    const bigBuy = await rawRevert(() => buyETH(ctx, ctx.bot, "1"));
    console.log("    RAW buy>1% revert:", JSON.stringify(bigBuy), "gBlock:", (await ctx.token.guardianBlock()).toString());
    expect(bigBuy.reverted).to.equal(true);

    // --- buy BELOW 1% (0.1 ETH ~ 0.49B) into fresh wallet ---
    const q = await ctx.router.getAmountsOut(ethers.parseEther("0.1"), [ctx.wethAddr, ctx.tokenAddr]);
    console.log("    quote for 0.1 ETH:", fmt(q[1]), "(< 1%?", q[1] < ONE_PCT, ")");
    const before = await ctx.token.balanceOf(ctx.user.address);
    await (await buyETH(ctx, ctx.user, "0.1")).wait();
    const bought = (await ctx.token.balanceOf(ctx.user.address)) - before;
    console.log("    RAW user bought (<1%):", fmt(bought), "gBlock:", (await ctx.token.guardianBlock()).toString());
    expect(bought).to.be.gt(0n);
    expect(bought).to.be.lt(ONE_PCT);

    // --- SELL via supporting-fee swap: 50% burned ---
    const sellAmt = bought; // sell all of user's tokens
    await (await ctx.token.connect(ctx.user).approve(ctx.routerAddr, sellAmt)).wait();
    const supplyBefore = await ctx.token.totalSupply();
    const taxBurnedBefore = await ctx.token.totalTaxBurned();
    const taxBps = await ctx.token.currentSellTaxBps();
    const expectedTax = (sellAmt * taxBps) / 10000n;
    const sellTx = await ctx.router.connect(ctx.user).swapExactTokensForETHSupportingFeeOnTransferTokens(
      sellAmt, 0, [ctx.tokenAddr, ctx.wethAddr], ctx.user.address, await deadline()
    );
    const rc = await sellTx.wait();
    const supplyAfter = await ctx.token.totalSupply();
    const taxBurnedAfter = await ctx.token.totalTaxBurned();
    // decode AntiBotTaxBurned
    const iface = ctx.token.interface;
    let taxEvt = null;
    for (const log of rc.logs) {
      try { const p = iface.parseLog(log); if (p && p.name === "AntiBotTaxBurned") taxEvt = p; } catch {}
    }
    console.log("    sell amount:", fmt(sellAmt), "taxBps:", taxBps.toString());
    console.log("    RAW expected 50% tax:", fmt(expectedTax));
    console.log("    RAW totalSupply drop:", fmt(supplyBefore - supplyAfter));
    console.log("    RAW totalTaxBurned delta:", fmt(taxBurnedAfter - taxBurnedBefore));
    console.log("    AntiBotTaxBurned event amount:", taxEvt ? fmt(taxEvt.args[1]) : "NONE");
    expect(supplyBefore - supplyAfter).to.equal(expectedTax);
    expect(taxBurnedAfter - taxBurnedBefore).to.equal(expectedTax);
    expect(taxEvt).to.not.equal(null);

    // --- plain (non-supporting) sell should revert ---
    const before2 = await ctx.token.balanceOf(ctx.user2.address);
    await (await buyETH(ctx, ctx.user2, "0.1")).wait();
    const u2bal = (await ctx.token.balanceOf(ctx.user2.address)) - before2;
    await (await ctx.token.connect(ctx.user2).approve(ctx.routerAddr, u2bal)).wait();
    const plain2 = await rawRevert(async () =>
      ctx.router.connect(ctx.user2).swapExactTokensForETH(
        u2bal, 0, [ctx.tokenAddr, ctx.wethAddr], ctx.user2.address, await deadline()
      )
    );
    console.log("    RAW plain swapExactTokensForETH revert:", JSON.stringify(plain2));
    expect(plain2.reverted).to.equal(true);
  });
});

// ============================================================================
describe("D. TIER TRANSITIONS", function () {
  it("prints currentMaxWallet/currentSellTaxBps at each boundary", async function () {
    const ctx = await baseSetup([10, 20, 30]);
    await (await ctx.token.setLp(ctx.pairAddr)).wait();
    await (await ctx.token.executeTrading()).wait();
    // expected per guardianBlock G for tiers 10/20/30
    const expected = (G) => {
      if (G <= 10) return [ONE_PCT, 5000n];
      if (G <= 20) return [ONE_PCT * 2n, 4000n];
      if (G <= 30) return [ONE_PCT * 3n, 3000n];
      return [0n, 0n];
    };
    const rows = [];
    // ascending only (cannot un-mine); assert inline
    for (const G of [1, 10, 11, 20, 21, 30, 31, 50]) {
      await gotoGuardianBlock(ctx.token, G);
      const mw = await ctx.token.currentMaxWallet();
      const tax = await ctx.token.currentSellTaxBps();
      const gb = await ctx.token.guardianBlock();
      const [emw, etax] = expected(G);
      rows.push({ requestedG: G, guardianBlock: gb.toString(), maxWalletPctOfSupply: (emw * 100n) / MAX_SUPPLY + "%", maxWalletRaw: fmt(mw), sellTaxBps: tax.toString() });
      expect(mw).to.equal(emw);
      expect(tax).to.equal(etax);
    }
    console.table(rows);
  });
});

// ============================================================================
describe("E. ADD LIQUIDITY inside the guarded window (after executeTrading)", function () {
  it("router transferFrom(owner->pair) is taxed as a SELL: tokens burned", async function () {
    const ctx = await baseSetup();
    await (await ctx.token.setLp(ctx.pairAddr)).wait();
    await (await ctx.token.executeTrading()).wait();

    const addToken = 1_000_000_000n * E18; // 1B desired
    await (await ctx.token.approve(ctx.routerAddr, addToken)).wait();
    const pairBalBefore = await ctx.token.balanceOf(ctx.pairAddr);
    const supplyBefore = await ctx.token.totalSupply();
    const taxBurnedBefore = await ctx.token.totalTaxBurned();
    const lpBefore = await ctx.pair.balanceOf(ctx.owner.address);
    const gb = await ctx.token.guardianBlock();
    const taxBps = await ctx.token.currentSellTaxBps();
    console.log("    guardianBlock:", gb.toString(), "sellTaxBps:", taxBps.toString());

    // ETH matched to current ratio (~5B tokens/ETH -> 1B tokens ~ 0.2 ETH); give extra, router adjusts
    await (
      await ctx.router.addLiquidityETH(ctx.tokenAddr, addToken, 0, 0, ctx.owner.address, await deadline(), {
        value: ethers.parseEther("0.25"),
      })
    ).wait();

    const pairBalAfter = await ctx.token.balanceOf(ctx.pairAddr);
    const supplyAfter = await ctx.token.totalSupply();
    const taxBurnedAfter = await ctx.token.totalTaxBurned();
    const lpAfter = await ctx.pair.balanceOf(ctx.owner.address);
    const pairDelta = pairBalAfter - pairBalBefore;
    const burned = supplyBefore - supplyAfter;
    console.log("    RAW tokens actually ENTERING pair:", fmt(pairDelta));
    console.log("    RAW tokens BURNED (supply drop):", fmt(burned));
    console.log("    RAW totalTaxBurned delta:", fmt(taxBurnedAfter - taxBurnedBefore));
    console.log("    RAW desired tokenAmount:", fmt(addToken));
    console.log("    RAW LP minted to owner:", fmt(lpAfter - lpBefore));
    // The amount the router actually pulled = pairDelta + burned (tax). Reason: toPair => SELL path.
    expect(taxBurnedAfter - taxBurnedBefore).to.be.gt(0n);
    expect(burned).to.equal(taxBurnedAfter - taxBurnedBefore);
  });
});

// ============================================================================
describe("F. REMOVE LIQUIDITY inside the window", function () {
  it("early large removal reverts (MaxWalletExceeded as a 'buy'); after tier3 it passes", async function () {
    const ctx = await baseSetup();
    await (await ctx.token.setLp(ctx.pairAddr)).wait();
    await (await ctx.token.executeTrading()).wait();

    const lp = await ctx.pair.balanceOf(ctx.owner.address);
    console.log("    owner LP balance:", fmt(lp));
    // approve router to pull LP
    await (await ctx.pair.approve(ctx.routerAddr, lp)).wait();

    // EARLY: remove ALL LP -> would return ~50B tokens to router (fromPair=BUY, maxWallet 1%)
    const gbEarly = await ctx.token.guardianBlock();
    const mwEarly = await ctx.token.currentMaxWallet();
    console.log("    guardianBlock:", gbEarly.toString(), "currentMaxWallet:", fmt(mwEarly));
    const early = await rawRevert(async () =>
      ctx.router.removeLiquidityETHSupportingFeeOnTransferTokens(
        ctx.tokenAddr, lp, 0, 0, ctx.owner.address, await deadline()
      )
    );
    console.log("    RAW early large remove revert:", JSON.stringify(early));
    expect(early.reverted).to.equal(true);

    // AFTER tier3: maxWallet = 0 (no limit) -> passes
    await gotoGuardianBlock(ctx.token, 31);
    console.log("    after tier3 -> currentMaxWallet:", fmt(await ctx.token.currentMaxWallet()), "guardianBlock:", (await ctx.token.guardianBlock()).toString());
    const ownerTokBefore = await ctx.token.balanceOf(ctx.owner.address);
    await (await ctx.pair.approve(ctx.routerAddr, lp)).wait();
    const late = await rawRevert(async () =>
      ctx.router.removeLiquidityETHSupportingFeeOnTransferTokens(
        ctx.tokenAddr, lp, 0, 0, ctx.owner.address, await deadline()
      )
    );
    console.log("    RAW after-tier3 remove result:", JSON.stringify(late));
    const ownerTokAfter = await ctx.token.balanceOf(ctx.owner.address);
    console.log("    RAW tokens returned to owner:", fmt(ownerTokAfter - ownerTokBefore));
    expect(late.reverted).to.equal(false);
    expect(ownerTokAfter - ownerTokBefore).to.be.gt(ONE_PCT); // got way more than 1% back, now allowed
  });
});

// ============================================================================
describe("G. LIMIT BYPASS across multiple wallets", function () {
  it("buy ~1% into A, move A->B, buy again into A: total > 1%", async function () {
    const ctx = await baseSetup();
    await (await ctx.token.setLp(ctx.pairAddr)).wait();
    await (await ctx.token.executeTrading()).wait();
    const A = ctx.user, B = ctx.user2;

    // buy ~0.73B (under 1%) into A (0.15 ETH)
    await (await buyETH(ctx, A, "0.15")).wait();
    let aBal = await ctx.token.balanceOf(A.address);
    console.log("    A after buy1:", fmt(aBal), "(<1%?", aBal < ONE_PCT, ")");
    expect(aBal).to.be.lt(ONE_PCT); // single-wallet buy stays under maxWallet
    // move all A -> B (wallet-to-wallet, no pair, no limit)
    await (await ctx.token.connect(A).transfer(B.address, aBal)).wait();
    console.log("    moved A->B:", fmt(aBal));
    // buy again into A (now empty again), another ~0.7B
    await (await buyETH(ctx, A, "0.15")).wait();
    aBal = await ctx.token.balanceOf(A.address);
    const bBal = await ctx.token.balanceOf(B.address);
    const total = aBal + bBal;
    console.log("    RAW A:", fmt(aBal), " B:", fmt(bBal), " TOTAL:", fmt(total));
    console.log("    RAW 1% limit:", fmt(ONE_PCT), " total > 1%?", total > ONE_PCT);
    expect(total).to.be.gt(ONE_PCT);
  });
});

// ============================================================================
describe("H. PARAMS / tier config (MAX_TIER3 cap)", function () {
  it("tier3 CAPPED at MAX_TIER3=300; old 'forever' value reverts; inside gives 3%/30%, past it 0", async function () {
    const [owner] = await ethers.getSigners();
    const { factory, weth, router } = await deployVenue(owner);
    const F = await factory.getAddress(), W = await weth.getAddress();
    const Rocket = await ethers.getContractFactory("RocketToken");
    // the old "effectively forever" value is now rejected at construction
    await expect(Rocket.deploy(owner.address, 1, 2, 10_000_000, F, W)).to.be.revertedWithCustomError(Rocket, "InvalidTierConfig");
    // max allowed window: tier3 = 300
    const token = await deployToken(owner, F, W, 1, 2, 300);
    console.log("    tier1/2/3:", (await token.tier1Blocks()).toString(), (await token.tier2Blocks()).toString(), (await token.tier3Blocks()).toString(), "MAX_TIER3:", (await token.MAX_TIER3()).toString());
    const liq = 1_000_000_000n * E18;
    await (await token.approve(await router.getAddress(), liq)).wait();
    await (await router.addLiquidityETH(await token.getAddress(), liq, 0, 0, owner.address, await deadline(), { value: ethers.parseEther("1") })).wait();
    const pairAddr = await factory.getPair(await token.getAddress(), W);
    await (await token.setLp(pairAddr)).wait();
    await (await token.executeTrading()).wait();
    // forward-only (cannot un-mine): G=3 and G=300 inside => 3%/30%, G=301 past => 0/0
    await gotoGuardianBlock(token, 3);
    console.log("    G=3   -> maxWallet", fmt(await token.currentMaxWallet()), "taxBps", (await token.currentSellTaxBps()).toString());
    expect(await token.currentMaxWallet()).to.equal(ONE_PCT * 3n);
    expect(await token.currentSellTaxBps()).to.equal(3000n);
    await gotoGuardianBlock(token, 300);
    console.log("    G=300 -> maxWallet", fmt(await token.currentMaxWallet()), "taxBps", (await token.currentSellTaxBps()).toString());
    expect(await token.currentMaxWallet()).to.equal(ONE_PCT * 3n);
    expect(await token.currentSellTaxBps()).to.equal(3000n);
    await gotoGuardianBlock(token, 301);
    console.log("    G=301 -> maxWallet", fmt(await token.currentMaxWallet()), "taxBps", (await token.currentSellTaxBps()).toString());
    expect(await token.currentMaxWallet()).to.equal(0n);
    expect(await token.currentSellTaxBps()).to.equal(0n);
  });

  it("InvalidTierConfig for bad orderings (and tier3 > MAX)", async function () {
    const [owner] = await ethers.getSigners();
    const Rocket = await ethers.getContractFactory("RocketToken");
    const F = owner.address, W = owner.address; // tier check fires before factory/weth validation
    for (const [t1, t2, t3, label] of [[0, 1, 2, "tier1=0"], [5, 5, 10, "tier2<=tier1"], [5, 10, 10, "tier3<=tier2"], [10, 20, 301, "tier3>MAX"]]) {
      let err = "NO REVERT";
      try { const c = await Rocket.deploy(owner.address, t1, t2, t3, F, W); await c.waitForDeployment(); }
      catch (e) { err = e.shortMessage || e.message.split("\n")[0]; }
      console.log(`    ${label} -> ${err}`);
      await expect(Rocket.deploy(owner.address, t1, t2, t3, F, W)).to.be.revertedWithCustomError(Rocket, "InvalidTierConfig");
    }
    await expect(Rocket.deploy(ethers.ZeroAddress, 10, 20, 30, F, W)).to.be.reverted;
  });
});

// ============================================================================
describe("I. MITIGATION: atomic Launcher", function () {
  it("one-tx launch closes the window; guardian active immediately after", async function () {
    const [owner, bot] = await ethers.getSigners();
    const { factory, weth, router } = await deployVenue(owner);
    const F = await factory.getAddress(), W = await weth.getAddress(), R = await router.getAddress();
    const Launcher = await ethers.getContractFactory("Launcher");
    const launcher = await Launcher.deploy(); await launcher.waitForDeployment();
    const LA = await launcher.getAddress();
    // token owned by launcher (holds supply), with factory+weth for setLp validation
    const token = await deployToken(owner, F, W, 10, 20, 30, LA);
    const tokenAddr = await token.getAddress();
    console.log("    token owner == launcher?", (await token.owner()) === LA);
    console.log("    launcher token balance:", fmt(await token.balanceOf(LA)));
    expect(await token.tradingOpen()).to.equal(false);
    expect(await token.lpPair()).to.equal(ethers.ZeroAddress);

    const liq = 50_000_000_000n * E18;
    await (await launcher.launch(tokenAddr, R, liq, 0, 0, owner.address, { value: ethers.parseEther("10") })).wait();

    const pairAddr = await factory.getPair(tokenAddr, W);
    console.log("    AFTER launch -> tradingOpen:", await token.tradingOpen(), " lpPair:", await token.lpPair(), " guardianBlock:", (await token.guardianBlock()).toString());
    expect(await token.tradingOpen()).to.equal(true);
    expect((await token.lpPair()).toLowerCase()).to.equal(pairAddr.toLowerCase());

    const big2 = await rawRevert(async () =>
      router.connect(bot).swapExactETHForTokens(0, [W, tokenAddr], bot.address, await deadline(), { value: ethers.parseEther("1") })
    );
    console.log("    post-launch big buy (>1%) revert:", JSON.stringify(big2));
    expect(big2.reverted).to.equal(true);

    const before = await token.balanceOf(bot.address);
    await (await router.connect(bot).swapExactETHForTokens(0, [W, tokenAddr], bot.address, await deadline(), { value: ethers.parseEther("0.1") })).wait();
    const got = (await token.balanceOf(bot.address)) - before;
    console.log("    post-launch small buy (<1%) received:", fmt(got), "gBlock:", (await token.guardianBlock()).toString());
    expect(got).to.be.gt(0n);
    expect(got).to.be.lt(ONE_PCT);
  });

  it("setLp before the pair exists reverts InvalidPair (ordering guard)", async function () {
    const [owner] = await ethers.getSigners();
    const { factory, weth } = await deployVenue(owner);
    const F = await factory.getAddress(), W = await weth.getAddress();
    const token = await deployToken(owner, F, W, 10, 20, 30);
    const res = await rawRevert(() => token.setLp(owner.address));
    console.log("    setLp before pair exists:", JSON.stringify(res));
    expect(res.reverted).to.equal(true);
    expect(await token.lpPair()).to.equal(ethers.ZeroAddress);
  });
});
