const { ethers } = require("hardhat");
const FactoryArt = require("@uniswap/v2-core/build/UniswapV2Factory.json");
const RouterArt  = require("@uniswap/v2-periphery/build/UniswapV2Router02.json");
const WETHArt    = require("@uniswap/v2-periphery/build/WETH9.json");
const PairArt    = require("@uniswap/v2-core/build/UniswapV2Pair.json");

async function deployVenue(deployer) {
  const Factory = new ethers.ContractFactory(FactoryArt.abi, FactoryArt.bytecode, deployer);
  const factory = await Factory.deploy(deployer.address); // feeToSetter
  await factory.waitForDeployment();

  const WETH = new ethers.ContractFactory(WETHArt.abi, WETHArt.bytecode, deployer);
  const weth = await WETH.deploy();
  await weth.waitForDeployment();

  const Router = new ethers.ContractFactory(RouterArt.abi, RouterArt.bytecode, deployer);
  const router = await Router.deploy(await factory.getAddress(), await weth.getAddress());
  await router.waitForDeployment();

  return { factory, weth, router };
}

function pairAt(addr, signer) {
  return new ethers.Contract(addr, PairArt.abi, signer);
}

module.exports = { deployVenue, pairAt, PairArt };
