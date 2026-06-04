// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RocketToken (RCT)
 * @notice Standard ERC20 with anti-bot "guardian" policies for a controlled launch.
 *
 *  - ERC20 + ERC20Burnable + Ownable + ReentrancyGuard (OpenZeppelin v5)
 *  - Supply: 100,000,000,000 RCT (100B), fully minted to the deployer
 *  - There are NO exempt/privileged addresses: the owner is subject to the exact same
 *    guardian rules as everyone else.
 *  - setLp()          -> sets the LP pair address (once only, onlyOwner)
 *  - executeTrading() -> opens trading (once only, onlyOwner)
 *  - guardian buy/sell -> enforced automatically inside _update() on every transfer
 *  - burnRocket()     -> public burn of own tokens
 *
 *  Restriction tiers are measured in blocks from the opening block (opening block = 1)
 *  and are set per network at deploy time via the constructor (immutable, unchangeable).
 *  The intent is roughly 1 min / 2 min / 3 min windows, after which restrictions drop:
 *    Max wallet on BUY (from == lpPair):
 *      blocks 1..tier1            -> 1% of total supply / wallet
 *      blocks tier1+1..tier2      -> 2% / wallet
 *      blocks tier2+1..tier3      -> 3% / wallet
 *      after tier3                -> no limit
 *    Tax on SELL (to == lpPair) - collected tax is BURNED automatically:
 *      blocks 1..tier1            -> 50%
 *      blocks tier1+1..tier2      -> 40%
 *      blocks tier2+1..tier3      -> 30%
 *      after tier3                -> 0%
 *
 *  Launch order (no privileged addresses, so order matters):
 *    1) add liquidity (while lpPair is still unset) 2) setLp 3) executeTrading
 *
 *  REQUIRED VENUE: a Uniswap V2 (or V2-style) liquidity pair is MANDATORY. The guardian
 *  buy/sell detection (from/to == lpPair) and the fee-on-transfer sell-tax burn only work on
 *  V2-style pools, which hold the token as a plain ERC20 balance and support
 *  fee-on-transfer swaps. Uniswap V3/V4 are NOT supported: V3 reverts fee-on-transfer swaps
 *  (the swap callback requires the exact input amount, 'IIA'), and V4 keeps liquidity in a
 *  singleton PoolManager, so `lpPair` detection does not apply. `setLp` must point to a
 *  V2-style pair address.
 */
