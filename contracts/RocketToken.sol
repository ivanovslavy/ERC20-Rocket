// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RocketToken (RCT)
 * @notice Standarten ERC20 s anti-bot "guardian" politiki za sigursten launch.
 *
 *  - ERC20 + ERC20Burnable + Ownable + ReentrancyGuard
 *  - Supply: 100,000,000,000 RCT (100B), izcjalo mintnat po portfeila na deployera
 *  - setLp()           -> setva LP pair adresa (samo vednuj, onlyOwner)
 *  - executeTrading()  -> otvarja treidinga (samo vednuj, onlyOwner)
 *  - guardian buy/sell -> logika izpalniavana avtomatichno v _update() pri vseki transfer
 *  - burnRocket()      -> publichno burnvane na sobstveni tokeni
 *
 *  Anti-bot tier-i (broiat se ot bloka na otvarjane, otvarjashtiat blok = blok 1):
 *    Max wallet pri POKUPKA (from == lpPair):
 *      blok 1-10  -> max 1% ot total supply / portfeil
 *      blok 11-20 -> max 2% ot total supply / portfeil
 *      blok 21-30 -> max 3% ot total supply / portfeil
 *      ot blok 31 -> bez ogranichenie
 *    Taksa pri PRODAJBA (to == lpPair) - SABRANITE TAKSI SE IZGARJAT AVTOMATICHNO:
 *      blok 1-10  -> 50%
 *      blok 11-20 -> 40%
 *      blok 21-30 -> 30%
 *      ot blok 31 -> 0% (otpadat restrikciite)
 *
 *  Taksite ot prodajbi ne se sabirat ot nikogo - te se burnvat (namaljavat total supply)
 *  cherez sashtia burn mehanizam kato burnRocket().
 */
