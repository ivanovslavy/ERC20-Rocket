const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RocketToken", function () {
  let token, owner, lp, alice, bob;
  const SUPPLY = ethers.parseUnits("100000000000", 18); // 100B
  const TIERS = [5, 10, 15];

  beforeEach(async function () {
    [owner, lp, alice, bob] = await ethers.getSigners();
    const Rocket = await ethers.getContractFactory("RocketToken");
    token = await Rocket.deploy(owner.address, ...TIERS);
    await token.waitForDeployment();
  });

  it("has the correct name, symbol, supply and immutable tiers", async function () {
    expect(await token.name()).to.equal("Rocket");
    expect(await token.symbol()).to.equal("RCT");
    expect(await token.totalSupply()).to.equal(SUPPLY);
    expect(await token.balanceOf(owner.address)).to.equal(SUPPLY);
    expect(await token.tier1Blocks()).to.equal(5n);
    expect(await token.tier2Blocks()).to.equal(10n);
    expect(await token.tier3Blocks()).to.equal(15n);
  });

  it("the constructor rejects an invalid tier config", async function () {
    const Rocket = await ethers.getContractFactory("RocketToken");
    await expect(Rocket.deploy(owner.address, 0, 10, 15)).to.be.revertedWithCustomError(
      Rocket,
      "InvalidTierConfig"
    );
    await expect(Rocket.deploy(owner.address, 5, 5, 15)).to.be.revertedWithCustomError(
      Rocket,
      "InvalidTierConfig"
    );
    await expect(Rocket.deploy(owner.address, 5, 10, 10)).to.be.revertedWithCustomError(
      Rocket,
      "InvalidTierConfig"
    );
  });

  it("setLp and executeTrading can only be called once", async function () {
    await expect(token.executeTrading()).to.be.revertedWithCustomError(token, "LpNotSet");
    await token.setLp(lp.address);
    await expect(token.setLp(lp.address)).to.be.revertedWithCustomError(token, "LpAlreadySet");
    await token.executeTrading();
    await expect(token.executeTrading()).to.be.revertedWithCustomError(token, "TradingAlreadyOpen");
  });

  it("before open: blocks trading against the pair, but allows normal transfers", async function () {
    // owner -> lp BEFORE setLp (lpPair = 0) -> allowed
    await token.transfer(lp.address, ethers.parseUnits("1000000000", 18));
    await token.setLp(lp.address);
    // now trading against the pair (before open) reverts
    await expect(token.connect(lp).transfer(alice.address, 1n)).to.be.revertedWithCustomError(
      token,
      "TradingNotOpen"
    );
    // a normal (non-pair) transfer still goes through
    await token.transfer(bob.address, ethers.parseUnits("100", 18));
    expect(await token.balanceOf(bob.address)).to.equal(ethers.parseUnits("100", 18));
  });

  it("guardian buy enforces the max wallet (1% in tier 1) - the owner is not exempt", async function () {
    await token.transfer(lp.address, SUPPLY / 2n); // owner -> lp before setLp
    await token.setLp(lp.address);
    await token.executeTrading();

    const onePercent = SUPPLY / 100n;
    await token.connect(lp).transfer(alice.address, onePercent); // buy exactly at the limit
    await expect(
      token.connect(lp).transfer(alice.address, 1n)
    ).to.be.revertedWithCustomError(token, "MaxWalletExceeded");
  });

  it("guardian sell burns the 50% tax in tier 1", async function () {
    const amount = ethers.parseUnits("1000", 18);
    await token.transfer(alice.address, amount); // owner -> alice before setLp
    await token.setLp(lp.address);
    await token.executeTrading();

    const supplyBefore = await token.totalSupply();
    await token.connect(alice).transfer(lp.address, amount); // sell -> 50% burn

    expect(await token.balanceOf(lp.address)).to.equal(amount / 2n);
    expect(await token.totalSupply()).to.equal(supplyBefore - amount / 2n);
    expect(await token.totalTaxBurned()).to.equal(amount / 2n);
  });

  it("burnRocket reduces the supply", async function () {
    const burn = ethers.parseUnits("1000", 18);
    await token.burnRocket(burn);
    expect(await token.totalSupply()).to.equal(SUPPLY - burn);
  });
});
