// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {SafeTransfer} from "../libraries/SafeTransfer.sol";
import {AdapterBase} from "./AdapterBase.sol";

interface IUniswapV2Router02 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
}

/// @notice Adapter for HSKSwap V2-style (Uniswap V2 fork) routers.
contract UniswapV2Adapter is ISwapAdapter, AdapterBase {
    using SafeTransfer for address;

    IUniswapV2Router02 public immutable router;

    constructor(address router_) {
        router = IUniswapV2Router02(router_);
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        onlyVault
        returns (uint256 amountOut)
    {
        tokenIn.forceApprove(address(router), amountIn);
        uint256[] memory amounts =
            router.swapExactTokensForTokens(amountIn, minOut, _path(tokenIn, tokenOut), recipient, block.timestamp);
        amountOut = amounts[amounts.length - 1];
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256) {
        uint256[] memory amounts = router.getAmountsOut(amountIn, _path(tokenIn, tokenOut));
        return amounts[amounts.length - 1];
    }

    function _path(address a, address b) private pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = a;
        path[1] = b;
    }
}
