// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {QuorumVault} from "../src/QuorumVault.sol";
import {UniswapV2Adapter} from "../src/adapters/UniswapV2Adapter.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";
import {AdapterBase} from "../src/adapters/AdapterBase.sol";

/// @notice Deploys QuorumVault wired to a real HSKSwap router (V2 or V3).
///
/// Required env:
///   PRIVATE_KEY      deployer = vault owner
///   AGENT_ADDRESS    the AI agent's hot wallet (can trade, can never withdraw)
///   BASE_TOKEN       base asset of the vault (e.g. USDT on HSK Chain)
///   TRADE_TOKENS     comma-separated token addresses the agent may buy (e.g. WHSK,WETH)
///   ADAPTER_KIND     "v2" or "v3"
///   ROUTER           HSKSwap router address
/// Optional env (v3 only):
///   QUOTER           QuoterV2 address
///   V3_LEGACY        true if the router is the original SwapRouter (with deadline). Default false.
///   V3_FEE           default pool fee tier, e.g. 3000. Default 3000.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address agentAddr = vm.envAddress("AGENT_ADDRESS");
        address base = vm.envAddress("BASE_TOKEN");
        address[] memory tradeTokens = vm.envAddress("TRADE_TOKENS", ",");
        string memory kind = vm.envString("ADAPTER_KIND");
        address router = vm.envAddress("ROUTER");

        vm.startBroadcast(pk);

        address adapter;
        if (keccak256(bytes(kind)) == keccak256("v2")) {
            adapter = address(new UniswapV2Adapter(router));
        } else if (keccak256(bytes(kind)) == keccak256("v3")) {
            address quoter = vm.envAddress("QUOTER");
            bool legacy = vm.envOr("V3_LEGACY", false);
            uint256 fee = vm.envOr("V3_FEE", uint256(3000));
            adapter = address(new UniswapV3Adapter(router, quoter, legacy, uint24(fee)));
        } else {
            revert("ADAPTER_KIND must be v2 or v3");
        }

        QuorumVault vault = new QuorumVault(base, agentAddr, adapter);
        AdapterBase(adapter).bindVault(address(vault));
        for (uint256 i = 0; i < tradeTokens.length; i++) {
            vault.setTokenAllowed(tradeTokens[i], true);
        }

        vm.stopBroadcast();

        console2.log("QuorumVault :", address(vault));
        console2.log("Adapter     :", adapter);
        console2.log("Owner       :", vm.addr(pk));
        console2.log("Agent       :", agentAddr);
    }
}
