# CLAUDE.md — Rocket Token (RCT)

This file instructs Claude Code (and any developer) how to work on this project.

## Project

Hardhat project for the ERC20 token **Rocket (RCT)** with on-chain anti-bot "guardian"
policies for a controlled DEX launch.

- **Token:** Rocket / RCT
- **Standard:** ERC20, ERC20Burnable, Ownable, ReentrancyGuard (OpenZeppelin v5)
- **Supply:** 100,000,000,000 RCT (100B), 18 decimals, fully minted to the deployer on deploy
- **Solidity:** 0.8.24, optimizer on (runs=200)
- **Main contract:** `contracts/RocketToken.sol`

## Functionality / anti-bot policies

| Function | Access | Description |
|---|---|---|
| `setLp(address)` | onlyOwner, **once** | Sets the LP pair (DEX) address |
| `executeTrading()` | onlyOwner, **once** | Opens trading, starts the guardian timer (requires LP set) |
| `setExempt(address,bool)` | onlyOwner | Exempts an address from the restrictions (router, treasury...) |
| `burnRocket(uint256)` | public, nonReentrant | Burns the caller's own tokens |

The **guardian logic** runs automatically inside `_update()` (OZ v5 hook), counted from
the block trading is opened (the opening block is block 1):

- **BUY (from == lpPair)** — max wallet balance:
  - block 1-10 → 1% of supply
  - block 11-20 → 2%
  - block 21-30 → 3%
  - from block 31 → no limit
- **SELL (to == lpPair)** — tax that is **burned automatically** (reduces total supply,
  nobody collects it):
  - block 1-10 → 50%
  - block 11-20 → 40%
  - block 21-30 → 30%
  - from block 31 → 0%

`totalTaxBurned` tracks the total RCT burned from taxes.

Exempt addresses (owner, the contract, and anything added via `setExempt`) bypass all
restrictions. Before `executeTrading()`, only exempt addresses can send tokens.

## Commands

```bash
npm install                       # install dependencies
npx hardhat compile               # compile
npx hardhat test                  # tests
npx hardhat node                  # local chain
npm run deploy:localhost          # deploy locally
npm run deploy:sepolia            # deploy + verify on Sepolia
npm run deploy:ethereum           # ... ethereum / base / bnb / polygon
```

Deployment info is written automatically to `deployed/<network>_<date-time>.json`.

Mainnet fork test:

```bash
FORK_URL="https://rpc.ankr.com/eth/<ANKR_KEY>" npx hardhat test test/Fork.ethereum.test.js
```

## Configuration

- Copy `.env.example` -> `.env` and fill in `PRIVATE_KEY`, `ANKR_API_KEYS`, the RPC URLs
  and `ETHERSCAN_API_KEY`.
- **RPC fallback:** `scripts/rpc.js` builds an ethers `FallbackProvider` over the Ankr
  keys; if one endpoint fails it moves to the next.
- **Etherscan API V2:** a single API key works for all chains (Ethereum, Sepolia, Base,
  Polygon, BNB). In `hardhat.config.js` `etherscan.apiKey` is a **string**, not an object.

## Working rules (IMPORTANT)

1. **Always update `PROGRESS.md`** after every change — a new entry with the date, what
   was done and why.
2. **All documentation is written in English** (README, CLAUDE.md, PROGRESS.md, code
   comments where reasonable).
3. **Never commit `.env`** or real private keys. Only `.env.example`.
4. After changes under `contracts/` — always run `npx hardhat compile` and
   `npx hardhat test` before considering it done.
5. Keep `setLp` / `executeTrading` "once only" — do not remove the guard flags.
6. When changing anti-bot parameters (percentages/taxes/blocks), document them in both
   `CLAUDE.md` and `PROGRESS.md`.
7. Do not delete files from `deployed/` — that is the deployment history.
8. Network names in the config (`ethereum`, `bnb`...) must match those in the
   `package.json` scripts.
9. Before a mainnet deploy — test on `localhost` and `sepolia` first.
