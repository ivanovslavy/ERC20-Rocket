const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { makeSigner } = require("./rpc");

/**
 * Deploy script za RocketToken.
 *  - deplova kontrakta s deployera kato initialOwner
 *  - polzva RPC fallback (Ankr klyuchove) za jivi mreji
 *  - zapisva deploy info v ./deployed/<network>_<data-chas>.json
 *  - pravi verifikacia (osven na localhost/hardhat)
 *
 * Upotreba:
 *   npx hardhat run scripts/deploy.js --network <localhost|sepolia|ethereum|base|bnb|polygon>
 */

// Za jivi mreji - signer s RPC fallback; za lokalni - vgradeniat hardhat signer.
async function getDeploySigner(network) {
  if (network === "localhost" || network === "hardhat") {
    const [s] = await hre.ethers.getSigners();
    return s;
  }
  return makeSigner(network);
}

async function main() {
  const network = hre.network.name;
  const deployer = await getDeploySigner(network);

  const balance = await deployer.provider.getBalance(deployer.address);
  console.log("====================================================");
  console.log(` Network : ${network}`);
  console.log(` Deployer: ${deployer.address}`);
  console.log(` Balance : ${hre.ethers.formatEther(balance)} (native)`);
  console.log("====================================================");

  // --- Deploy ---
  const Rocket = await hre.ethers.getContractFactory("RocketToken", deployer);
  const rocket = await Rocket.deploy(deployer.address);
  await rocket.waitForDeployment();

  const address = await rocket.getAddress();
  const deployTx = rocket.deploymentTransaction();
  const net = await deployer.provider.getNetwork();

  console.log(`\n RocketToken (RCT) deployed at: ${address}`);
  console.log(` Tx hash: ${deployTx ? deployTx.hash : "n/a"}`);

  // --- Zapis na deploy info ---
  const now = new Date();
  const stamp = now.toISOString().replace(/:/g, "-").replace(/\..+$/, ""); // YYYY-MM-DDTHH-MM-SS
  const dir = path.join(__dirname, "..", "deployed");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const info = {
    network,
    chainId: Number(net.chainId),
    contract: "RocketToken",
    name: "Rocket",
    symbol: "RCT",
    maxSupply: "100000000000",
    address,
    deployer: deployer.address,
    txHash: deployTx ? deployTx.hash : null,
    timestamp: now.toISOString(),
    constructorArgs: [deployer.address],
  };

  const file = path.join(dir, `${network}_${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(info, null, 2));
  console.log(` Deploy info zapisan: ${path.relative(process.cwd(), file)}`);

  // --- Verifikacia ---
  if (network === "localhost" || network === "hardhat") {
    console.log("\n Lokalna mreja - propuskame verifikaciata.");
    return;
  }

  console.log("\n Chakame 5 potvurjdenia predi verifikacia...");
  if (deployTx) await deployTx.wait(5);

  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments: [deployer.address],
    });
    console.log(" Verifikaciata uspeshna.");
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (msg.toLowerCase().includes("already verified")) {
      console.log(" Kontraktat veche e verificiran.");
    } else {
      console.error(" Verifikaciata ne uspja:", msg);
      console.error(" Mojesh da ja pusnesh rachno sas:");
      console.error(`   npx hardhat verify --network ${network} ${address} ${deployer.address}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
