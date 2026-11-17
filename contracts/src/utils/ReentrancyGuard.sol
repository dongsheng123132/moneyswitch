// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ReentrancyGuard
/// @notice Minimal single-slot reentrancy guard (same semantics as OpenZeppelin's).
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    uint256 private _status = _NOT_ENTERED;

    error ReentrancyGuardReentrantCall();

    modifier nonReentrant() {
        if (_status == _ENTERED) revert ReentrancyGuardReentrantCall();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}
