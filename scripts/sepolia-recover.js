/**
 * Recover liquidity from the Sepolia test token back to the deployer.
 * Removes all of the deployer's LP from the RCT/WETH pair and reports ETH balances
 * before and after to confirm the ETH was recovered.
 *
 * Run: node scripts/sepolia-recover.js
 */
require("dotenv").config();
const { ethers } = require("ethers");
const { makeProvider } = require("./rpc");

const TOKEN = "0x69dC03236b1ee798C336a51Df78DcA3EA32a0258";
const PAIR = "0xE8b60E062DECa3a0dC5D5fCfDc3B5c5767b437Ff";
const ROUTER = "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3";
const TRADER = "0x35e400ACA4eCa57f53d397a336f66df40A98a9bf"; // ephemeral trader from the previous run

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const ROUTER_ABI = [
  "function removeLiquidityETH(address token, uint liquidity, uint amountTokenMin, uint amountETHMin, address to, uint deadline) returns (uint amountToken, uint amountETH)",
];

async function main() {
  const provider = makeProvider("sepolia");
  const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const pair = new ethers.Contract(PAIR, ERC20_ABI, deployer);
  const token = new ethers.Contract(TOKEN, ERC20_ABI, provider);
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, deployer);

  const ethBefore = await provider.getBalance(deployer.address);
  const lpBal = await pair.balanceOf(deployer.address);
  const rctBefore = await token.balanceOf(deployer.address);

  console.log("Deployer:", deployer.address);
  console.log("ETH before:", ethers.formatEther(ethBefore));
  console.log("LP balance:", lpBal.toString());
  console.log("RCT before:", ethers.formatUnits(rctBefore, 18));

  if (lpBal > 0n) {
    console.log("\nApproving LP to router...");
    await (await pair.approve(ROUTER, lpBal)).wait();
    console.log("Removing liquidity...");
    await (
      await router.removeLiquidityETH(TOKEN, lpBal, 0, 0, deployer.address, 9999999999n)
    ).wait();
  } else {
    console.log("\nNo LP to remove.");
  }

  const ethAfter = await provider.getBalance(deployer.address);
  const rctAfter = await token.balanceOf(deployer.address);

  console.log("\nETH after:", ethers.formatEther(ethAfter));
  console.log("RCT after:", ethers.formatUnits(rctAfter, 18));
  console.log("ETH delta:", ethers.formatEther(ethAfter - ethBefore), "(net of gas)");

  // Read-only report on the ephemeral trader (its private key was random and not saved,
  // so its leftover dust is not recoverable; the ETH was already swept at the end of the
  // lifecycle run).
  const trEth = await provider.getBalance(TRADER);
  const trRct = await token.balanceOf(TRADER);
  console.log("\nEphemeral trader", TRADER);
  console.log("  ETH:", ethers.formatEther(trEth), "(key lost - not recoverable)");
  console.log("  RCT:", ethers.formatUnits(trRct, 18), "(test tokens, key lost)");
}

main().catch((e) => {
  console.error("FAILED:", e.message || e);
  process.exit(1);
});