contract RocketToken is ERC20, ERC20Burnable, Ownable, ReentrancyGuard {
    /// @notice Maximum (and initial) supply: 100 billion RCT.
    uint256 public constant MAX_SUPPLY = 100_000_000_000 * 1e18;

    /// @notice Basis points base (10000 = 100%).
    uint256 public constant BPS = 10_000;

    /// @notice Block thresholds for the three restriction tiers (immutable, set at deploy).
    uint256 public immutable tier1Blocks;
    uint256 public immutable tier2Blocks;
    uint256 public immutable tier3Blocks;

    /// @notice Whether trading is open.
    bool public tradingOpen;

    /// @notice Internal flag whether the LP has already been set.
    bool private _lpSet;

    /// @notice The liquidity pair address (DEX LP CA).
    address public lpPair;

    /// @notice Block number at which trading was opened.
    uint256 public tradingOpenBlock;

    /// @notice Total RCT burned from anti-bot sell taxes.
    uint256 public totalTaxBurned;

    event TokenLaunched(
        address indexed owner,
        uint256 supply,
        uint256 tier1Blocks,
        uint256 tier2Blocks,
        uint256 tier3Blocks
    );
    event LpSet(address indexed lpPair);
    event TradingOpened(uint256 indexed blockNumber);
    event RocketBurned(address indexed from, uint256 amount);
    event AntiBotTaxBurned(address indexed from, uint256 amount);

    error LpAlreadySet();
    error LpNotSet();
    error TradingAlreadyOpen();
    error TradingNotOpen();
    error ZeroAddress();
    error MaxWalletExceeded();
    error InvalidTierConfig();

    /**
     * @param initialOwner Address that receives the whole supply and becomes owner.
     * @param _tier1Blocks Block count for tier 1 (must be > 0).
     * @param _tier2Blocks Block count for tier 2 (must be > tier1).
     * @param _tier3Blocks Block count for tier 3 (must be > tier2).
     */
    constructor(
        address initialOwner,
        uint256 _tier1Blocks,
        uint256 _tier2Blocks,
        uint256 _tier3Blocks
    ) ERC20("Rocket", "RCT") Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (_tier1Blocks == 0 || _tier2Blocks <= _tier1Blocks || _tier3Blocks <= _tier2Blocks) {
            revert InvalidTierConfig();
        }

        tier1Blocks = _tier1Blocks;
        tier2Blocks = _tier2Blocks;
        tier3Blocks = _tier3Blocks;

        _mint(initialOwner, MAX_SUPPLY);
        emit TokenLaunched(initialOwner, MAX_SUPPLY, _tier1Blocks, _tier2Blocks, _tier3Blocks);
    }

    // ----------------------------------------------------------------
    //  Owner controls
    // ----------------------------------------------------------------

    /**
     * @notice Sets the LP pair address. Can be called ONLY ONCE.
     * @dev MUST be a Uniswap V2 (or V2-style) pair. V3/V4 are not supported - see the
     *      contract-level notes.
     */
    function setLp(address _lpPair) external onlyOwner nonReentrant {
        if (_lpSet) revert LpAlreadySet();
        if (_lpPair == address(0)) revert ZeroAddress();
        lpPair = _lpPair;
        _lpSet = true;
        emit LpSet(_lpPair);
    }

    /**
     * @notice Opens trading and starts the guardian timer. Can be called ONLY ONCE.
     * @dev Requires the LP to have been set.
     */
    function executeTrading() external onlyOwner nonReentrant {
        if (tradingOpen) revert TradingAlreadyOpen();
        if (!_lpSet) revert LpNotSet();
        tradingOpen = true;
        tradingOpenBlock = block.number;
        emit TradingOpened(block.number);
    }

    // ----------------------------------------------------------------
    //  Burn
    // ----------------------------------------------------------------

    /**
     * @notice Burns `amount` tokens from the caller. Reduces total supply.
     */
    function burnRocket(uint256 amount) external nonReentrant {
        _burn(_msgSender(), amount);
        emit RocketBurned(_msgSender(), amount);
    }

    /// @dev ERC20Burnable.burn with a reentrancy guard.
    function burn(uint256 value) public override nonReentrant {
        super.burn(value);
    }

    /// @dev ERC20Burnable.burnFrom with a reentrancy guard.
    function burnFrom(address account, uint256 value) public override nonReentrant {
        super.burnFrom(account, value);
    }

    // ----------------------------------------------------------------
    //  Guarded ERC20 entry points
    // ----------------------------------------------------------------

    function transfer(address to, uint256 value) public override nonReentrant returns (bool) {
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value)
        public
        override
        nonReentrant
        returns (bool)
    {
        return super.transferFrom(from, to, value);
    }

    function approve(address spender, uint256 value) public override nonReentrant returns (bool) {
        return super.approve(spender, value);
    }

    // ----------------------------------------------------------------
    //  Guardian view helpers
    // ----------------------------------------------------------------

    /**
     * @notice Current "guardian block" (opening block = 1). 0 if trading is not open.
     */
    function guardianBlock() public view returns (uint256) {
        if (!tradingOpen) return 0;
        return block.number - tradingOpenBlock + 1;
    }

    /**
     * @notice Current max wallet balance on buy. 0 means "no limit".
     */
    function currentMaxWallet() public view returns (uint256) {
        uint256 b = guardianBlock();
        if (b == 0 || b > tier3Blocks) return 0;
        if (b <= tier1Blocks) return (MAX_SUPPLY * 1) / 100; // 1%
        if (b <= tier2Blocks) return (MAX_SUPPLY * 2) / 100; // 2%
        return (MAX_SUPPLY * 3) / 100; // 3%
    }

    /**
     * @notice Current sell tax in bps (10000 = 100%).
     */
    function currentSellTaxBps() public view returns (uint256) {
        uint256 b = guardianBlock();
        if (b == 0 || b > tier3Blocks) return 0;
        if (b <= tier1Blocks) return 5_000; // 50%
        if (b <= tier2Blocks) return 4_000; // 40%
        return 3_000; // 30%
    }

    // ----------------------------------------------------------------
    //  Transfer hook with the guardian logic (OZ v5 _update)
    // ----------------------------------------------------------------

    function _update(address from, address to, uint256 value) internal override {
        // Mint / burn (from==0 or to==0) - no restrictions.
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        address pair = lpPair;
        bool fromPair = pair != address(0) && from == pair;
        bool toPair = pair != address(0) && to == pair;

        if (!tradingOpen) {
            // Before trading opens, no trading against the pair is allowed.
            // Liquidity is added while lpPair is still unset, so this does not block it.
            if (fromPair || toPair) revert TradingNotOpen();
            super._update(from, to, value);
            return;
        }

        // ---- GUARDIAN BUY: from == lpPair ----
        if (fromPair) {
            uint256 maxWallet = currentMaxWallet();
            if (maxWallet != 0 && balanceOf(to) + value > maxWallet) {
                revert MaxWalletExceeded();
            }
            super._update(from, to, value);
            return;
        }

        // ---- GUARDIAN SELL: to == lpPair (collected tax is BURNED) ----
        if (toPair) {
            uint256 taxBps = currentSellTaxBps();
            if (taxBps != 0) {
                uint256 taxAmount = (value * taxBps) / BPS;
                if (taxAmount != 0) {
                    super._update(from, address(0), taxAmount); // burn
                    totalTaxBurned += taxAmount;
                    emit AntiBotTaxBurned(from, taxAmount);
                }
                super._update(from, to, value - taxAmount);
            } else {
                super._update(from, to, value);
            }
            return;
        }

        // ---- Normal wallet-to-wallet transfer ----
        super._update(from, to, value);
    }
}
