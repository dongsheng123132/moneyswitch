// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";

/// @title SafeERC20
/// @notice Minimal fail-closed ERC-20 transfer helpers.
/// @dev Handles both "returns bool" and "returns nothing" tokens, and treats a revert or a
///      `false` return value as a hard failure, so a silently-failing token can never be
///      mistaken for a successful payment.
library SafeERC20 {
    error SafeERC20TransferFailed(address token);

    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeCall(IERC20.transfer, (to, value)));
    }

    function _callOptionalReturn(IERC20 token, bytes memory data) private {
        (bool success, bytes memory returndata) = address(token).call(data);
        if (!success) revert SafeERC20TransferFailed(address(token));
        // Tokens that return nothing (e.g. old-style) are accepted; if they do return data,
        // it must decode to `true`.
        if (returndata.length != 0 && !abi.decode(returndata, (bool))) {
            revert SafeERC20TransferFailed(address(token));
        }
    }
}
