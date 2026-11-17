// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {QDayPayReceiver} from "../src/QDayPayReceiver.sol";
import {MockEIP3009Token} from "./mocks/MockEIP3009Token.sol";
import {TestBase} from "./utils/TestBase.sol";

/// @title QDayPayReceiverTest
/// @notice Unit tests for {QDayPayReceiver} against a real ecrecover-based EIP-3009 test token.
///
/// Coverage map (spec requirement -> test):
///   - happy path pays the merchant .................. test_PaySettlesToBeneficiary
///   - receipt event fields .......................... test_PayEmitsPaymentReceived
///   - duplicate orderId reverts ..................... test_PayRevertsOnDuplicateOrderId
///   - duplicate orderId even with fresh nonce ....... test_PayRevertsOnDuplicateOrderIdWithFreshNonce
///   - expired authorization reverts ................. test_PayRevertsOnExpiredAuthorization
///   - not-yet-valid authorization reverts ........... test_PayRevertsWhenNotYetValid
///   - nonce replay reverts (new orderId) ............ test_PayRevertsOnNonceReplayWithNewOrderId
///   - signer != from reverts ........................ test_PayRevertsWhenSignerIsNotPayer
///   - value == 0 reverts ............................ test_PayRevertsOnZeroValue
///   - zero addresses ................................ test_PayRevertsOnZeroOrderId / OnZeroFrom /
///                                                      test_ConstructorRevertsOnZeroBeneficiary
///   - setBeneficiary only owner ..................... test_SetBeneficiaryRevertsForNonOwner
///   - setBeneficiary zero rejected .................. test_SetBeneficiaryRevertsOnZeroAddress
///   - setBeneficiary reroutes funds ................. test_SetBeneficiaryRoutesNextPayment
///   - rescue cannot touch tUSD8 ..................... test_RescueRevertsForSettlementToken
///   - rescue only owner ............................. test_RescueRevertsForNonOwner
///   - rescue sweeps stray tokens .................... test_RescueSweepsStrayToken
///   - ownership transfer ............................ test_TransferOwnership
///   - contract never strands funds .................. test_PayLeavesNoFundsInContract
contract QDayPayReceiverTest is TestBase {
    // --- fixtures ---------------------------------------------------------
    MockEIP3009Token internal token;
    MockEIP3009Token internal strayToken;
    QDayPayReceiver internal receiver;

    address internal ownerAddr = address(0xA11CE);
    address internal beneficiaryAddr = address(0xB0B);
    address internal seller = address(0x5E11E2);

    uint256 internal payerPk = 0xC0FFEE;
    address internal payer;

    uint256 internal constant ONE_TUSD = 1_000_000; // tUSD8 has 6 decimals
    uint256 internal constant AMOUNT = 10_000; // 0.01 tUSD8
    bytes32 internal constant ORDER_ID = keccak256("order-0001");
    bytes32 internal constant ORDER_ID_2 = keccak256("order-0002");

    // --- mirrored events (needed by vm.expectEmit) ------------------------
    event PaymentReceived(
        bytes32 indexed orderId,
        address indexed from,
        uint256 value,
        bytes32 nonce,
        address indexed beneficiary
    );
    event BeneficiaryChanged(address indexed previousBeneficiary, address indexed newBeneficiary);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    // --- error selectors (custom errors are matched by selector) ----------
    bytes4 internal constant ERR_ZERO_ADDRESS = bytes4(keccak256("ZeroAddress()"));
    bytes4 internal constant ERR_ZERO_VALUE = bytes4(keccak256("ZeroValue()"));
    bytes4 internal constant ERR_ZERO_ORDER_ID = bytes4(keccak256("ZeroOrderId()"));
    bytes4 internal constant ERR_ORDER_ALREADY_PAID = bytes4(keccak256("OrderAlreadyPaid(bytes32)"));
    bytes4 internal constant ERR_AUTH_EXPIRED = bytes4(keccak256("AuthorizationExpired()"));
    bytes4 internal constant ERR_AUTH_NOT_YET_VALID = bytes4(keccak256("AuthorizationNotYetValid()"));
    bytes4 internal constant ERR_NOT_OWNER = bytes4(keccak256("NotOwner()"));
    bytes4 internal constant ERR_PROTECTED_TOKEN = bytes4(keccak256("ProtectedToken()"));
    bytes4 internal constant ERR_INVALID_SIG = bytes4(keccak256("InvalidSignature()"));
    bytes4 internal constant ERR_AUTH_ALREADY_USED = bytes4(keccak256("AuthorizationAlreadyUsed(address,bytes32)"));

    // --- setUp ------------------------------------------------------------
    function setUp() public {
        vm.warp(1_800_000_000);
        payer = vm.addr(payerPk);

        token = new MockEIP3009Token("tUSD8", "2", 6);
        strayToken = new MockEIP3009Token("STRAY", "1", 18);
        receiver = new QDayPayReceiver(address(token), ownerAddr, beneficiaryAddr);

        token.mint(payer, 100 * ONE_TUSD);
    }

    // --- helpers ----------------------------------------------------------
    /// @dev Builds the payer's EIP-3009 signature for a payment into the receiver.
    function _signPayerAuth(
        uint256 pk,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 digest =
            token.transferWithAuthorizationDigest(from, address(receiver), value, validAfter, validBefore, nonce);
        return vm.sign(pk, digest);
    }

    /// @dev Signs with the payer key and settles, as an arbitrary caller (seller / relayer).
    function _settle(address caller, bytes32 orderId, uint256 value, bytes32 nonce) internal returns (uint256) {
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPayerAuth(payerPk, payer, value, validAfter, validBefore, nonce);

        vm.prank(caller);
        return receiver.pay(orderId, payer, value, validAfter, validBefore, nonce, v, r, s);
    }

    // =====================================================================
    // Happy paths
    // =====================================================================

    function test_PaySettlesToBeneficiary() public {
        uint256 beneficiaryBefore = token.balanceOf(beneficiaryAddr);
        uint256 payerBefore = token.balanceOf(payer);
        bytes32 nonce = keccak256("nonce-happy");

        uint256 settled = _settle(seller, ORDER_ID, AMOUNT, nonce);

        assertEq(settled, AMOUNT, "settled amount");
        assertEq(token.balanceOf(beneficiaryAddr), beneficiaryBefore + AMOUNT, "beneficiary balance");
        assertEq(token.balanceOf(payer), payerBefore - AMOUNT, "payer balance");
        assertEq(token.balanceOf(address(receiver)), 0, "receiver must not hold funds");
        assertEq(receiver.tokenBalance(), 0, "tokenBalance() view");
        assertTrue(receiver.orders(ORDER_ID), "order recorded");
        assertTrue(receiver.isOrderPaid(ORDER_ID), "isOrderPaid view");
        assertTrue(token.authorizationState(payer, nonce), "EIP-3009 nonce consumed");
    }

    function test_PayLeavesNoFundsInContract() public {
        _settle(seller, ORDER_ID, AMOUNT, keccak256("n-a"));
        _settle(seller, ORDER_ID_2, AMOUNT * 2, keccak256("n-b"));

        assertEq(token.balanceOf(address(receiver)), 0, "no funds stranded after two settlements");
        assertEq(token.balanceOf(beneficiaryAddr), AMOUNT * 3, "beneficiary accumulated both");
    }

    function test_PayEmitsPaymentReceived() public {
        bytes32 nonce = keccak256("nonce-event");
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            _signPayerAuth(payerPk, payer, AMOUNT, validAfter, validBefore, nonce);

        vm.expectEmit(true, true, true, true, address(receiver));
        emit PaymentReceived(ORDER_ID, payer, AMOUNT, nonce, beneficiaryAddr);

        vm.prank(seller);
        receiver.pay(ORDER_ID, payer, AMOUNT, validAfter, validBefore, nonce, v, r, s);
    }

    function test_PayCallableByAnyone() public {
        // The authority is the payer's signature, not msg.sender: a relayer must be able to settle.
        address relayer = address(0xFEED);
        _settle(relayer, ORDER_ID, AMOUNT, keccak256("nonce-relayer"));

        assertEq(token.balanceOf(beneficiaryAddr), AMOUNT, "relayed settlement reached merchant");
    }

    // =====================================================================
    // Idempotency / replay
    // =====================================================================

    function test_PayRevertsOnDuplicateOrderId() public {
        _settle(seller, ORDER_ID, AMOUNT, keccak256("nonce-1"));
        (uint8 v, bytes32 r, bytes32 s) =
            _signPayerAuth(payerPk, payer, AMOUNT, 0, block.timestamp + 1 hours, keccak256("nonce-1"));

        vm.prank(seller);
        // Full revert data asserted, including the offending orderId.
        vm.expectRevert(abi.encodeWithSelector(ERR_ORDER_ALREADY_PAID, ORDER_ID));
        receiver.pay(ORDER_ID, payer, AMOUNT, 0, block.timestamp + 1 hours, keccak256("nonce-1"), v, r, s);
    }

    function test_PayRevertsOnDuplicateOrderIdWithFreshNonce() public {
        // The business-order guard must hold even when the client retried with a brand new
        // nonce + signature (the "HTTP response lost -> retry" double-charge scenario).
        _settle(seller, ORDER_ID, AMOUNT, keccak256("nonce-first"));

        (uint8 v, bytes32 r, bytes32 s) = _signPayerAuth(
            payerPk, payer, AMOUNT, 0, block.timestamp + 1 hours, keccak256("nonce-second")
        );

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ERR_ORDER_ALREADY_PAID, ORDER_ID));
        receiver.pay(ORDER_ID, payer, AMOUNT, 0, block.timestamp + 1 hours, keccak256("nonce-second"), v, r, s);

        assertEq(token.balanceOf(beneficiaryAddr), AMOUNT, "charged exactly once");
    }

    function test_PayRevertsOnNonceReplayWithNewOrderId() public {
        bytes32 nonce = keccak256("nonce-replay");
        _settle(seller, ORDER_ID, AMOUNT, nonce);

        // Same nonce, different (unused) orderId -> must be stopped by the token's nonce guard.
        (uint8 v, bytes32 r, bytes32 s) =
            _signPayerAuth(payerPk, payer, AMOUNT, 0, block.timestamp + 1 hours, nonce);

        vm.prank(seller);
        // Reverting from the token itself: exact data, including authorizer + nonce.
        vm.expectRevert(abi.encodeWithSelector(ERR_AUTH_ALREADY_USED, payer, nonce));
        receiver.pay(ORDER_ID_2, payer, AMOUNT, 0, block.timestamp + 1 hours, nonce, v, r, s);
    }

    // =====================================================================
    // Authorization window
    // =====================================================================

    function test_PayRevertsOnExpiredAuthorization() public {
        uint256 validBefore = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) =
            _signPayerAuth(payerPk, payer, AMOUNT, 0, validBefore, keccak256("nonce-expired"));

        vm.prank(seller);
        vm.expectRevert(ERR_AUTH_EXPIRED);
        receiver.pay(ORDER_ID, payer, AMOUNT, 0, validBefore, keccak256("nonce-expired"), v, r, s);
    }

    function test_PayRevertsOnValidBeforeBoundary() public {
        // EIP-3009 treats validBefore as exclusive: block.timestamp == validBefore is expired.
        uint256 validBefore = block.timestamp;
        (uint8 v, bytes32 r, bytes32 s) =
            _signPayerAuth(payerPk, payer, AMOUNT, 0, validBefore, keccak256("nonce-boundary"));

        vm.prank(seller);
        vm.expectRevert(ERR_AUTH_EXPIRED);
        receiver.pay(ORDER_ID, payer, AMOUNT, 0, validBefore, keccak256("nonce-boundary"), v, r, s);
    }

    function test_PayRevertsWhenNotYetValid() public {
        uint256 validAfter = block.timestamp + 100;
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            _signPayerAuth(payerPk, payer, AMOUNT, validAfter, validBefore, keccak256("nonce-future"));

        vm.prank(seller);
        vm.expectRevert(ERR_AUTH_NOT_YET_VALID);
        receiver.pay(ORDER_ID, payer, AMOUNT, validAfter, validBefore, keccak256("nonce-future"), v, r, s);
    }

    function test_PaySucceedsAfterValidAfterPasses() public {
        uint256 validAfter = block.timestamp + 100;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("nonce-later");
        (uint8 v, bytes32 r, bytes32 s) = _signPayerAuth(payerPk, payer, AMOUNT, validAfter, validBefore, nonce);

        vm.warp(validAfter); // inclusive lower bound
        vm.prank(seller);
        receiver.pay(ORDER_ID, payer, AMOUNT, validAfter, validBefore, nonce, v, r, s);

        assertEq(token.balanceOf(beneficiaryAddr), AMOUNT, "settled once the window opened");
    }

    // =====================================================================
    // Signature / payer checks
    // =====================================================================

    function test_PayRevertsWhenSignerIsNotPayer() public {
        uint256 attackerPk = 0xBADBAD;
        bytes32 nonce = keccak256("nonce-wrong-signer");
        uint256 validBefore = block.timestamp + 1 hours;

        // Signed by the wrong key, but submitted as if `payer` had authorised it.
        (uint8 v, bytes32 r, bytes32 s) = _signPayerAuth(attackerPk, payer, AMOUNT, 0, validBefore, nonce);

        vm.prank(seller);
        vm.expectRevert(ERR_INVALID_SIG);
        receiver.pay(ORDER_ID, payer, AMOUNT, 0, validBefore, nonce, v, r, s);
    }

    // =====================================================================
    // Input validation
    // =====================================================================

    function test_PayRevertsOnZeroValue() public {
        bytes32 nonce = keccak256("nonce-zero-value");
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPayerAuth(payerPk, payer, 0, 0, validBefore, nonce);

        vm.prank(seller);
        vm.expectRevert(ERR_ZERO_VALUE);
        receiver.pay(ORDER_ID, payer, 0, 0, validBefore, nonce, v, r, s);
    }

    function test_PayRevertsOnZeroOrderId() public {
        bytes32 nonce = keccak256("nonce-zero-order");
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPayerAuth(payerPk, payer, AMOUNT, 0, validBefore, nonce);

        vm.prank(seller);
        vm.expectRevert(ERR_ZERO_ORDER_ID);
        receiver.pay(bytes32(0), payer, AMOUNT, 0, validBefore, nonce, v, r, s);
    }

    function test_PayRevertsOnZeroFrom() public {
        bytes32 nonce = keccak256("nonce-zero-from");
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPayerAuth(payerPk, address(0), AMOUNT, 0, validBefore, nonce);

        vm.prank(seller);
        vm.expectRevert(ERR_ZERO_ADDRESS);
        receiver.pay(ORDER_ID, address(0), AMOUNT, 0, validBefore, nonce, v, r, s);
    }

    // =====================================================================
    // Construction
    // =====================================================================

    function test_ConstructorRevertsOnZeroBeneficiary() public {
        vm.expectRevert(ERR_ZERO_ADDRESS);
        new QDayPayReceiver(address(token), ownerAddr, address(0));
    }

    function test_ConstructorRevertsOnZeroToken() public {
        vm.expectRevert(ERR_ZERO_ADDRESS);
        new QDayPayReceiver(address(0), ownerAddr, beneficiaryAddr);
    }

    function test_ConstructorRevertsOnZeroOwner() public {
        vm.expectRevert(ERR_ZERO_ADDRESS);
        new QDayPayReceiver(address(token), address(0), beneficiaryAddr);
    }

    function test_ConstructorWiresState() public view {
        assertEq(address(receiver.token()), address(token), "token");
        assertEq(receiver.owner(), ownerAddr, "owner");
        assertEq(receiver.beneficiary(), beneficiaryAddr, "beneficiary");
    }

    // =====================================================================
    // Beneficiary administration
    // =====================================================================

    function test_SetBeneficiaryRevertsForNonOwner() public {
        vm.prank(seller);
        vm.expectRevert(ERR_NOT_OWNER);
        receiver.setBeneficiary(address(0xCAFE));
    }

    function test_SetBeneficiaryRevertsOnZeroAddress() public {
        vm.prank(ownerAddr);
        vm.expectRevert(ERR_ZERO_ADDRESS);
        receiver.setBeneficiary(address(0));
    }

    function test_SetBeneficiaryRoutesNextPayment() public {
        address newBeneficiary = address(0xdEaD);

        vm.expectEmit(true, true, false, false, address(receiver));
        emit BeneficiaryChanged(beneficiaryAddr, newBeneficiary);

        vm.prank(ownerAddr);
        receiver.setBeneficiary(newBeneficiary);

        assertEq(receiver.beneficiary(), newBeneficiary, "beneficiary updated");

        _settle(seller, ORDER_ID, AMOUNT, keccak256("nonce-new-beneficiary"));

        assertEq(token.balanceOf(newBeneficiary), AMOUNT, "new beneficiary paid");
        assertEq(token.balanceOf(beneficiaryAddr), 0, "old beneficiary untouched");
    }

    // =====================================================================
    // Rescue
    // =====================================================================

    function test_RescueRevertsForSettlementToken() public {
        // tUSD8 must never be sweepable: settlement funds only flow through pay().
        vm.prank(ownerAddr);
        vm.expectRevert(ERR_PROTECTED_TOKEN);
        receiver.rescue(address(token), 1);
    }

    function test_RescueRevertsForNonOwner() public {
        strayToken.mint(address(receiver), 500);

        vm.prank(seller);
        vm.expectRevert(ERR_NOT_OWNER);
        receiver.rescue(address(strayToken), 500);
    }

    function test_RescueSweepsStrayToken() public {
        strayToken.mint(address(receiver), 500);

        vm.expectEmit(true, true, false, true, address(receiver));
        emit Rescued(address(strayToken), ownerAddr, 400);

        vm.prank(ownerAddr);
        receiver.rescue(address(strayToken), 400);

        assertEq(strayToken.balanceOf(ownerAddr), 400, "owner received stray tokens");
        assertEq(strayToken.balanceOf(address(receiver)), 100, "remainder left");

        // Settlement token accounting is unaffected by rescue.
        assertEq(token.balanceOf(address(receiver)), 0, "no settlement funds involved");
    }

    // =====================================================================
    // Ownership
    // =====================================================================

    function test_TransferOwnership() public {
        address newOwner = address(0x0FF1CE);

        vm.expectEmit(true, true, false, false, address(receiver));
        emit OwnershipTransferred(ownerAddr, newOwner);

        vm.prank(ownerAddr);
        receiver.transferOwnership(newOwner);

        assertEq(receiver.owner(), newOwner, "owner updated");

        // Old owner lost its privileges.
        vm.prank(ownerAddr);
        vm.expectRevert(ERR_NOT_OWNER);
        receiver.setBeneficiary(address(0xCAFE));

        // New owner can administer.
        vm.prank(newOwner);
        receiver.setBeneficiary(address(0xCAFE));
        assertEq(receiver.beneficiary(), address(0xCAFE), "new owner can set beneficiary");
    }

    function test_TransferOwnershipRevertsForNonOwner() public {
        vm.prank(seller);
        vm.expectRevert(ERR_NOT_OWNER);
        receiver.transferOwnership(address(0x0FF1CE));
    }

    function test_TransferOwnershipRevertsOnZeroAddress() public {
        vm.prank(ownerAddr);
        vm.expectRevert(ERR_ZERO_ADDRESS);
        receiver.transferOwnership(address(0));
    }
}
