// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IERC3009
/// @notice EIP-3009 `TransferWithAuthorization`, v/r/s flavour (USDC FiatTokenV2 style).
/// @dev tUSD8 on QDay Aevum testnet implements this signature form. The payer signs an
///      off-chain authorization; anybody (here: the seller / a relayer) can submit it, and
///      the token moves `value` from `from` to `to` without an on-chain approval.
interface IERC3009 {
    /// @notice Execute a transfer with a signed authorization.
    /// @param from          Payer address (the signer) - tokens are moved out of this account.
    /// @param to            Recipient address.
    /// @param value         Amount of tokens to transfer.
    /// @param validAfter    Unix timestamp after which the authorization is valid (inclusive).
    /// @param validBefore   Unix timestamp before which the authorization is valid (exclusive).
    /// @param nonce         Unique, single-use nonce chosen by the payer.
    /// @param v             ECDSA signature v.
    /// @param r             ECDSA signature r.
    /// @param s             ECDSA signature s.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice Returns true if the authorization with the given nonce has been used.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
