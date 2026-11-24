// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {QuorumVault} from "../src/QuorumVault.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockAdapter} from "../src/mocks/MockAdapter.sol";
import {AdapterBase} from "../src/adapters/AdapterBase.sol";

contract QuorumVaultTest is Test {
    QuorumVault internal vault;
    MockERC20 internal usdt;
    MockERC20 internal hsk;
    MockAdapter internal adapter;
    address internal agent = makeAddr("agent");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant DEPOSIT = 10_000e18;

    function setUp() public {
        usdt = new MockERC20("Tether USD", "USDT", 18);
        hsk = new MockERC20("HashKey Token", "HSK", 18);
        adapter = new MockAdapter();
        vault = new QuorumVault(address(usdt), agent, address(adapter));
        adapter.bindVault(address(vault));
        vault.setTokenAllowed(address(hsk), true);

        // 1 USDT = 2 HSK, 1 HSK = 0.5 USDT
        adapter.setRate(address(usdt), address(hsk), 2e18);
        adapter.setRate(address(hsk), address(usdt), 0.5e18);
        usdt.mint(address(adapter), 1_000_000e18);
        hsk.mint(address(adapter), 1_000_000e18);

        usdt.mint(address(this), DEPOSIT);
        usdt.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT);
    }

    // ------------------------------------------------------------ helpers

    function _t(address token, uint256 amountIn, uint256 expectedOut, uint8 votes)
        internal
        pure
        returns (QuorumVault.Trade memory)
    {
        return QuorumVault.Trade({
            token: token,
            amountIn: amountIn,
            expectedOut: expectedOut,
            minOut: (expectedOut * 9950) / 10_000, // 0.5% slippage, inside the 1% policy
            reasoningHash: keccak256(abi.encodePacked("council-transcript", amountIn)),
            votes: votes
        });
    }

    function _buy(uint256 usdtIn) internal returns (uint256) {
        vm.prank(agent);
        return vault.buy(_t(address(hsk), usdtIn, usdtIn * 2, 2));
    }

    // ------------------------------------------------------------ happy paths

    function test_DepositSetsEquity() public view {
        assertEq(usdt.balanceOf(address(vault)), DEPOSIT);
        assertEq(vault.equityAtCost(), DEPOSIT);
        QuorumVault.Snapshot memory s = vault.snapshot();
        assertEq(s.dayStartEquity, DEPOSIT);
        assertEq(s.baseBalance, DEPOSIT);
    }

    function test_BuyWithinLimits() public {
        uint256 out = _buy(1_000e18);
        assertEq(out, 2_000e18);
        assertEq(hsk.balanceOf(address(vault)), 2_000e18);
        assertEq(usdt.balanceOf(address(vault)), DEPOSIT - 1_000e18);
        assertEq(vault.costBasis(address(hsk)), 1_000e18);
        assertEq(vault.totalCostBasis(), 1_000e18);
        assertEq(vault.tradeCount(), 1);
        assertEq(vault.equityAtCost(), DEPOSIT);
    }

    function test_SellWithProfit() public {
        _buy(1_000e18);
        adapter.setRate(address(hsk), address(usdt), 0.6e18); // HSK +20%
        vm.prank(agent);
        uint256 out = vault.sell(_t(address(hsk), 2_000e18, 1_200e18, 2));
        assertEq(out, 1_200e18);
        assertEq(vault.realizedPnlTotal(), int256(200e18));
        assertEq(vault.costBasis(address(hsk)), 0);
        assertEq(vault.totalCostBasis(), 0);
        assertEq(usdt.balanceOf(address(vault)), DEPOSIT + 200e18);
    }

    function test_PartialSellUsesProportionalCost() public {
        _buy(1_000e18); // 2000 HSK at cost 1000
        vm.prank(agent);
        vault.sell(_t(address(hsk), 500e18, 250e18, 2)); // a quarter at break-even
        assertEq(vault.costBasis(address(hsk)), 750e18);
        assertEq(vault.realizedPnlTotal(), 0);
    }

    function test_AttestDecision() public {
        vm.prank(agent);
        vault.attest(keccak256("hold"), 0, 3);
    }

    // ------------------------------------------------------------ guardrails

    function test_RevertWhen_NotAgent() public {
        vm.prank(stranger);
        vm.expectRevert(QuorumVault.NotAgent.selector);
        vault.buy(_t(address(hsk), 100e18, 200e18, 2));
    }

    function test_RevertWhen_TradeTooLarge() public {
        // max 20% of 10_000 = 2_000
        vm.prank(agent);
        vm.expectRevert(QuorumVault.TradeTooLarge.selector);
        vault.buy(_t(address(hsk), 2_001e18, 4_002e18, 2));
    }

    function test_RevertWhen_QuorumNotMet() public {
        vm.prank(agent);
        vm.expectRevert(QuorumVault.QuorumNotMet.selector);
        vault.buy(_t(address(hsk), 100e18, 200e18, 1));
    }

    function test_RevertWhen_SlippageTooWide() public {
        QuorumVault.Trade memory t = _t(address(hsk), 100e18, 200e18, 2);
        t.minOut = (t.expectedOut * 9800) / 10_000; // 2% > 1% policy
        vm.prank(agent);
        vm.expectRevert(QuorumVault.SlippageTooWide.selector);
        vault.buy(t);
    }

    function test_RevertWhen_OutputBelowMin() public {
        adapter.setRate(address(usdt), address(hsk), 1.9e18); // market moved against the quote
        vm.prank(agent);
        vm.expectRevert(MockAdapter.Slippage.selector);
        vault.buy(_t(address(hsk), 100e18, 200e18, 2));
    }

    function test_CooldownBetweenBuys() public {
        _buy(100e18);
        vm.prank(agent);
        vm.expectRevert(QuorumVault.CooldownActive.selector);
        vault.buy(_t(address(hsk), 100e18, 200e18, 2));

        vm.warp(block.timestamp + 61);
        _buy(100e18);
        assertEq(vault.tradeCount(), 2);
    }

    function test_SellsIgnoreCooldown() public {
        _buy(100e18);
        vm.prank(agent);
        vault.sell(_t(address(hsk), 200e18, 100e18, 2)); // same block, still allowed
        assertEq(hsk.balanceOf(address(vault)), 0);
    }

    function test_RevertWhen_DailyTradeLimit() public {
        QuorumVault.Policy memory p = vault.policy();
        p.maxTradesPerDay = 2;
        p.cooldown = 0;
        vault.setPolicy(p);
        _buy(10e18);
        _buy(10e18);
        vm.prank(agent);
        vm.expectRevert(QuorumVault.DailyTradeLimit.selector);
        vault.buy(_t(address(hsk), 10e18, 20e18, 2));

        vm.warp(block.timestamp + 1 days);
        _buy(10e18); // new day, counter reset
    }

    function test_RevertWhen_PositionTooLarge() public {
        QuorumVault.Policy memory p = vault.policy();
        p.maxTradeBps = 5000;
        p.cooldown = 0;
        vault.setPolicy(p);
        _buy(2_500e18);
        _buy(2_500e18); // exactly 50% of equity
        vm.prank(agent);
        vm.expectRevert(QuorumVault.PositionTooLarge.selector);
        vault.buy(_t(address(hsk), 100e18, 200e18, 2));
    }

    function test_RevertWhen_TokenNotAllowed() public {
        MockERC20 rogue = new MockERC20("Rogue", "RUG", 18);
        vm.prank(agent);
        vm.expectRevert(QuorumVault.TokenNotAllowed.selector);
        vault.buy(_t(address(rogue), 100e18, 200e18, 2));
    }

    function test_CircuitBreakerHaltsBuysButNotSells() public {
        _buy(2_000e18); // 4000 HSK, cost 2000
        adapter.setRate(address(hsk), address(usdt), 0.3e18); // HSK -40%

        // sell 3000 HSK: cost portion 1500, out 900 -> loss 600 > 5% of 10_000 (500)
        vm.prank(agent);
        vault.sell(_t(address(hsk), 3_000e18, 900e18, 2));
        assertTrue(vault.isHalted());

        // exits still work while halted
        vm.prank(agent);
        vault.sell(_t(address(hsk), 1_000e18, 300e18, 2));
        assertEq(hsk.balanceOf(address(vault)), 0);

        // new buys are blocked
        vm.warp(block.timestamp + 120);
        vm.prank(agent);
        vm.expectRevert(QuorumVault.BuysHalted.selector);
        vault.buy(_t(address(hsk), 100e18, 200e18, 2));

        // next UTC day the breaker clears automatically
        vm.warp(block.timestamp + 1 days);
        assertFalse(vault.isHalted());
        _buy(100e18);
    }

    function test_OwnerCanResetBreaker() public {
        _buy(2_000e18);
        adapter.setRate(address(hsk), address(usdt), 0.3e18);
        vm.prank(agent);
        vault.sell(_t(address(hsk), 4_000e18, 1_200e18, 2)); // loss 800
        assertTrue(vault.isHalted());
        vault.resetCircuitBreaker();
        assertFalse(vault.isHalted());
    }

    function test_PauseBlocksAgentButNotOwner() public {
        vault.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(QuorumVault.VaultPaused.selector);
        vault.buy(_t(address(hsk), 100e18, 200e18, 2));

        vm.prank(agent);
        vm.expectRevert(QuorumVault.VaultPaused.selector);
        vault.attest(keccak256("x"), 0, 3);

        vault.withdraw(address(usdt), 1_000e18, address(this));
        assertEq(usdt.balanceOf(address(this)), 1_000e18);
    }

    function test_AgentCanNeverWithdraw() public {
        vm.prank(agent);
        vm.expectRevert(QuorumVault.NotOwner.selector);
        vault.withdraw(address(usdt), 1, agent);
    }

    function test_WithdrawTokenReducesCostBasis() public {
        _buy(1_000e18);
        vault.withdraw(address(hsk), 1_000e18, address(this)); // half the HSK
        assertEq(vault.costBasis(address(hsk)), 500e18);
        assertEq(vault.totalCostBasis(), 500e18);
    }

    function test_RevertWhen_InvalidPolicy() public {
        QuorumVault.Policy memory p = vault.policy();
        p.quorum = 4;
        vm.expectRevert(QuorumVault.InvalidPolicy.selector);
        vault.setPolicy(p);
    }

    function test_RevertWhen_StrangerSetsPolicy() public {
        QuorumVault.Policy memory p = vault.policy();
        vm.prank(stranger);
        vm.expectRevert(QuorumVault.NotOwner.selector);
        vault.setPolicy(p);
    }

    function test_AdapterOnlyCallableByVault() public {
        vm.expectRevert(AdapterBase.NotVault.selector);
        adapter.swap(address(usdt), address(hsk), 1e18, 1, stranger);
    }

    function test_MockAdapterSetRatesBatch() public {
        address[] memory ins = new address[](2);
        address[] memory outs = new address[](2);
        uint256[] memory rates = new uint256[](2);
        ins[0] = address(usdt);
        outs[0] = address(hsk);
        rates[0] = 4e18;
        ins[1] = address(hsk);
        outs[1] = address(usdt);
        rates[1] = 0.25e18;
        adapter.setRates(ins, outs, rates);
        assertEq(adapter.rate(address(usdt), address(hsk)), 4e18);
        assertEq(adapter.rate(address(hsk), address(usdt)), 0.25e18);

        vm.prank(stranger);
        vm.expectRevert(AdapterBase.NotDeployer.selector);
        adapter.setRates(ins, outs, rates);
    }

    function test_PositionsView() public {
        _buy(1_000e18);
        (address[] memory list, uint256[] memory bals, uint256[] memory costs, bool[] memory allowed) =
            vault.positions();
        assertEq(list.length, 1);
        assertEq(list[0], address(hsk));
        assertEq(bals[0], 2_000e18);
        assertEq(costs[0], 1_000e18);
        assertTrue(allowed[0]);
    }

    function testFuzz_BuyNeverExceedsMaxTrade(uint256 amount) public {
        amount = bound(amount, 1e18, DEPOSIT);
        vm.prank(agent);
        if (amount * 10_000 > 2000 * DEPOSIT) {
            vm.expectRevert(QuorumVault.TradeTooLarge.selector);
        }
        vault.buy(_t(address(hsk), amount, amount * 2, 2));
    }
}
