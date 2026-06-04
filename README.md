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

There are no privileged or exempt addresses. The owner is subject to the exact same rules
as everyone else.

Limits are measured in blocks counted from the block in which trading is opened (the opening
block is block 1) and are enforced automatically inside the ERC20 `_update` hook on every
transfer. The tier thresholds (`tier1`, `tier2`, `tier3`) are set per network at deploy time
and are **immutable** (constructor arguments, cannot be changed).

Max wallet on BUY (transfer from the LP pair):

| Block window        | Max balance per wallet |
| ------------------- | ---------------------- |
| 1 .. tier1          | 1% of total supply     |
| tier1+1 .. tier2    | 2% of total supply     |
| tier2+1 .. tier3    | 3% of total supply     |
| after tier3         | no limit               |

Tax on SELL (transfer to the LP pair). The collected tax is not sent to any wallet, it is
burned (total supply decreases):

| Block window        | Sell tax (burned) |
| ------------------- | ----------------- |
| 1 .. tier1          | 50%               |
| tier1+1 .. tier2    | 40%               |
| tier2+1 .. tier3    | 30%               |
| after tier3         | 0%                |

The tier blocks target roughly 1 min / 2 min / 3 min windows, after which restrictions drop:

| Network            | tier1 | tier2 | tier3 |
| ------------------ | ----- | ----- | ----- |
| Ethereum, Sepolia  | 5     | 10    | 15    |
| Polygon, BNB       | 20    | 40    | 60    |
| Base               | 30    | 60    | 90    |

Before `executeTrading()`, trading against the pair is blocked (any transfer where the pair is
`from` or `to`); normal wallet-to-wallet transfers are allowed. Liquidity is therefore added
while `lpPair` is still unset (see the launch order below).

## Public functions

| Function              | Access                            | Description                                       |
| --------------------- | --------------------------------- | ------------------------------------------------- |
| `setLp(address)`      | onlyOwner, once, nonReentrant     | Sets the LP pair (DEX) address                    |
| `executeTrading()`    | onlyOwner, once, nonReentrant     | Opens trading and starts the guardian timer       |
| `burnRocket(uint256)` | public, nonReentrant              | Burns the caller's own tokens                     |
| `guardianBlock()`     | view                              | Current guardian block (0 if trading is not open) |
| `currentMaxWallet()`  | view                              | Current max wallet on buy (0 means no limit)      |
| `currentSellTaxBps()` | view                              | Current sell tax in basis points (10000 = 100%)   |
| `totalTaxBurned()`    | view                              | Total RCT burned from anti-bot sell taxes         |
| `tier1/2/3Blocks()`   | view (immutable)                  | The per-network tier block thresholds             |

`transfer`, `transferFrom`, `approve`, `burn` and `burnFrom` are reentrancy-guarded. Every
state-changing function emits an event, and every revert uses a named custom error
(`LpAlreadySet`, `LpNotSet`, `TradingAlreadyOpen`, `TradingNotOpen`, `ZeroAddress`,
`MaxWalletExceeded`, `InvalidTierConfig`).

## Constructor

```solidity
constructor(address initialOwner, uint256 tier1Blocks, uint256 tier2Blocks, uint256 tier3Blocks)
```

The deploy script passes the correct per-network tiers automatically. Requires
`0 < tier1 < tier2 < tier3`, otherwise it reverts with `InvalidTierConfig`.

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

## Mainnet fork test

The full lifecycle is covered by an end-to-end test that forks Ethereum mainnet and uses the
real Uniswap V2 router and factory, so no real funds are spent. It exercises: deploy, liquidity
provision and `setLp`, a buy attempt before trading is open (must revert), opening trading, the
tier-1 max-wallet limit, sell taxes (50/40/30%, burned), and normal behaviour after tier3 (no
limit, no tax).

```bash
FORK_URL="https://rpc.ankr.com/eth/<ANKR_KEY>" npx hardhat test test/Fork.ethereum.test.js
```

## Live test on Sepolia

`scripts/sepolia-lifecycle.js` runs the same lifecycle against a contract deployed on Sepolia
using the real Uniswap V2. It generates and funds a fresh trader wallet, exercises the whole
flow (verified against the real block), and sweeps the trader's leftover ETH back. It waits for
real blocks, so it takes a few minutes. `scripts/sepolia-recover.js` withdraws test liquidity
from a deployed token back to the deployer.

```bash
node scripts/sepolia-lifecycle.js          # uses the latest deployed/sepolia_*.json
CONTRACT=0x... node scripts/sepolia-lifecycle.js
```

## Project structure

```
contracts/RocketToken.sol      Token contract with the guardian logic
scripts/rpc.js                 Ankr RPC fallback provider/signer
scripts/deploy.js              Deploy + record + verify
scripts/sepolia-lifecycle.js   Live Sepolia end-to-end test
scripts/sepolia-recover.js     Withdraw test liquidity back to the deployer
test/RocketToken.test.js       Unit tests
test/Fork.ethereum.test.js     Mainnet fork end-to-end test
hardhat.config.js              Networks + Etherscan V2 config
deployed/                      Deployment records (git-ignored)
```

## Launch order

Because there are no privileged addresses, the order matters:

1. Deploy the contract (the deploy script sets the per-network tier blocks).
2. Add liquidity on the DEX (while `lpPair` is still unset) and obtain the pair address.
3. Call `setLp(pair)` (once).
4. Call `executeTrading()` (once) to open trading and start the guardian timer.

## License

MIT - see [LICENSE](LICENSE).
