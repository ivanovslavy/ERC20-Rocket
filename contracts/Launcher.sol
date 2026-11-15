// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Launcher
 * @notice Atomically launches a RocketToken: addLiquidityETH + setLp + executeTrading in ONE
 *         transaction. By EVM atomicity there is no block in which the pool is live while
 *         lpPair == 0, so the sniper window between add-liquidity and setLp is eliminated.
 *
 *  Preconditions (set up by the deploy script):
 *    - The RocketToken is deployed with initialOwner = THIS launcher, so the launcher both
 *      OWNS the token (can call setLp/executeTrading) and HOLDS the whole supply.
 *    - The launcher is deployed by the operator (becomes `owner` here); only `owner` can launch.
 *
 *  launch() sends the LP tokens to `lpRecipient` (the operator), so liquidity can later be
 *  removed/recovered by the operator exactly as before. After a verified launch the operator
 *  may call renounceTokenOwnership() (both one-shot owner functions are already spent).
 */
interface IRocketToken {
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function setLp(address lpPair) external;
    function executeTrading() external;
    function lpPair() external view returns (address);
    function renounceOwnership() external;
}

interface IUniswapV2Router02 {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

contract Launcher {
    address public owner;
    bool public launched;

    error NotOwner();
    error AlreadyLaunched();
    error PairNotFound();

    event Launched(address indexed token, address indexed pair, uint256 tokenAmount, uint256 ethAmount);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * @notice One-shot atomic launch. Caller sends the ETH for liquidity as msg.value.
     * @param token        The RocketToken (must be owned by this launcher and hold `tokenAmount`).
     * @param router       Uniswap V2-style router.
     * @param tokenAmount  Tokens to add as liquidity (typically the whole supply).
     * @param amountTokenMin Slippage floor for tokens (0 is fine for a fresh pool).
     * @param amountETHMin   Slippage floor for ETH.
     * @param lpRecipient  Where the LP tokens go (the operator, for later recovery).
     */
    function launch(
        address token,
        address router,
        uint256 tokenAmount,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address lpRecipient
    ) external payable onlyOwner {
        if (launched) revert AlreadyLaunched();
        launched = true;

        IRocketToken t = IRocketToken(token);
        IUniswapV2Router02 r = IUniswapV2Router02(router);

        // 1) add liquidity while lpPair is still 0 (transfer to the pair is allowed)
        t.approve(router, tokenAmount);
        r.addLiquidityETH{value: msg.value}(
            token,
            tokenAmount,
            amountTokenMin,
            amountETHMin,
            lpRecipient,
            block.timestamp + 600
        );

        // 2) resolve the real pair from the factory and register it (token validates it)
        address pair = IUniswapV2Factory(r.factory()).getPair(token, r.WETH());
        if (pair == address(0)) revert PairNotFound();
        t.setLp(pair);

        // 3) open trading - all in this same transaction, so no one can snipe the window
        t.executeTrading();

        emit Launched(token, pair, tokenAmount, msg.value);
    }

    /// @notice After a verified launch, renounce the token's ownership (both one-shot funcs are spent).
    function renounceTokenOwnership(address token) external onlyOwner {
        IRocketToken(token).renounceOwnership();
    }
}
