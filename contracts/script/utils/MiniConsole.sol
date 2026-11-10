// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MiniConsole
/// @notice Minimal `console.log` shim for forge scripts.
/// @dev forge intercepts calls to the well-known console address and prints them. Declared
///      locally (instead of vendoring forge-std) to keep this project dependency-free.
library MiniConsole {
    address internal constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;

    function log(string memory message) internal view {
        _write(abi.encodeWithSignature("log(string)", message));
    }

    function log(string memory label, address value) internal view {
        _write(abi.encodeWithSignature("log(string,address)", label, value));
    }

    function log(string memory label, uint256 value) internal view {
        _write(abi.encodeWithSignature("log(string,uint256)", label, value));
    }

    function log(string memory label, string memory value) internal view {
        _write(abi.encodeWithSignature("log(string,string)", label, value));
    }

    function _write(bytes memory payload) private view {
        address target = CONSOLE;
        assembly {
            pop(staticcall(gas(), target, add(payload, 0x20), mload(payload), 0, 0))
        }
    }
}
