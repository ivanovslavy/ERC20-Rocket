// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

/**
 * @title RocketToken (RCT)
 * @notice Standard ERC20 with anti-bot "guardian" policies for a controlled launch.
 *
 *  - ERC20 + ERC20Burnable + Ownable + ReentrancyGuard (OpenZeppelin v5)
 *  - Supply: 100,000,000,000 RCT (100B), fully minted to the deployer
 *  - There are NO exempt/privileged addresses: the owner is subject to the exact same
 *    guardian rules as everyone else.
 *  - setLp()          -> sets the LP pair address (once only, onlyOwner); the pair is
 *                        VALIDATED against the configured factory so a wrong address is impossible.
 *  - executeTrading() -> opens trading (once only, onlyOwner)
 *  - guardian buy/sell -> enforced automatically inside _update() on every transfer
 *  - burnRocket()     -> public burn of own tokens
 *
 *  Restriction tiers are measured in blocks from the opening block (opening block = 1)
 *  and are set per network at deploy time via the constructor (immutable). They are CAPPED
 *  by MAX_TIER3 so the window can never be set "effectively forever" (anti-honeypot-by-param).
 *    Max wallet on BUY (from == lpPair): 1% / 2% / 3% over tier1/2/3, then no limit.
 *    Sell tax (to == lpPair), BURNED: 50% / 40% / 30% over tier1/2/3, then 0%.
 *
 *  Launch order (no privileged addresses, so order matters): 1) add liquidity (while lpPair
 *  is still unset) 2) setLp 3) executeTrading. These three MUST be done atomically (one
 *  transaction, via a launcher contract) to avoid a sniper window between add-liquidity and
 *  setLp — see Launcher.sol.
 *
 *  NB: tiers are in BLOCKS; on L2s whose block.number semantics differ (e.g. Arbitrum), pick
 *  tier values per network. REQUIRED VENUE: a Uniswap V2 (or V2-style) pair (V3/V4 unsupported).
 */
