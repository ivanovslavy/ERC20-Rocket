const { ethers, network } = require("hardhat");
const { deployVenue } = require("./uniswap");
const E18 = 10n ** 18n;
const deadline = async () => (await ethers.provider.getBlock("latest")).timestamp + 3600;

describe("Snipe repro (live order: fund snipers BEFORE launch, then snipe at guardianBlock 1)", function () {
  this.timeout(180000);

  async function makeSnipers(funder, n) {
    const ws = [];
    for (let i = 0; i < n; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await (await funder.sendTransaction({ to: w.address, value: ethers.parseEther("0.06") })).wait();
      ws.push(w);
    }
    return ws;
  }

  it("СВАРМ в ЕДИН блок при guardianBlock 1 (cap 1B)", async function () {
    const [deployer] = await ethers.getSigners();
    const { factory, weth, router } = await deployVenue(deployer);
    const F = await factory.getAddress(), W = await weth.getAddress(), R = await router.getAddress();
    // 1) ФИНАНСИРАЙ снайперите ПЪРВО (както в живота: 01 преди 04-launch)
    const snipers = await makeSnipers(deployer, 40);
    // 2) деплой + АТОМАРНО пускане (100B/5ETH)
    const Launcher = await ethers.getContractFactory("Launcher");
    const launcher = await Launcher.deploy(); await launcher.waitForDeployment();
    const LA = await launcher.getAddress();
    const Rocket = await ethers.getContractFactory("RocketToken");
    const token = await Rocket.deploy(LA, 5, 10, 15, F, W); await token.waitForDeployment();
    const TA = await token.getAddress();
    await (await launcher.launch(TA, R, 100_000_000_000n * E18, 0, 0, deployer.address, { value: ethers.parseEther("5") })).wait();

    const dl = await deadline();
    console.log("    guardianBlock:", Number(await token.guardianBlock()), "· maxWallet:", (Number(await token.currentMaxWallet()) / 1e18 / 1e9).toFixed(3) + "B · първа 0.05 покупка дава ~" + (Number((await router.getAmountsOut(ethers.parseEther("0.05"), [W, TA]))[1]) / 1e18 / 1e9).toFixed(4) + "B");

    await network.provider.send("evm_setAutomine", [false]);
    const sent = [];
    for (const w of snipers) {
      try { const tx = await router.connect(w).swapExactETHForTokensSupportingFeeOnTransferTokens(0, [W, TA], w.address, dl, { value: ethers.parseEther("0.05"), gasLimit: 400000 }); sent.push({ tx, sendErr: null }); }
      catch (e) { sent.push({ tx: null, sendErr: (e.shortMessage || e.message || "").slice(0, 70) }); }
    }
    await network.provider.send("evm_mine");
    await network.provider.send("evm_setAutomine", [true]);
    let ok = 0, rev = 0, sf = 0; const reasons = {};
    for (const s of sent) {
      if (s.sendErr) { sf++; reasons["send:" + s.sendErr] = (reasons["send:" + s.sendErr] || 0) + 1; continue; }
      const rc = await ethers.provider.getTransactionReceipt(s.tx.hash);
      if (rc && rc.status === 1) ok++; else { rev++; reasons["onchain-revert"] = (reasons["onchain-revert"] || 0) + 1; }
    }
    console.log("    СВАРМ-1-блок:", ok, "минаха ·", rev, "on-chain реверт ·", sf, "estimateGas/send падна");
    console.log("    причини:", JSON.stringify(reasons, null, 0));
  });
});