contract RocketToken is ERC20, ERC20Burnable, Ownable, ReentrancyGuard {
    /// @notice Maksimalen (i nachalen) supply: 100 miliarda RCT.
    uint256 public constant MAX_SUPPLY = 100_000_000_000 * 1e18;

    /// @notice Bazata za procentni smetki (10000 = 100%).
    uint256 public constant BPS = 10_000;

    /// @notice Dali treidingat e otvoren.
    bool public tradingOpen;

    /// @notice Vatreshen flag dali LP-to e veche setnato.
    bool private _lpSet;

    /// @notice Adresat na likvidnostnia pair (DEX LP CA).
    address public lpPair;

    /// @notice Nomerat na bloka, v koito treidingat e otvoren.
    uint256 public tradingOpenBlock;

    /// @notice Obshto kolichestvo RCT izgoreni ot anti-bot prodajbeni taksi.
    uint256 public totalTaxBurned;

    /// @notice Adresi osvobodeni ot vsichki guardian restrikcii (owner, kontrakt, treasury, router...).
    mapping(address => bool) public isExempt;

    event LpSet(address indexed lpPair);
    event TradingOpened(uint256 indexed blockNumber);
    event ExemptUpdated(address indexed account, bool exempt);
    event RocketBurned(address indexed from, uint256 amount);
    event AntiBotTaxBurned(address indexed from, uint256 amount);

    error LpAlreadySet();
    error LpNotSet();
    error TradingAlreadyOpen();
    error TradingNotOpen();
    error ZeroAddress();
    error MaxWalletExceeded();

    /**
     * @param initialOwner Adres, koito poluchava vsichki tokeni i stava owner/taxWallet.
     */
    constructor(address initialOwner)
        ERC20("Rocket", "RCT")
        Ownable(initialOwner)
    {
        if (initialOwner == address(0)) revert ZeroAddress();

        isExempt[initialOwner] = true;
        isExempt[address(this)] = true;

        _mint(initialOwner, MAX_SUPPLY);
    }

    // ----------------------------------------------------------------
    //  Owner upravlenie
    // ----------------------------------------------------------------

    /**
     * @notice Setva LP pair adresa. Moje da se vika SAMO VEDNUJ.
     */
    function setLp(address _lpPair) external onlyOwner {
        if (_lpSet) revert LpAlreadySet();
        if (_lpPair == address(0)) revert ZeroAddress();
        lpPair = _lpPair;
        _lpSet = true;
        emit LpSet(_lpPair);
    }

    /**
     * @notice Otvarja treidinga i startira guardian taimera. Moje da se vika SAMO VEDNUJ.
     * @dev Iziskva LP-to da e veche setnato.
     */
    function executeTrading() external onlyOwner {
        if (tradingOpen) revert TradingAlreadyOpen();
        if (!_lpSet) revert LpNotSet();
        tradingOpen = true;
        tradingOpenBlock = block.number;
        emit TradingOpened(block.number);
    }

    /**
     * @notice Dobavja / premahva adres ot exempt spisaka (router, treasury, vesting...).
     */
    function setExempt(address account, bool exempt) external onlyOwner {
        isExempt[account] = exempt;
        emit ExemptUpdated(account, exempt);
    }

    // ----------------------------------------------------------------
    //  Burn
    // ----------------------------------------------------------------

    /**
     * @notice Burnva `amount` tokeni ot vikashtia. Namaljava total supply.
     */
    function burnRocket(uint256 amount) external nonReentrant {
        _burn(_msgSender(), amount);
        emit RocketBurned(_msgSender(), amount);
    }

    // ----------------------------------------------------------------
    //  Guardian view helpers
    // ----------------------------------------------------------------

    /**
     * @notice Tekusht "guardian blok" (otvarjashtiat blok = 1). 0 ako treidingat ne e otvoren.
     */
    function guardianBlock() public view returns (uint256) {
        if (!tradingOpen) return 0;
        return block.number - tradingOpenBlock + 1;
    }

    /**
     * @notice Tekusht max balans na portfeil pri pokupka. 0 oznachava "bez limit".
     */
    function currentMaxWallet() public view returns (uint256) {
        uint256 b = guardianBlock();
        if (b == 0 || b > 30) return 0; // predi otvarjane ili sled blok 30 -> bez limit
        if (b <= 10) return (MAX_SUPPLY * 1) / 100; // 1%
        if (b <= 20) return (MAX_SUPPLY * 2) / 100; // 2%
        return (MAX_SUPPLY * 3) / 100;              // 3% (blok 21-30)
    }

    /**
     * @notice Tekushta prodajbena taksa v bps (10000 = 100%).
     */
    function currentSellTaxBps() public view returns (uint256) {
        uint256 b = guardianBlock();
        if (b == 0 || b > 30) return 0;
        if (b <= 10) return 5_000; // 50%
        if (b <= 20) return 4_000; // 40%
        return 3_000;              // 30% (blok 21-30)
    }

    // ----------------------------------------------------------------
    //  Transfer hook s guardian logikata (OZ v5 _update)
    // ----------------------------------------------------------------

    function _update(address from, address to, uint256 value)
        internal
        override
    {
        // Mint / burn (from==0 ili to==0) - bez restrikcii.
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        // Exempt adresi (owner, kontrakt, router, treasury) - bez restrikcii.
        if (isExempt[from] || isExempt[to]) {
            super._update(from, to, value);
            return;
        }

        // Predi otvarjane na treidinga - samo exempt adresi mogat da prashtat tokeni.
        if (!tradingOpen) revert TradingNotOpen();

        // ---- GUARDIAN BUY: pokupka ot LP (from == lpPair) ----
        if (from == lpPair) {
            uint256 maxWallet = currentMaxWallet();
            if (maxWallet != 0 && balanceOf(to) + value > maxWallet) {
                revert MaxWalletExceeded();
            }
            super._update(from, to, value);
            return;
        }

        // ---- GUARDIAN SELL: prodajba kam LP (to == lpPair) ----
        // Sabranata taksa NE otiva v portfeil - izgarja se (namaljava total supply).
        if (to == lpPair) {
            uint256 taxBps = currentSellTaxBps();
            if (taxBps != 0) {
                uint256 taxAmount = (value * taxBps) / BPS;
                if (taxAmount != 0) {
                    // Burn na taksata: prehvarljane kam address(0) namaljava totalSupply.
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

        // ---- Normalen wallet-to-wallet transfer ----
        super._update(from, to, value);
    }
}
