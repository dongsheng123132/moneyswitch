// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Vm
/// @notice The subset of Foundry cheatcodes used by the deploy script (locally declared so the
///         project needs no vendored forge-std).
interface Vm {
    function addr(uint256 privateKey) external pure returns (address keyAddr);

    function envUint(string calldata name) external view returns (uint256 value);

    function envAddress(string calldata name) external view returns (address value);

    function envOr(string calldata name, address defaultValue) external view returns (address value);

    function startBroadcast(uint256 privateKey) external;

    function stopBroadcast() external;
}

/// @title ScriptBase
/// @notice Tiny base for forge scripts: gives access to `vm`.
abstract contract ScriptBase {
    address internal constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));
    Vm internal constant vm = Vm(VM_ADDRESS);
}
