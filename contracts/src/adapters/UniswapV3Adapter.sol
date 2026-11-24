// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {SafeTransfer} from "../libraries/SafeTransfer.sol";
import {AdapterBase} from "./AdapterBase.sol";

/// @dev SwapRouter02 (no deadline field).
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev Original Uniswap V3 SwapRouter (has a deadline field).
interface ISwapRouterLegacy {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

/// @notice Adapter for HSKSwap V3-style (Uniswap V3 fork) routers. Supports both SwapRouter02
///         and the legacy SwapRouter interface, chosen at deployment.
contract UniswapV3Adapter is ISwapAdapter, AdapterBase {
    using SafeTransfer for address;

    error InvalidFee();

    address public immutable router;
    address public immutable quoter;
    bool public immutable legacyRouter;
    uint24 public defaultFee;

    mapping(address => mapping(address => uint24)) public feeFor;

    event FeeSet(address indexed tokenA, address indexed tokenB, uint24 fee);

    constructor(address router_, address quoter_, bool legacyRouter_, uint24 defaultFee_) {
        router = router_;
        quoter = quoter_;
        legacyRouter = legacyRouter_;
        defaultFee = defaultFee_;
    }

    /// @notice Set the pool fee tier for a pair (both directions). Deployer only.
    function setFee(address tokenA, address tokenB, uint24 fee) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (fee == 0) revert InvalidFee();
        feeFor[tokenA][tokenB] = fee;
        feeFor[tokenB][tokenA] = fee;
        emit FeeSet(tokenA, tokenB, fee);
    }

    function poolFee(address tokenIn, address tokenOut) public view returns (uint24) {
        uint24 f = feeFor[tokenIn][tokenOut];
        return f == 0 ? defaultFee : f;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        onlyVault
        returns (uint256 amountOut)
    {
        tokenIn.forceApprove(router, amountIn);
        uint24 fee = poolFee(tokenIn, tokenOut);
        if (legacyRouter) {
            amountOut = ISwapRouterLegacy(router).exactInputSingle(
                ISwapRouterLegacy.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: recipient,
                    deadline: block.timestamp,
                    amountIn: amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            );
        } else {
            amountOut = ISwapRouter02(router).exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: recipient,
                    amountIn: amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            );
        }
    }

    /// @dev Call with eth_call (staticCall). QuoterV2 simulates the swap and returns the result.
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256 amountOut) {
        (amountOut,,,) = IQuoterV2(quoter).quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                amountIn: amountIn,
                fee: poolFee(tokenIn, tokenOut),
                sqrtPriceLimitX96: 0
            })
        );
    }
}
