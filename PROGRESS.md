# PROGRESS.md — Rocket Token (RCT)

Progress and change log. The newest entry is at the top.

---

## 2026-06-04 — Official Sepolia deployment + live lifecycle test

**Done:**
- Deployed the official contract to **Sepolia** and **verified** it on Etherscan:
  - Address: `0x69dC03236b1ee798C336a51Df78DcA3EA32a0258`
  - https://sepolia.etherscan.io/address/0x69dC03236b1ee798C336a51Df78DcA3EA32a0258#code
  - Record: `deployed/sepolia_2026-06-04T04-07-25.json`
  - Deploy used the Ankr RPC fallback signer; verification used the Etherscan V2 key.
- Added `scripts/sepolia-lifecycle.js` — a live end-to-end test on Sepolia using the real
  Uniswap V2 (router `0xeE56...CfE3`, factory `0xF62c...80E6`, WETH `0xfFf9...6B14`). Since
  the deployer is exempt, the script generates and funds a fresh non-exempt trader wallet,
  then sweeps the leftover ETH back at the end.
- **Ran the full lifecycle against live Sepolia — all checks passed:**
  - metadata + 100B supply; guardian views 0 before open.
  - add liquidity (10B RCT + 0.3 ETH) + `setLp` (+ once-only revert).
  - buy before open -> reverted; `executeTrading` (+ once-only revert).
  - tier 1: small buy ~163.4M RCT (< 1%) OK; big buy (>1%) reverted (max wallet).
  - sell taxes, asserted against the real block: guardian block 4 -> 50% (10M burned),
    block 12 -> 40% (8M), block 22 -> 30% (6M).
  - after block 30 (block 32): sell with no tax / no burn.
- Final on-chain state: `totalTaxBurned` = 24,000,000 RCT, `totalSupply` = 99,976,000,000 RCT.
- LP pair on Sepolia: `0xE8b60E062DECa3a0dC5D5fCfDc3B5c5767b437Ff`.

---

## 2026-06-04 — Auto-burn taxes, RPC fallback, fork test, README/LICENSE, GitHub

**Done:**
- **Contract change:** anti-bot sell taxes are now **burned automatically** (transferred to `address(0)`, reducing total supply) instead of being sent to a wallet. Removed `taxWallet` / `setTaxWallet`. Added `totalTaxBurned` and the `AntiBotTaxBurned` event.
- **RPC fallback** (`scripts/rpc.js`): ethers `FallbackProvider` over the Ankr keys from `ANKR_API_KEYS` (priority order, quorum 1) — if one RPC fails it moves to the next. Per-chain Ankr paths + chainId.
- `.env` created with the real keys (deployer PK, 5 Ankr keys, Etherscan/BscScan/PolygonScan). `.gitignore` excludes `.env`, `node_modules/`, `deployed/`, `artifacts/`, `cache/`.
- `hardhat.config.js`: RPC URLs are taken from Ankr (or an explicit override), added mainnet `forking`. Etherscan API V2 (single key).
- `scripts/deploy.js`: uses the fallback signer (`makeSigner`) for live networks.
- **Fork test** (`test/Fork.ethereum.test.js`): forks Ethereum mainnet with the real Uniswap V2. Covers: deploy -> add liquidity + setLp -> buy before open (revert) -> executeTrading -> tier 1 max wallet -> sell taxes 50/40/30% (burned) -> after block 30 no limit/tax. **All 6 steps passed against the real fork.**
- `README.md` (English) + `LICENSE` (MIT).
- Unit tests updated for the burn logic; all 6 pass.

**Fork test results (real mainnet fork):**
- buyer1 bought ~99.2M RCT (< 1%) — OK; a large buy >1% reverted.
- Burned taxes: block 5 -> 50% (5M), block 15 -> 40% (4M), block 25 -> 30% (3M).
- After block 30: a >1% buy went through (3.3B RCT), a sell had no tax/burn.

**Security note:** the keys shared in chat (especially the deployer PK) should be treated as potentially compromised — rotation is recommended before mainnet use with real funds. (Owner will rotate before the official mainnet launch.)

---

## 2026-06-04 — Initial project setup

**Done:**
- Created the Hardhat project structure in `~/Rocket-Token`.
- `contracts/RocketToken.sol` — ERC20 (Rocket/RCT), ERC20Burnable, Ownable, ReentrancyGuard (OZ v5):
  - Supply 100B, minted to the deployer in the constructor.
  - `setLp()` and `executeTrading()` — onlyOwner, once only.
  - `setExempt()` — owner management.
  - `burnRocket()` — public burn (nonReentrant).
  - Guardian logic in `_update()`: max wallet on buy (1%/2%/3% for blocks 1-10/11-20/21-30), sell tax (50%/40%/30%), removed from block 31.
  - View helpers: `guardianBlock()`, `currentMaxWallet()`, `currentSellTaxBps()`.
- `hardhat.config.js` — Solidity 0.8.24, optimizer; networks: localhost, sepolia, ethereum, base, bnb, polygon; Etherscan API V2 (single string key).
- `scripts/deploy.js` — deploy + record in `deployed/<network>_<date-time>.json` + automatic verification (except locally).
- `test/RocketToken.test.js` — tests for supply, once-only guards, max wallet, sell tax, burn.
- `.env.example`, `.gitignore`, `package.json`.
- `CLAUDE.md` — documentation and working rules.

**Decisions / notes:**
- The function names are camelCase (Solidity convention) with exactly the described logic.
- Guardian buy/sell are implemented as internal logic in `_update()`, not as separate external functions — so they act automatically on every DEX transfer.
