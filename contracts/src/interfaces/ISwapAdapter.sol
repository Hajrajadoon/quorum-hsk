// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A thin adapter between QuorumVault and a DEX router (HSKSwap V2 / V3, or a mock).
/// @dev The vault transfers `amountIn` of `tokenIn` to the adapter *before* calling `swap`.
///      The adapter must send the output tokens straight to `recipient`.
interface ISwapAdapter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut);

    /// @dev Not necessarily `view` (Uniswap V3 quoters simulate a swap). Call it with eth_call / staticCall.
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256 amountOut);
}
