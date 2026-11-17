// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";

/// @title QDayPayReceiver
/// @notice x402 payTo contract for tUSD8 on QDay Aevum testnet (chainId 44005).
///
/// @dev Why this exists
/// -------------------
/// In x402's exact-EVM scheme the buyer signs an EIP-3009 `TransferWithAuthorization` whose
/// `to` is the `payTo` advertised in the 402 challenge. If `payTo` is a plain EOA, settlement is
/// just "tokens moved" - the merchant has to reconcile the on-chain transfer against the business
/// order afterwards, off-chain, which is racy and lossy (a retried HTTP request can produce a
/// second authorization with a *new* nonce and therefore a *second* charge, because EIP-3009 only
/// deduplicates nonces, not business orders).
///
/// Pointing `payTo` at this contract fixes both problems in one transaction:
///
///   seller/relayer ──pay(orderId,...)──► QDayPayReceiver
///                                           │ 1. checks orders[orderId] == false      (idempotency)
///                                           │ 2. token.transferWithAuthorization(...)  (payer -> this)
///                                           │ 3. token.transfer(beneficiary, value)    (this -> merchant)
///                                           │ 4. orders[orderId] = true + PaymentReceived
///                                           ▼
///                                       atomically: money moved AND receipt recorded
///
/// Anyone may call {pay}: the authority is the payer's EIP-3009 signature, not `msg.sender`.
/// The contract is deliberately **not** upgradeable and holds no funds between calls - the
/// received amount is forwarded to {beneficiary} in the same transaction (verified by a balance
/// delta check, so a token that does not actually move funds cannot fake a settlement).
contract QDayPayReceiver is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    // ---------------------------------------------------------------------
    // Immutables / storage
    // ---------------------------------------------------------------------

    /// @notice The EIP-3009 settlement token (tUSD8 on QDay Aevum testnet).
    IERC3009 public immutable token;

    /// @notice Owner able to rotate the beneficiary, transfer ownership and rescue stray tokens.
    address public owner;

    /// @notice Merchant address that receives every settled payment.
    address public beneficiary;

    /// @notice orderId => already settled. Business-level idempotency, independent of token nonces.
    mapping(bytes32 => bool) public orders;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted once per settled order - this is the on-chain receipt for the 200 response.
    /// @param orderId     Business order id chosen by the seller (idempotency key).
    /// @param from        Payer address that signed the EIP-3009 authorization.
    /// @param value       Amount settled, in token base units (6 decimals for tUSD8).
    /// @param nonce       EIP-3009 nonce that was consumed.
    /// @param beneficiary Merchant address the funds were forwarded to.
    event PaymentReceived(
        bytes32 indexed orderId,
        address indexed from,
        uint256 value,
        bytes32 nonce,
        address indexed beneficiary
    );

    /// @notice Emitted when the merchant payout address changes.
    event BeneficiaryChanged(address indexed previousBeneficiary, address indexed newBeneficiary);

    /// @notice Emitted when contract ownership changes.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Emitted when the owner sweeps a non-settlement token out of the contract.
    event Rescued(address indexed token, address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner();
    error ZeroAddress();
    error ZeroValue();
    error ZeroOrderId();
    error OrderAlreadyPaid(bytes32 orderId);
    error InvalidBeneficiary();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error ReceivedAmountMismatch(uint256 expected, uint256 received);
    error ProtectedToken();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param token_       EIP-3009 token used for settlement (tUSD8).
    /// @param owner_       Owner of this receiver (can rotate beneficiary / rescue).
    /// @param beneficiary_ Merchant address receiving settled funds.
    constructor(address token_, address owner_, address beneficiary_) {
        if (token_ == address(0) || owner_ == address(0) || beneficiary_ == address(0)) {
            revert ZeroAddress();
        }
        token = IERC3009(token_);
        owner = owner_;
        beneficiary = beneficiary_;

        emit OwnershipTransferred(address(0), owner_);
        emit BeneficiaryChanged(address(0), beneficiary_);
    }

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /// @notice Settle one x402 payment: pull the payer's EIP-3009 authorization into this
    ///         contract, forward it to {beneficiary}, and record the business order - atomically.
    /// @dev Callable by anyone (seller, relayer, buyer). If any step reverts the whole
    ///      transaction reverts, so no half-settled state is ever observable.
    /// @param orderId      Business order id (idempotency key). Must be non-zero and unused.
    /// @param from         Payer that signed the authorization.
    /// @param value        Amount in token base units. Must be non-zero.
    /// @param validAfter   Authorization validity start (inclusive).
    /// @param validBefore  Authorization validity end (exclusive).
    /// @param nonce        EIP-3009 nonce consumed by the token.
    /// @param v            Signature v.
    /// @param r            Signature r.
    /// @param s            Signature s.
    /// @return value       The settled amount (echoed for convenience / off-chain decoding).
    function pay(
        bytes32 orderId,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256) {
        // ---- checks -----------------------------------------------------
        if (orderId == bytes32(0)) revert ZeroOrderId();
        if (from == address(0)) revert ZeroAddress();
        if (value == 0) revert ZeroValue();
        if (orders[orderId]) revert OrderAlreadyPaid(orderId);

        address payee = beneficiary;
        if (payee == address(0)) revert InvalidBeneficiary();

        // Mirror the token's own EIP-3009 window so callers get a clear error instead of a
        // generic revert bubbling up from the token.
        if (block.timestamp < validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();

        // ---- effects (fail-closed: undone by the revert if any interaction below fails) ----
        orders[orderId] = true;

        uint256 balanceBefore = IERC20(address(token)).balanceOf(address(this));

        // ---- interactions ----------------------------------------------
        // 1) Pull the payer's funds in. The token verifies the EIP-3009 signature against
        //    `from`, enforces the validity window and burns the nonce.
        token.transferWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, v, r, s);

        // 2) Verify the money actually arrived - guards against a misbehaving token that
        //    "succeeds" without moving funds (and against fee-on-transfer surprise).
        uint256 received = IERC20(address(token)).balanceOf(address(this)) - balanceBefore;
        if (received != value) revert ReceivedAmountMismatch(value, received);

        // 3) Forward to the merchant. Contract balance returns to zero.
        IERC20(address(token)).safeTransfer(payee, value);

        emit PaymentReceived(orderId, from, value, nonce, payee);
        return value;
    }

    // ---------------------------------------------------------------------
    // Owner administration
    // ---------------------------------------------------------------------

    /// @notice Rotate the merchant payout address. Only the owner may call this.
    /// @param newBeneficiary New merchant address (must be non-zero).
    function setBeneficiary(address newBeneficiary) external onlyOwner {
        if (newBeneficiary == address(0)) revert ZeroAddress();
        address previous = beneficiary;
        beneficiary = newBeneficiary;
        emit BeneficiaryChanged(previous, newBeneficiary);
    }

    /// @notice Sweep a stray *non-settlement* token out of the contract to the owner.
    /// @dev tUSD8 is deliberately excluded: settlement funds may only enter via {pay} and are
    ///      forwarded out in the same transaction, so any tUSD8 sitting here would be a bug and
    ///      must be investigated rather than silently swept.
    /// @param token_ Address of the token to sweep (must not be the settlement token).
    /// @param amount Amount to sweep.
    function rescue(address token_, uint256 amount) external onlyOwner {
        if (token_ == address(0)) revert ZeroAddress();
        if (token_ == address(token)) revert ProtectedToken();
        if (amount == 0) revert ZeroValue();

        IERC20(token_).safeTransfer(owner, amount);
        emit Rescued(token_, owner, amount);
    }

    /// @notice Transfer ownership of this receiver.
    /// @param newOwner New owner address (must be non-zero).
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Current settlement-token balance held by this contract.
    /// @dev Should be 0 except transiently inside {pay}. Exposed so operators can assert the
    ///      "no funds stranded" invariant from a script.
    function tokenBalance() external view returns (uint256) {
        return IERC20(address(token)).balanceOf(address(this));
    }

    /// @notice True if the business order was already settled.
    function isOrderPaid(bytes32 orderId) external view returns (bool) {
        return orders[orderId];
    }
}
