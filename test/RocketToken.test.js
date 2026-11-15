const { expect } = require("chai");
const { ethers } = require("hardhat");

// Unit tests (no DEX). setLp / guardian / launcher behaviour against a real Uniswap V2 venue
// is covered by test/fixes.test.js and test/audit.test.js.
describe("RocketToken (unit)", function () {
  let token, owner, alice;
  const SUPPLY = ethers.parseUnits("100000000000", 18); // 100B
  const TIERS = [5, 10, 15];
  let F, W; // dummy non-zero factory/weth (these unit tests never call setLp)

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();
    F = owner.address; W = alice.address;
    const Rocket = await ethers.getContractFactory("RocketToken");
    token = await Rocket.deploy(owner.address, ...TIERS, F, W);
    await token.waitForDeployment();
  });

  it("has the correct name, symbol, supply, tiers and MAX_TIER3", async function () {
    expect(await token.name()).to.equal("Rocket");
    expect(await token.symbol()).to.equal("RCT");
    expect(await token.totalSupply()).to.equal(SUPPLY);
    expect(await token.balanceOf(owner.address)).to.equal(SUPPLY);
    expect(await token.tier1Blocks()).to.equal(5n);
    expect(await token.tier2Blocks()).to.equal(10n);
    expect(await token.tier3Blocks()).to.equal(15n);
    expect(await token.MAX_TIER3()).to.equal(300n);
    expect(await token.factory()).to.equal(F);
    expect(await token.weth()).to.equal(W);
  });

  it("rejects an invalid tier config (incl tier3 > MAX_TIER3) and zero factory/weth", async function () {
    const Rocket = await ethers.getContractFactory("RocketToken");
    for (const [t1, t2, t3] of [[0, 10, 15], [5, 5, 15], [5, 10, 10], [5, 10, 301]]) {
      await expect(Rocket.deploy(owner.address, t1, t2, t3, F, W)).to.be.revertedWithCustomError(Rocket, "InvalidTierConfig");
    }
    await expect(Rocket.deploy(owner.address, 5, 10, 15, ethers.ZeroAddress, W)).to.be.revertedWithCustomError(Rocket, "ZeroAddress");
  });

  it("burnRocket reduces supply and emits RocketBurned", async function () {
    const burn = ethers.parseUnits("1000", 18);
    await expect(token.burnRocket(burn)).to.emit(token, "RocketBurned").withArgs(owner.address, burn);
    expect(await token.totalSupply()).to.equal(SUPPLY - burn);
  });
});
