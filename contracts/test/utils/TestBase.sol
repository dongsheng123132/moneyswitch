// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Vm
/// @notice The subset of Foundry cheatcodes used by this test suite.
/// @dev Declared locally (instead of vendoring forge-std) so the project has zero external
///      dependencies and `forge test` works offline. Signatures must match Foundry's exactly -
///      cheatcode calls are dispatched by selector.
interface Vm {
    function warp(uint256 newTimestamp) external;

    function prank(address msgSender) external;

    function startPrank(address msgSender) external;

    function stopPrank() external;

    function expectRevert() external;

    function expectRevert(bytes4 revertData) external;

    function expectRevert(bytes calldata revertData) external;

    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter)
        external;

    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);

    function addr(uint256 privateKey) external pure returns (address keyAddr);

    function deal(address account, uint256 newBalance) external;

    function label(address account, string calldata newLabel) external;

    function getBlockTimestamp() external view returns (uint256);
}

/// @title TestBase
/// @notice Tiny assertion + cheatcode base contract (forge-std `Test` stand-in).
/// @dev A failing assertion reverts with a descriptive custom error, which forge reports as a
///      test failure. Enough for this suite; deliberately not a general-purpose library.
abstract contract TestBase {
    address internal constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));
    Vm internal constant vm = Vm(VM_ADDRESS);

    error AssertionFailedUint(string what, uint256 expected, uint256 actual);
    error AssertionFailedInt(string what, int256 expected, int256 actual);
    error AssertionFailedAddress(string what, address expected, address actual);
    error AssertionFailedBytes32(string what, bytes32 expected, bytes32 actual);
    error AssertionFailedBool(string what, bool actual);
    error AssertionFailedString(string what, string expected, string actual);
    error ExplicitFailure(string what);

    // --- uint256 -------------------------------------------------------
    function assertEq(uint256 actual, uint256 expected) internal pure {
        assertEq(actual, expected, "uint256");
    }

    function assertEq(uint256 actual, uint256 expected, string memory what) internal pure {
        if (actual != expected) revert AssertionFailedUint(what, expected, actual);
    }

    function assertGt(uint256 actual, uint256 floor, string memory what) internal pure {
        if (actual <= floor) revert AssertionFailedUint(what, floor + 1, actual);
    }

    function assertGe(uint256 actual, uint256 floor, string memory what) internal pure {
        if (actual < floor) revert AssertionFailedUint(what, floor, actual);
    }

    // --- int256 -------------------------------------------------------
    function assertEq(int256 actual, int256 expected, string memory what) internal pure {
        if (actual != expected) revert AssertionFailedInt(what, expected, actual);
    }

    // --- address ------------------------------------------------------
    function assertEq(address actual, address expected) internal pure {
        assertEq(actual, expected, "address");
    }

    function assertEq(address actual, address expected, string memory what) internal pure {
        if (actual != expected) revert AssertionFailedAddress(what, expected, actual);
    }

    // --- bytes32 ------------------------------------------------------
    function assertEq(bytes32 actual, bytes32 expected) internal pure {
        assertEq(actual, expected, "bytes32");
    }

    function assertEq(bytes32 actual, bytes32 expected, string memory what) internal pure {
        if (actual != expected) revert AssertionFailedBytes32(what, expected, actual);
    }

    // --- bool ---------------------------------------------------------
    function assertTrue(bool actual, string memory what) internal pure {
        if (!actual) revert AssertionFailedBool(what, false);
    }

    function assertFalse(bool actual, string memory what) internal pure {
        if (actual) revert AssertionFailedBool(what, true);
    }

    // --- string -------------------------------------------------------
    function assertEq(string memory actual, string memory expected, string memory what) internal pure {
        if (keccak256(bytes(actual)) != keccak256(bytes(expected))) {
            revert AssertionFailedString(what, expected, actual);
        }
    }

    // --- explicit failure --------------------------------------------
    function fail(string memory what) internal pure {
        revert ExplicitFailure(what);
    }
}
