// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {SafeTransfer} from "./libraries/SafeTransfer.sol";

/// @title QuorumVault
/// @notice A guarded trading vault for an AI agent council on HSK Chain.
///
///         The owner deposits a base asset (e.g. USDT). An AI agent key may trade the base asset
///         against whitelisted tokens through a DEX adapter (HSKSwap), but only inside the risk
///         policy enforced right here, on-chain:
///           - the agent can NEVER withdraw funds; only the owner can
///           - max size per buy (bps of base balance) and max exposure per token (bps of equity)
///           - slippage bound on every swap (minOut vs expectedOut)
///           - cooldown between buys and max buys per day (trade frequency)
///           - a daily realized-loss circuit breaker that halts new buys until the next UTC day
///           - a quorum: every trade must carry >= `policy.quorum` council votes
///           - "Proof of Reasoning": every trade / decision commits the keccak256 hash of the
///             council's full reasoning transcript, so anyone can verify why a trade happened
///         Exits (sells) are never blocked by cooldowns or the circuit breaker, so the agent can
///         always de-risk. The owner kill switch (`paused`) stops the agent completely.
contract QuorumVault {
    using SafeTransfer for address;

    // ------------------------------------------------------------------ types

    struct Policy {
        uint16 maxTradeBps; // max base spent per buy, in bps of the vault's base balance
        uint16 maxPositionBps; // max cost basis per token, in bps of equity (base + total cost basis)
        uint16 maxSlippageBps; // minOut must be >= expectedOut * (1 - maxSlippageBps)
        uint16 maxDailyLossBps; // realized loss per day (bps of day-start equity) that trips the breaker
        uint16 stopLossBps; // agent-side exit rule, stored on-chain as the single source of truth
        uint16 takeProfitBps; // agent-side exit rule, stored on-chain as the single source of truth
        uint16 maxTradesPerDay; // max buys per UTC day
        uint32 cooldown; // min seconds between two buys
        uint8 quorum; // min council votes (out of 3) required for any trade
    }

    struct Trade {
        address token; // the non-base token being bought or sold
        uint256 amountIn; // base amount (buy) or token amount (sell)
        uint256 expectedOut; // quoted output used to bound slippage
        uint256 minOut; // hard minimum output
        bytes32 reasoningHash; // keccak256 of the council transcript (JSON)
        uint8 votes; // number of council members that voted for this action
    }

    struct TradeRecord {
        bool isBuy;
        uint256 amountIn;
        uint256 amountOut;
        uint256 expectedOut;
        int256 pnl; // realized PnL in base units (0 for buys)
        bytes32 reasoningHash;
        uint8 votes;
    }

    struct Snapshot {
        uint256 baseBalance;
        uint256 totalCostBasis;
        int256 realizedPnlTotal;
        uint256 realizedLossToday;
        uint256 dayStartEquity;
        uint16 buysToday;
        uint64 lastBuyAt;
        uint64 haltedUntil;
        bool halted;
        bool paused;
        uint256 tradeCount;
        uint256 timestamp;
    }

    // ------------------------------------------------------------------ errors

    error NotOwner();
    error NotAgent();
    error VaultPaused();
    error BuysHalted();
    error TokenNotAllowed();
    error ZeroAmount();
    error ZeroAddress();
    error TradeTooLarge();
    error PositionTooLarge();
    error CooldownActive();
    error DailyTradeLimit();
    error QuorumNotMet();
    error SlippageTooWide();
    error InsufficientOutput();
    error InsufficientBalance();
    error InvalidPolicy();
    error Reentrancy();

    // ------------------------------------------------------------------ events

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event PolicyUpdated(Policy newPolicy);
    event AgentUpdated(address indexed agent);
    event AdapterUpdated(address indexed adapter);
    event TokenAllowed(address indexed token, bool allowed);
    event PausedSet(bool paused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TradeExecuted(uint256 indexed id, address indexed token, TradeRecord record);
    event DecisionAttested(bytes32 indexed reasoningHash, uint8 action, uint8 votes);
    event CircuitBreakerTripped(uint64 day, uint256 lossToday, uint256 limit);
    event CircuitBreakerReset();

    // ------------------------------------------------------------------ state

    uint256 private constant BPS = 10_000;

    address public immutable baseToken;
    address public owner;
    address public agent;
    ISwapAdapter public adapter;
    Policy internal _policy;
    bool public paused;

    mapping(address => bool) public allowedToken;
    address[] internal _tokenList;
    mapping(address => bool) internal _listed;

    mapping(address => uint256) public costBasis; // base units spent on the current holding of a token
    uint256 public totalCostBasis;

    uint64 public currentDay;
    uint64 public lastBuyAt;
    uint64 public haltedUntil; // buys are halted while block.timestamp < haltedUntil
    uint16 public tradesToday;
    uint256 public dayStartEquity;
    uint256 public realizedLossToday;
    int256 public realizedPnlTotal;
    uint256 public tradeCount;

    uint256 private _lock = 1;

    // ------------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------------------------------------------------------------ constructor

    constructor(address baseToken_, address agent_, address adapter_) {
        if (baseToken_ == address(0) || agent_ == address(0) || adapter_ == address(0)) revert ZeroAddress();
        baseToken = baseToken_;
        owner = msg.sender;
        agent = agent_;
        adapter = ISwapAdapter(adapter_);
        currentDay = uint64(block.timestamp / 1 days);

        Policy memory p = Policy({
            maxTradeBps: 2000, // 20% of base per buy
            maxPositionBps: 5000, // 50% of equity per token
            maxSlippageBps: 100, // 1%
            maxDailyLossBps: 500, // 5% realized loss per day trips the breaker
            stopLossBps: 300, // 3%
            takeProfitBps: 600, // 6%
            maxTradesPerDay: 48,
            cooldown: 60, // 1 minute between buys
            quorum: 2 // 2 of 3 council members
        });
        _setPolicy(p);

        emit OwnershipTransferred(address(0), msg.sender);
        emit AgentUpdated(agent_);
        emit AdapterUpdated(adapter_);
    }

    // ------------------------------------------------------------------ owner actions

    function deposit(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _rollDay();
        baseToken.safeTransferFrom(msg.sender, address(this), amount);
        dayStartEquity += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        _rollDay();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (amount > bal) revert InsufficientBalance();

        if (token == baseToken) {
            dayStartEquity = amount >= dayStartEquity ? 0 : dayStartEquity - amount;
        } else {
            uint256 costPortion = (costBasis[token] * amount) / bal;
            costBasis[token] -= costPortion;
            totalCostBasis -= costPortion;
            dayStartEquity = costPortion >= dayStartEquity ? 0 : dayStartEquity - costPortion;
        }
        token.safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    function setPolicy(Policy calldata p) external onlyOwner {
        _setPolicy(p);
    }

    function setAgent(address agent_) external onlyOwner {
        if (agent_ == address(0)) revert ZeroAddress();
        agent = agent_;
        emit AgentUpdated(agent_);
    }

    function setAdapter(address adapter_) external onlyOwner {
        if (adapter_ == address(0)) revert ZeroAddress();
        adapter = ISwapAdapter(adapter_);
        emit AdapterUpdated(adapter_);
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        if (token == address(0) || token == baseToken) revert TokenNotAllowed();
        allowedToken[token] = allowed;
        if (!_listed[token]) {
            _listed[token] = true;
            _tokenList.push(token);
        }
        emit TokenAllowed(token, allowed);
    }

    /// @notice Owner kill switch. While paused the agent can do nothing at all.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function resetCircuitBreaker() external onlyOwner {
        haltedUntil = 0;
        realizedLossToday = 0;
        emit CircuitBreakerReset();
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ------------------------------------------------------------------ agent actions

    /// @notice Spend base asset to buy `t.token`.
    function buy(Trade calldata t) external onlyAgent nonReentrant returns (uint256 amountOut) {
        _validate(t);
        if (!allowedToken[t.token]) revert TokenNotAllowed();
        _rollDay();
        if (block.timestamp < haltedUntil) revert BuysHalted();
        if (lastBuyAt != 0 && block.timestamp < uint256(lastBuyAt) + _policy.cooldown) revert CooldownActive();
        if (tradesToday >= _policy.maxTradesPerDay) revert DailyTradeLimit();

        uint256 baseBal = IERC20(baseToken).balanceOf(address(this));
        if (t.amountIn * BPS > uint256(_policy.maxTradeBps) * baseBal) revert TradeTooLarge();
        uint256 equity = baseBal + totalCostBasis;
        if ((costBasis[t.token] + t.amountIn) * BPS > uint256(_policy.maxPositionBps) * equity) {
            revert PositionTooLarge();
        }

        tradesToday += 1;
        lastBuyAt = uint64(block.timestamp);

        amountOut = _swap(baseToken, t.token, t);
        costBasis[t.token] += t.amountIn;
        totalCostBasis += t.amountIn;

        _emitTrade(t, true, amountOut, 0);
    }

    /// @notice Sell `t.amountIn` of `t.token` back to the base asset. Never blocked by cooldowns
    ///         or the circuit breaker, so the agent can always reduce risk.
    function sell(Trade calldata t) external onlyAgent nonReentrant returns (uint256 amountOut) {
        _validate(t);
        if (!allowedToken[t.token] && costBasis[t.token] == 0) revert TokenNotAllowed();
        _rollDay();

        uint256 bal = IERC20(t.token).balanceOf(address(this));
        if (t.amountIn > bal) revert InsufficientBalance();
        uint256 costPortion = (costBasis[t.token] * t.amountIn) / bal;

        amountOut = _swap(t.token, baseToken, t);
        costBasis[t.token] -= costPortion;
        totalCostBasis -= costPortion;

        int256 pnl = int256(amountOut) - int256(costPortion);
        realizedPnlTotal += pnl;
        if (pnl < 0) {
            realizedLossToday += uint256(-pnl);
            _checkCircuitBreaker();
        }

        _emitTrade(t, false, amountOut, pnl);
    }

    /// @notice Commit the hash of a council decision that did not trade (e.g. HOLD or a veto).
    /// @param action 0 = HOLD, 1 = BUY, 2 = SELL, 3 = VETO (risk officer), 4 = BLOCKED (guardrail)
    function attest(bytes32 reasoningHash, uint8 action, uint8 votes) external onlyAgent {
        if (paused) revert VaultPaused();
        emit DecisionAttested(reasoningHash, action, votes);
    }

    // ------------------------------------------------------------------ views

    function policy() external view returns (Policy memory) {
        return _policy;
    }

    function tokens() external view returns (address[] memory) {
        return _tokenList;
    }

    function equityAtCost() public view returns (uint256) {
        return IERC20(baseToken).balanceOf(address(this)) + totalCostBasis;
    }

    function isHalted() external view returns (bool) {
        return block.timestamp < haltedUntil;
    }

    /// @notice Everything the dashboard / agent needs in one call.
    function snapshot() external view returns (Snapshot memory snap) {
        bool sameDay = uint64(block.timestamp / 1 days) == currentDay;
        snap.baseBalance = IERC20(baseToken).balanceOf(address(this));
        snap.totalCostBasis = totalCostBasis;
        snap.realizedPnlTotal = realizedPnlTotal;
        snap.realizedLossToday = sameDay ? realizedLossToday : 0;
        snap.dayStartEquity = sameDay ? dayStartEquity : snap.baseBalance + totalCostBasis;
        snap.buysToday = sameDay ? tradesToday : 0;
        snap.lastBuyAt = lastBuyAt;
        snap.haltedUntil = haltedUntil;
        snap.halted = block.timestamp < haltedUntil;
        snap.paused = paused;
        snap.tradeCount = tradeCount;
        snap.timestamp = block.timestamp;
    }

    function positions()
        external
        view
        returns (address[] memory list, uint256[] memory balances, uint256[] memory costs, bool[] memory allowed)
    {
        uint256 n = _tokenList.length;
        list = _tokenList;
        balances = new uint256[](n);
        costs = new uint256[](n);
        allowed = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            address tkn = _tokenList[i];
            balances[i] = IERC20(tkn).balanceOf(address(this));
            costs[i] = costBasis[tkn];
            allowed[i] = allowedToken[tkn];
        }
    }

    // ------------------------------------------------------------------ internals

    function _validate(Trade calldata t) internal view {
        if (paused) revert VaultPaused();
        if (t.amountIn == 0) revert ZeroAmount();
        if (t.token == address(0) || t.token == baseToken) revert TokenNotAllowed();
        if (t.votes < _policy.quorum) revert QuorumNotMet();
        if (t.expectedOut == 0 || t.minOut == 0) revert SlippageTooWide();
        if (t.minOut * BPS < t.expectedOut * (BPS - _policy.maxSlippageBps)) revert SlippageTooWide();
    }

    function _swap(address tokenIn, address tokenOut, Trade calldata t) internal returns (uint256 amountOut) {
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        tokenIn.safeTransfer(address(adapter), t.amountIn);
        adapter.swap(tokenIn, tokenOut, t.amountIn, t.minOut, address(this));
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - before;
        if (amountOut < t.minOut) revert InsufficientOutput();
    }

    function _emitTrade(Trade calldata t, bool isBuy, uint256 amountOut, int256 pnl) internal {
        TradeRecord memory r = TradeRecord({
            isBuy: isBuy,
            amountIn: t.amountIn,
            amountOut: amountOut,
            expectedOut: t.expectedOut,
            pnl: pnl,
            reasoningHash: t.reasoningHash,
            votes: t.votes
        });
        emit TradeExecuted(++tradeCount, t.token, r);
    }

    function _rollDay() internal {
        uint64 today = uint64(block.timestamp / 1 days);
        if (today != currentDay) {
            currentDay = today;
            tradesToday = 0;
            realizedLossToday = 0;
            dayStartEquity = equityAtCost();
        }
    }

    function _checkCircuitBreaker() internal {
        uint256 limit = (dayStartEquity * _policy.maxDailyLossBps) / BPS;
        if (realizedLossToday > limit && block.timestamp >= haltedUntil) {
            haltedUntil = (uint64(currentDay) + 1) * 1 days;
            emit CircuitBreakerTripped(currentDay, realizedLossToday, limit);
        }
    }

    function _setPolicy(Policy memory p) internal {
        if (
            p.maxTradeBps == 0 || p.maxTradeBps > BPS || p.maxPositionBps == 0 || p.maxPositionBps > BPS
                || p.maxSlippageBps > 1000 || p.maxDailyLossBps == 0 || p.maxDailyLossBps > BPS
                || p.stopLossBps == 0 || p.stopLossBps >= BPS || p.takeProfitBps == 0 || p.maxTradesPerDay == 0
                || p.quorum == 0 || p.quorum > 3
        ) revert InvalidPolicy();
        _policy = p;
        emit PolicyUpdated(p);
    }
}