contract RocketToken is ERC20, ERC20Burnable, Ownable, ReentrancyGuard {
    /// @notice Maximum (and initial) supply: 100 billion RCT.
    uint256 public constant MAX_SUPPLY = 100_000_000_000 * 1e18;

    /// @notice Basis points base (10000 = 100%).
    uint256 public constant BPS = 10_000;

    /// @notice Hard cap on tier3 (in blocks): the guardian window can never exceed this.
    ///         Prevents an "effectively forever" 30%-tax / 3%-cap honeypot-by-parameter.
    uint256 public constant MAX_TIER3 = 300;

    /// @notice Block thresholds for the three restriction tiers (immutable, set at deploy).
    uint256 public immutable tier1Blocks;
    uint256 public immutable tier2Blocks;
    uint256 public immutable tier3Blocks;

    /// @notice The DEX factory and wrapped-native used to VALIDATE the LP pair in setLp.
    address public immutable factory;
    address public immutable weth;

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
    error InvalidPair();

    /**
     * @param initialOwner Address that receives the whole supply and becomes owner.
     * @param _tier1Blocks Block count for tier 1 (must be > 0).
     * @param _tier2Blocks Block count for tier 2 (must be > tier1).
     * @param _tier3Blocks Block count for tier 3 (must be > tier2 and <= MAX_TIER3).
     * @param _factory     Uniswap V2 (or V2-style) factory used to validate the LP pair.
     * @param _weth        Wrapped native token of the venue (router.WETH()).
     */
    constructor(
        address initialOwner,
        uint256 _tier1Blocks,
        uint256 _tier2Blocks,
        uint256 _tier3Blocks,
        address _factory,
        address _weth
    ) ERC20("Rocket", "RCT") Ownable(initialOwner) {
        // initialOwner == address(0) is already rejected by Ownable (OwnableInvalidOwner).
        if (
            _tier1Blocks == 0 ||
            _tier2Blocks <= _tier1Blocks ||
            _tier3Blocks <= _tier2Blocks ||
            _tier3Blocks > MAX_TIER3
        ) revert InvalidTierConfig();
        if (_factory == address(0) || _weth == address(0)) revert ZeroAddress();

        tier1Blocks = _tier1Blocks;
        tier2Blocks = _tier2Blocks;
        tier3Blocks = _tier3Blocks;
        factory = _factory;
        weth = _weth;

        _mint(initialOwner, MAX_SUPPLY);
        emit TokenLaunched(initialOwner, MAX_SUPPLY, _tier1Blocks, _tier2Blocks, _tier3Blocks);
    }

    // ----------------------------------------------------------------
    //  Owner controls
    // ----------------------------------------------------------------

    /**
     * @notice Sets the LP pair address. Can be called ONLY ONCE. The address MUST be the real
     *         factory pair for (this token, weth) - validated, so a wrong/unprotected pool is impossible.
     */
    function setLp(address _lpPair) external onlyOwner nonReentrant {
        if (_lpSet) revert LpAlreadySet();
        if (_lpPair == address(0)) revert ZeroAddress();
        if (IUniswapV2Factory(factory).getPair(address(this), weth) != _lpPair) revert InvalidPair();
        lpPair = _lpPair;
        _lpSet = true;
        emit LpSet(_lpPair);
    }

    /**
     * @notice Opens trading and starts the guardian timer. Can be called ONLY ONCE.
     */
    function executeTrading() external onlyOwner nonReentrant {
        if (tradingOpen) revert TradingAlreadyOpen();
        if (!_lpSet) revert LpNotSet();
        tradingOpen = true;
        tradingOpenBlock = block.number;
        emit TradingOpened(block.number);
    }

    // ----------------------------------------------------------------
    //  Burn (all three paths emit RocketBurned)
    // ----------------------------------------------------------------

    function burnRocket(uint256 amount) external {
        _burn(_msgSender(), amount);
        emit RocketBurned(_msgSender(), amount);
    }

    function burn(uint256 value) public override {
        super.burn(value);
        emit RocketBurned(_msgSender(), value);
    }

    function burnFrom(address account, uint256 value) public override {
        super.burnFrom(account, value);
        emit RocketBurned(account, value);
    }

    // ----------------------------------------------------------------
    //  Guardian view helpers
    // ----------------------------------------------------------------

    function guardianBlock() public view returns (uint256) {
        if (!tradingOpen) return 0;
        return block.number - tradingOpenBlock + 1;
    }

    /// @notice Current max wallet balance on buy. 0 means "no limit".
    function currentMaxWallet() public view returns (uint256) {
        uint256 b = guardianBlock();
        if (b == 0 || b > tier3Blocks) return 0;
        if (b <= tier1Blocks) return (MAX_SUPPLY * 1) / 100;
        if (b <= tier2Blocks) return (MAX_SUPPLY * 2) / 100;
        return (MAX_SUPPLY * 3) / 100;
    }

    /// @notice Current sell tax in bps (10000 = 100%).
    function currentSellTaxBps() public view returns (uint256) {
        uint256 b = guardianBlock();
        if (b == 0 || b > tier3Blocks) return 0;
        if (b <= tier1Blocks) return 5_000;
        if (b <= tier2Blocks) return 4_000;
        return 3_000;
    }

    // ----------------------------------------------------------------
    //  Transfer hook with the guardian logic (OZ v5 _update)
    //  (no nonReentrant on transfer/transferFrom/approve - _update makes no external calls)
    // ----------------------------------------------------------------

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        address pair = lpPair;
        bool fromPair = pair != address(0) && from == pair;
        bool toPair = pair != address(0) && to == pair;

        if (!tradingOpen) {
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
                    super._update(from, address(0), taxAmount);
                    totalTaxBurned += taxAmount;
                    emit AntiBotTaxBurned(from, taxAmount);
                }
                super._update(from, to, value - taxAmount);
            } else {
                super._update(from, to, value);
            }
            return;
        }

        super._update(from, to, value);
    }
}
