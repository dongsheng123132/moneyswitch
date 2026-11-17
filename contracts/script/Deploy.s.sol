// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {QDayPayReceiver} from "../src/QDayPayReceiver.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";
import {MiniConsole} from "./utils/MiniConsole.sol";

/// @title DeployQDayPayReceiver
/// @notice Deploys {QDayPayReceiver} to QDay Aevum testnet (chainId 44005).
///
/// @dev Environment variables (the private key is read from the environment only, never stored):
///   PRIVATE_KEY   required - deployer key, must hold ETH on the target chain for gas.
///   TUSD8         optional - settlement token, defaults to QDay testnet tUSD8.
///   OWNER         optional - receiver owner, defaults to the deployer.
///   BENEFICIARY   optional - merchant payout address, defaults to OWNER.
///
/// Usage (local fork):
///   PRIVATE_KEY=0x... forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8547 --broadcast
///
/// Usage (real testnet):
///   PRIVATE_KEY=0x... BENEFICIARY=0xmerchant \
///     forge script script/Deploy.s.sol --rpc-url https://rpc-test.qday.info --broadcast
contract DeployQDayPayReceiver is ScriptBase {
    /// @notice tUSD8 on QDay Aevum testnet (6 decimals, EIP-3009 enabled).
    address internal constant TUSD8_QDAY_TESTNET = 0x456569838f1d43009A91ebA4263147Afd7233483;

    function run() external returns (QDayPayReceiver receiver) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address tokenAddr = vm.envOr("TUSD8", TUSD8_QDAY_TESTNET);
        address ownerAddr = vm.envOr("OWNER", deployer);
        address beneficiaryAddr = vm.envOr("BENEFICIARY", ownerAddr);

        MiniConsole.log("== QDayPayReceiver deployment ==");
        MiniConsole.log("chainId", block.chainid);
        MiniConsole.log("deployer", deployer);
        MiniConsole.log("constructor arg token (settlement)", tokenAddr);
        MiniConsole.log("constructor arg owner", ownerAddr);
        MiniConsole.log("constructor arg beneficiary", beneficiaryAddr);

        vm.startBroadcast(deployerKey);
        receiver = new QDayPayReceiver(tokenAddr, ownerAddr, beneficiaryAddr);
        vm.stopBroadcast();

        MiniConsole.log("== deployed ==");
        MiniConsole.log("QDayPayReceiver", address(receiver));
    }
}
