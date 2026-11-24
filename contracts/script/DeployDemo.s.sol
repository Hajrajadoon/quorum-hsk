// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {QuorumVault} from "../src/QuorumVault.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockAdapter} from "../src/mocks/MockAdapter.sol";

/// @notice Self-contained demo deployment: demo tokens + a fixed-rate venue whose price the
///         agent's "market feed" key can move. Use it when the real pool is too thin to show
///         live trading on stage. Works on HSK testnet (133) and mainnet (177).
///
/// Required env:
///   PRIVATE_KEY      deployer = vault owner = demo market-feed key
///   AGENT_ADDRESS    the AI agent's hot wallet
contract DeployDemo is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address agentAddr = vm.envAddress("AGENT_ADDRESS");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        MockERC20 usdt = new MockERC20("Quorum Demo USD", "qUSD", 18);
        MockERC20 hsk = new MockERC20("Quorum Demo HSK", "qHSK", 18);
        MockERC20 eth = new MockERC20("Quorum Demo ETH", "qETH", 18);
        MockAdapter adapter = new MockAdapter();
        QuorumVault vault = new QuorumVault(address(usdt), agentAddr, address(adapter));
        adapter.bindVault(address(vault));
        vault.setTokenAllowed(address(hsk), true);
        vault.setTokenAllowed(address(eth), true);

        // starting prices: HSK = 0.50 USD, ETH = 3000 USD
        adapter.setRate(address(usdt), address(hsk), 2e18);
        adapter.setRate(address(hsk), address(usdt), 0.5e18);
        adapter.setRate(address(usdt), address(eth), uint256(1e18) / 3000);
        adapter.setRate(address(eth), address(usdt), 3000e18);

        // venue reserves
        usdt.mint(address(adapter), 10_000_000e18);
        hsk.mint(address(adapter), 10_000_000e18);
        eth.mint(address(adapter), 10_000e18);

        // fund the vault with 10,000 qUSD
        usdt.mint(deployer, 10_000e18);
        usdt.approve(address(vault), 10_000e18);
        vault.deposit(10_000e18);

        vm.stopBroadcast();

        console2.log("QuorumVault :", address(vault));
        console2.log("MockAdapter :", address(adapter));
        console2.log("qUSD (base) :", address(usdt));
        console2.log("qHSK        :", address(hsk));
        console2.log("qETH        :", address(eth));
    }
}
