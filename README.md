# Rocket Token (RCT)

An ERC20 token with on-chain anti-bot ("guardian") policies for a controlled DEX launch.
Built with Hardhat and OpenZeppelin v5.

## Overview

- Name / symbol: `Rocket` / `RCT`, 18 decimals
- Total supply: 100,000,000,000 RCT, fully minted to the deployer at construction
- Base: ERC20, ERC20Burnable, Ownable, ReentrancyGuard (OpenZeppelin v5)
- Solidity 0.8.24, optimizer enabled (200 runs)
- Main contract: `contracts/RocketToken.sol`

## Anti-bot policies

All limits are measured in blocks counted from the block in which trading is opened
(the opening block is block 1). They are enforced automatically inside the ERC20
`_update` hook on every transfer.

Max wallet on BUY (transfer from the LP pair):

| Blocks after open | Max balance per wallet |
| ----------------- | ---------------------- |
| 1 - 10            | 1% of total supply     |
| 11 - 20           | 2% of total supply     |
| 21 - 30           | 3% of total supply     |
| from 31           | no limit               |

Tax on SELL (transfer to the LP pair). The collected tax is not sent to any wallet,
it is burned (total supply decreases):

| Blocks after open | Sell tax (burned) |
| ----------------- | ----------------- |
| 1 - 10            | 50%               |
| 11 - 20           | 40%               |
| 21 - 30           | 30%               |
| from 31           | 0%                |

Exempt addresses (owner, the contract itself, and any address added via `setExempt`)
bypass all restrictions. Before trading is opened, only exempt addresses can move tokens.

## Public functions

| Function                  | Access                     | Description                                            |
| ------------------------- | -------------------------- | ------------------------------------------------------ |
| `setLp(address)`          | onlyOwner, once            | Sets the LP pair (DEX) address                         |
| `executeTrading()`        | onlyOwner, once            | Opens trading and starts the guardian timer            |
| `setExempt(address,bool)` | onlyOwner                  | Adds/removes an address from the exemption list        |
| `burnRocket(uint256)`     | public, nonReentrant       | Burns the caller's own tokens                          |
| `guardianBlock()`         | view                       | Current guardian block (0 if trading is not open)      |
| `currentMaxWallet()`      | view                       | Current max wallet on buy (0 means no limit)           |
| `currentSellTaxBps()`     | view                       | Current sell tax in basis points (10000 = 100%)        |
| `totalTaxBurned()`        | view                       | Total RCT burned from anti-bot sell taxes              |

## Requirements

- Node.js 18+ (tested on Node 22)
- npm

## Download and install

```bash
git clone git@github.com:ivanovslavy/ERC20-Rocket.git
cd ERC20-Rocket
npm install
```

## Configuration

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

- `PRIVATE_KEY` - deployer private key
- `ANKR_API_KEYS` - comma-separated Ankr API keys. The RPC layer tries them in order;
  if one endpoint fails it automatically falls back to the next (`scripts/rpc.js`).
- `ETHEREUM_RPC_URL`, `SEPOLIA_RPC_URL`, ... - optional explicit RPC overrides (take
  priority over Ankr).
- `ETHERSCAN_API_KEY` - a single Etherscan API V2 key, which covers all supported
  chains (Ethereum, Sepolia, Base, BNB Chain, Polygon).
- `FORK_URL` - RPC used for the mainnet fork test (defaults to the first Ankr key).

The `.env` file is git-ignored and must never be committed.

## Usage

```bash
npm run compile                 # compile contracts
npm test                        # run unit tests
npx hardhat node                # start a local node

# Deploy (deploys, saves a record under deployed/, then verifies)
npm run deploy:localhost
npm run deploy:sepolia
npm run deploy:ethereum
npm run deploy:base
npm run deploy:bnb
npm run deploy:polygon
```

Each deployment writes a record to `deployed/<network>_<date-time>.json` containing the
address, chain id, deployer, tx hash and constructor arguments. Verification runs
automatically for every network except `localhost` / `hardhat`.

## Deployments

| Network | Address | Explorer |
| ------- | ------- | -------- |
| Sepolia | `0x69dC03236b1ee798C336a51Df78DcA3EA32a0258` | [verified source](https://sepolia.etherscan.io/address/0x69dC03236b1ee798C336a51Df78DcA3EA32a0258#code) |

## Live test on Sepolia

`scripts/sepolia-lifecycle.js` runs the full lifecycle against the deployed contract on
Sepolia using the real Uniswap V2. It generates and funds a fresh non-exempt trader,
exercises add-liquidity, `setLp`, buy-before-open (revert), `executeTrading`, the tier-1
max-wallet limit, sell taxes across tiers (verified against the real block), and normal
behaviour after block 30, then sweeps the trader's leftover ETH back. It waits for real
blocks, so it takes a few minutes.

```bash
node scripts/sepolia-lifecycle.js          # uses the latest deployed/sepolia_*.json
CONTRACT=0x... node scripts/sepolia-lifecycle.js
```

## Mainnet fork test

The full lifecycle is covered by an end-to-end test that forks Ethereum mainnet and uses
the real Uniswap V2 router and factory, so no real funds are spent. It exercises: deploy,
liquidity provision and `setLp`, a buy attempt before trading is open (must revert),
opening trading, the tier-1 max-wallet limit, sell taxes (50/40/30%, burned), and normal
behaviour after block 30 (no limit, no tax).

```bash
FORK_URL="https://rpc.ankr.com/eth/<ANKR_KEY>" npx hardhat test test/Fork.ethereum.test.js
```

## Project structure

```
contracts/RocketToken.sol      Token contract with the guardian logic
scripts/rpc.js                 Ankr RPC fallback provider/signer
scripts/deploy.js              Deploy + record + verify
test/RocketToken.test.js       Unit tests
test/Fork.ethereum.test.js     Mainnet fork end-to-end test
hardhat.config.js              Networks + Etherscan V2 config
deployed/                      Deployment records (git-ignored)
```

## Launch order

1. Deploy the contract.
2. Add liquidity on the DEX and obtain the LP pair address.
3. Call `setLp(pair)` (once).
4. Call `executeTrading()` (once) to open trading and start the guardian timer.

## License

MIT - see [LICENSE](LICENSE).
