const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RocketToken", function () {
  let token, owner, lp, alice, bob;
  const SUPPLY = ethers.parseUnits("100000000000", 18); // 100B

  beforeEach(async function () {
    [owner, lp, alice, bob] = await ethers.getSigners();
    const Rocket = await ethers.getContractFactory("RocketToken");
    token = await Rocket.deploy(owner.address);
    await token.waitForDeployment();
  });

  it("ima pravilno ime, simvol i supply po deployera", async function () {
    expect(await token.name()).to.equal("Rocket");
    expect(await token.symbol()).to.equal("RCT");
    expect(await token.totalSupply()).to.equal(SUPPLY);
    expect(await token.balanceOf(owner.address)).to.equal(SUPPLY);
  });

  it("setLp i executeTrading se vikat samo vednuj", async function () {
    await expect(token.executeTrading()).to.be.revertedWithCustomError(token, "LpNotSet");
    await token.setLp(lp.address);
    await expect(token.setLp(lp.address)).to.be.revertedWithCustomError(token, "LpAlreadySet");
    await token.executeTrading();
    await expect(token.executeTrading()).to.be.revertedWithCustomError(token, "TradingAlreadyOpen");
  });

  it("ne pozvolyava transfer predi otvarjane (osven exempt)", async function () {
    await token.transfer(alice.address, ethers.parseUnits("1000", 18)); // owner exempt -> ok
    await expect(
      token.connect(alice).transfer(bob.address, ethers.parseUnits("1", 18))
    ).to.be.revertedWithCustomError(token, "TradingNotOpen");
  });

  it("guardian buy nalaga max wallet (1% v parvite 10 bloka)", async function () {
    await token.setLp(lp.address);
    await token.setExempt(lp.address, false); // lp da NE e exempt za da raboti buy logikata
    // dadem na lp tokeni da moje da 'prodava' (simulira pool)
    await token.transfer(lp.address, SUPPLY / 2n); // owner exempt -> minava
    await token.executeTrading();

    const onePercent = SUPPLY / 100n;
    // pokupka tochno na limita -> ok
    await token.connect(lp).transfer(alice.address, onePercent);
    // oshte edna pokupka -> nadvishava 1% -> revert
    await expect(
      token.connect(lp).transfer(alice.address, 1n)
    ).to.be.revertedWithCustomError(token, "MaxWalletExceeded");
  });

  it("guardian sell izgarja 50% taksa v parvite 10 bloka", async function () {
    await token.setLp(lp.address);
    await token.setExempt(lp.address, false);
    await token.executeTrading();

    // dadem na alice tokeni (owner exempt -> bez taksa)
    const amount = ethers.parseUnits("1000", 18);
    await token.transfer(alice.address, amount);

    const supplyBefore = await token.totalSupply();

    // alice prodava (to == lp) -> 50% taksa, koiato se BURNVA
    await token.connect(alice).transfer(lp.address, amount);

    // 50% stiga do LP, 50% e izgoreno (supply namaljava)
    expect(await token.balanceOf(lp.address)).to.equal(amount / 2n);
    expect(await token.totalSupply()).to.equal(supplyBefore - amount / 2n);
    expect(await token.totalTaxBurned()).to.equal(amount / 2n);
  });

  it("burnRocket namaljava supply", async function () {
    const burn = ethers.parseUnits("1000", 18);
    await token.burnRocket(burn);
    expect(await token.totalSupply()).to.equal(SUPPLY - burn);
  });
});
