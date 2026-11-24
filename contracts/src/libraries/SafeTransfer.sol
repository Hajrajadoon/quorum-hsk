// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";

/// @notice Minimal safe ERC20 helpers. Handles tokens that return nothing (e.g. USDT-style)
///         and tokens that require the allowance to be reset to zero before changing it.
library SafeTransfer {
    error TransferFailed();
    error ApproveFailed();
    error NotAContract();

    function safeTransfer(address token, address to, uint256 amount) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(IERC20.transfer.selector, to, amount), false);
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount), false);
    }

    function forceApprove(address token, address spender, uint256 amount) internal {
        bytes memory approveCall = abi.encodeWithSelector(IERC20.approve.selector, spender, amount);
        if (!_tryCall(token, approveCall)) {
            _callOptionalReturn(token, abi.encodeWithSelector(IERC20.approve.selector, spender, 0), true);
            _callOptionalReturn(token, approveCall, true);
        }
    }

    function _tryCall(address token, bytes memory data) private returns (bool) {
        if (token.code.length == 0) revert NotAContract();
        (bool ok, bytes memory ret) = token.call(data);
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }

    function _callOptionalReturn(address token, bytes memory data, bool isApprove) private {
        if (!_tryCall(token, data)) {
            if (isApprove) revert ApproveFailed();
            revert TransferFailed();
        }
    }
}
