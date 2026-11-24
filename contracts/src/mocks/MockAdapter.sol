// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {SafeTransfer} from "../libraries/SafeTransfer.sol";
import {AdapterBase} from "../adapters/AdapterBase.sol";

/// @notice Fixed-rate swap venue for tests and demos. The deployer sets rates and funds reserves.
///         out = amountIn * rate[tokenIn][tokenOut] / 1e18
contract MockAdapter is ISwapAdapter, AdapterBase {
    using SafeTransfer for address;

    error NoRate();
    error Slippage();
    error LengthMismatch();

    mapping(address => mapping(address => uint256)) public rate;

    function setRate(address tokenIn, address tokenOut, uint256 rate1e18) external {
        if (msg.sender != deployer) revert NotDeployer();
        rate[tokenIn][tokenOut] = rate1e18;
    }

    /// @notice Update many rates in ONE transaction (the demo price feed uses this to save gas).
    function setRates(address[] calldata tokensIn, address[] calldata tokensOut, uint256[] calldata rates1e18)
        external
    {
        if (msg.sender != deployer) revert NotDeployer();
        if (tokensIn.length != tokensOut.length || tokensIn.length != rates1e18.length) revert LengthMismatch();
        for (uint256 i = 0; i < tokensIn.length; i++) {
            rate[tokensIn[i]][tokensOut[i]] = rates1e18[i];
        }
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        onlyVault
        returns (uint256 amountOut)
    {
        amountOut = _quote(tokenIn, tokenOut, amountIn);
        if (amountOut < minOut) revert Slippage();
        tokenOut.safeTransfer(recipient, amountOut);
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256) {
        return _quote(tokenIn, tokenOut, amountIn);
    }

    function _quote(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (uint256) {
        uint256 r = rate[tokenIn][tokenOut];
        if (r == 0) revert NoRate();
        return (amountIn * r) / 1e18;
    }
}
