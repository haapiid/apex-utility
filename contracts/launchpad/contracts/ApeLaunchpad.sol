// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {IUniswapV2Pair, IWETH} from "./interfaces/IUniswapV2.sol";

/// @title ApeLaunchpad
/// @notice pump.fun-style launches on Robinhood Chain. Anyone creates a token; it trades on a
///         constant-product bonding curve with virtual reserves until the curve sells out, then the
///         raised ETH and the reserved tokens become a Uniswap V2 pool whose LP tokens are burned.
/// @dev Money held here = sum of every live curve's realEth + every unclaimed fee. Fees are pulled with
///      claimFees(), so a reverting recipient can never block trading. Selling is never paused.
contract ApeLaunchpad is Ownable2Step, ReentrancyGuard {
    uint256 private constant BPS = 10_000;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // Hard caps the owner can never exceed
    uint256 public constant MAX_TRADE_FEE_BPS = 200; // protocol 2%
    uint256 public constant MAX_CREATOR_FEE_BPS = 100; // creator 1%
    uint256 public constant MAX_GRADUATION_FEE_BPS = 1_000; // 10% of the raised ETH
    uint256 public constant MAX_CREATE_FEE = 0.1 ether;

    struct LaunchParams {
        uint256 virtualEth; // starting virtual ETH reserve
        uint256 virtualTokens; // starting virtual token reserve
        uint256 curveTokens; // tokens sold on the curve; the rest of the supply is reserved for the pool
    }

    struct Curve {
        address creator;
        uint256 virtualEth;
        uint256 virtualTokens;
        uint256 realEth; // ETH paid into the curve (fees excluded)
        uint256 tokensLeft; // curve tokens not sold yet
        uint256 poolTokens; // tokens reserved for the Uniswap pool
        bool graduated;
    }

    address public immutable v2Factory;
    address public immutable weth;

    address public treasury;
    uint256 public tradeFeeBps; // to the treasury, on every buy and sell
    uint256 public creatorFeeBps; // to the token's creator, on every buy and sell
    uint256 public graduationFeeBps; // to the treasury, out of the raised ETH at graduation
    uint256 public createFee; // flat ETH per token created
    bool public paused; // stops create and buy, never sell
    LaunchParams public launchParams; // applies to tokens created from now on

    mapping(address token => Curve) public curves;
    mapping(address account => uint256) public feesOwed;
    address[] public allTokens;

    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI, address pair);
    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 fee,
        uint256 virtualEth,
        uint256 virtualTokens
    );
    event Graduated(address indexed token, address indexed pair, uint256 eth, uint256 tokens, uint256 liquidity, uint256 burned, uint256 fee);
    event FeesClaimed(address indexed account, uint256 amount);
    event TreasuryUpdated(address treasury);
    event FeesUpdated(uint256 tradeFeeBps, uint256 creatorFeeBps, uint256 graduationFeeBps, uint256 createFee);
    event LaunchParamsUpdated(uint256 virtualEth, uint256 virtualTokens, uint256 curveTokens);
    event PausedSet(bool paused);

    error ZeroAddress();
    error InvalidParams();
    error FeeTooHigh();
    error Paused();
    error UnknownToken();
    error AlreadyGraduated();
    error Expired();
    error Slippage();
    error ZeroAmount();
    error InsufficientPayment();
    error BadName();
    error TransferFailed();

    modifier notExpired(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    constructor(
        address owner_,
        address treasury_,
        address v2Factory_,
        address weth_,
        LaunchParams memory params
    ) Ownable(owner_) {
        if (treasury_ == address(0) || v2Factory_ == address(0) || weth_ == address(0)) revert ZeroAddress();
        v2Factory = v2Factory_;
        weth = weth_;
        treasury = treasury_;
        tradeFeeBps = 100;
        graduationFeeBps = 200;
        _setLaunchParams(params);
    }

    // ---------------------------------------------------------------- launch & trade

    /// @notice Create a token. ETH above `createFee` is an optional first buy by the creator.
    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 minTokensOut,
        uint256 deadline
    ) external payable nonReentrant notExpired(deadline) returns (address token) {
        if (paused) revert Paused();
        if (msg.value < createFee) revert InsufficientPayment();
        _checkName(name, symbol, metadataURI);

        token = address(new LaunchToken(name, symbol, metadataURI, v2Factory, weth));
        _register(token);
        feesOwed[treasury] += createFee;
        emit TokenCreated(token, msg.sender, name, symbol, metadataURI, LaunchToken(token).pair());

        uint256 devBuy = msg.value - createFee;
        if (devBuy > 0) _buy(token, devBuy, minTokensOut);
    }

    /// @notice Buy with all the ETH sent. If the curve sells out, the unused ETH is refunded and the
    ///         token graduates in the same transaction.
    function buy(address token, uint256 minTokensOut, uint256 deadline)
        external
        payable
        nonReentrant
        notExpired(deadline)
        returns (uint256 tokensOut)
    {
        if (paused) revert Paused();
        tokensOut = _buy(token, msg.value, minTokensOut);
    }

    /// @notice Sell tokens back to the curve. Needs an allowance for this contract.
    function sell(address token, uint256 tokenAmount, uint256 minEthOut, uint256 deadline)
        external
        nonReentrant
        notExpired(deadline)
        returns (uint256 ethOut)
    {
        Curve storage c = _live(token);
        if (tokenAmount == 0) revert ZeroAmount();

        uint256 gross = _ethOut(c, tokenAmount);
        (uint256 fee, uint256 creatorFee) = _fees(gross);
        ethOut = gross - fee - creatorFee;
        if (ethOut < minEthOut || ethOut == 0) revert Slippage();

        c.virtualEth -= gross;
        c.virtualTokens += tokenAmount;
        c.realEth -= gross;
        c.tokensLeft += tokenAmount;
        feesOwed[treasury] += fee;
        feesOwed[c.creator] += creatorFee;

        LaunchToken(token).transferFrom(msg.sender, address(this), tokenAmount);
        emit Trade(token, msg.sender, false, gross, tokenAmount, fee + creatorFee, c.virtualEth, c.virtualTokens);
        _send(msg.sender, ethOut);
    }

    /// @notice Pull accrued fees (treasury and creators).
    function claimFees() external nonReentrant returns (uint256 amount) {
        amount = feesOwed[msg.sender];
        if (amount == 0) revert ZeroAmount();
        feesOwed[msg.sender] = 0;
        emit FeesClaimed(msg.sender, amount);
        _send(msg.sender, amount);
    }

    // ---------------------------------------------------------------- views

    /// @return tokensOut tokens received for `ethValue` sent
    /// @return fee protocol + creator fee
    /// @return refund ETH sent back because the curve sells out
    function quoteBuy(address token, uint256 ethValue) external view returns (uint256 tokensOut, uint256 fee, uint256 refund) {
        Curve storage c = _live(token);
        (tokensOut, , fee, , refund) = _buyAmounts(c, ethValue);
    }

    /// @return ethOut ETH received after fees
    /// @return fee protocol + creator fee
    function quoteSell(address token, uint256 tokenAmount) external view returns (uint256 ethOut, uint256 fee) {
        Curve storage c = _live(token);
        uint256 gross = _ethOut(c, tokenAmount);
        (uint256 f, uint256 cf) = _fees(gross);
        fee = f + cf;
        ethOut = gross - fee;
    }

    /// @notice Spot price in wei per whole token (1e18 units).
    function price(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        return (c.virtualEth * 1 ether) / c.virtualTokens;
    }

    /// @notice How much of the curve is sold, in basis points.
    function progressBps(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.graduated) return BPS;
        uint256 curveTokens = LaunchToken(token).TOTAL_SUPPLY() - c.poolTokens;
        return ((curveTokens - c.tokensLeft) * BPS) / curveTokens;
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    // ---------------------------------------------------------------- owner

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setFees(uint256 tradeFeeBps_, uint256 creatorFeeBps_, uint256 graduationFeeBps_, uint256 createFee_)
        external
        onlyOwner
    {
        if (
            tradeFeeBps_ > MAX_TRADE_FEE_BPS || creatorFeeBps_ > MAX_CREATOR_FEE_BPS
                || graduationFeeBps_ > MAX_GRADUATION_FEE_BPS || createFee_ > MAX_CREATE_FEE
        ) revert FeeTooHigh();
        tradeFeeBps = tradeFeeBps_;
        creatorFeeBps = creatorFeeBps_;
        graduationFeeBps = graduationFeeBps_;
        createFee = createFee_;
        emit FeesUpdated(tradeFeeBps_, creatorFeeBps_, graduationFeeBps_, createFee_);
    }

    /// @notice Curve shape for tokens created from now on. Existing curves keep theirs.
    function setLaunchParams(LaunchParams calldata params) external onlyOwner {
        _setLaunchParams(params);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    // ---------------------------------------------------------------- internals

    function _setLaunchParams(LaunchParams memory p) private {
        uint256 supply = 1_000_000_000 ether;
        if (p.virtualEth == 0 || p.curveTokens == 0 || p.curveTokens >= supply || p.virtualTokens <= p.curveTokens) {
            revert InvalidParams();
        }
        // The reserved tokens must cover the pool at the curve's final price, or the pool would open cheaper
        uint256 endTokens = p.virtualTokens - p.curveTokens;
        uint256 endEth = Math.mulDiv(p.virtualEth, p.virtualTokens, endTokens, Math.Rounding.Ceil);
        uint256 poolNeeds = Math.mulDiv(endEth - p.virtualEth, endTokens, endEth);
        if (poolNeeds > supply - p.curveTokens) revert InvalidParams();
        launchParams = p;
        emit LaunchParamsUpdated(p.virtualEth, p.virtualTokens, p.curveTokens);
    }

    function _checkName(string calldata name, string calldata symbol, string calldata metadataURI) private pure {
        uint256 nameLen = bytes(name).length;
        uint256 symbolLen = bytes(symbol).length;
        if (nameLen == 0 || nameLen > 32 || symbolLen == 0 || symbolLen > 10 || bytes(metadataURI).length > 256) {
            revert BadName();
        }
    }

    function _register(address token) private {
        LaunchParams memory p = launchParams;
        curves[token] = Curve({
            creator: msg.sender,
            virtualEth: p.virtualEth,
            virtualTokens: p.virtualTokens,
            realEth: 0,
            tokensLeft: p.curveTokens,
            poolTokens: LaunchToken(token).TOTAL_SUPPLY() - p.curveTokens,
            graduated: false
        });
        allTokens.push(token);
    }

    function _live(address token) private view returns (Curve storage c) {
        c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();
    }

    function _fees(uint256 amount) private view returns (uint256 fee, uint256 creatorFee) {
        fee = (amount * tradeFeeBps) / BPS;
        creatorFee = (amount * creatorFeeBps) / BPS;
    }

    // Rounding always favours the curve, so virtualEth * virtualTokens never shrinks
    function _tokensOut(Curve storage c, uint256 ethIn) private view returns (uint256) {
        uint256 k = c.virtualEth * c.virtualTokens;
        return c.virtualTokens - Math.ceilDiv(k, c.virtualEth + ethIn);
    }

    function _ethInFor(Curve storage c, uint256 tokens) private view returns (uint256) {
        uint256 k = c.virtualEth * c.virtualTokens;
        return Math.ceilDiv(k, c.virtualTokens - tokens) - c.virtualEth;
    }

    function _ethOut(Curve storage c, uint256 tokens) private view returns (uint256) {
        uint256 k = c.virtualEth * c.virtualTokens;
        return c.virtualEth - Math.ceilDiv(k, c.virtualTokens + tokens);
    }

    function _buyAmounts(Curve storage c, uint256 value)
        private
        view
        returns (uint256 tokensOut, uint256 ethIn, uint256 fee, uint256 creatorFee, uint256 refund)
    {
        (fee, creatorFee) = _fees(value);
        ethIn = value - fee - creatorFee;
        tokensOut = _tokensOut(c, ethIn);
        if (tokensOut >= c.tokensLeft) {
            tokensOut = c.tokensLeft;
            ethIn = _ethInFor(c, tokensOut);
            (fee, creatorFee) = _fees(ethIn);
            refund = value - ethIn - fee - creatorFee;
        }
    }

    function _buy(address token, uint256 value, uint256 minTokensOut) private returns (uint256 tokensOut) {
        Curve storage c = _live(token);
        if (value == 0) revert ZeroAmount();

        uint256 ethIn;
        uint256 fee;
        uint256 creatorFee;
        uint256 refund;
        (tokensOut, ethIn, fee, creatorFee, refund) = _buyAmounts(c, value);
        if (tokensOut < minTokensOut || tokensOut == 0) revert Slippage();

        c.virtualEth += ethIn;
        c.virtualTokens -= tokensOut;
        c.realEth += ethIn;
        c.tokensLeft -= tokensOut;
        feesOwed[treasury] += fee;
        feesOwed[c.creator] += creatorFee;

        LaunchToken(token).transfer(msg.sender, tokensOut);
        emit Trade(token, msg.sender, true, ethIn, tokensOut, fee + creatorFee, c.virtualEth, c.virtualTokens);

        if (c.tokensLeft == 0) _graduate(token, c);
        if (refund > 0) _send(msg.sender, refund);
    }

    /// @dev Liquidity goes straight into the pair (transfer + mint) instead of through the router: the
    ///      router reverts on a pool someone has pre-funded with WETH, a direct mint does not. Pool price =
    ///      the curve's final price; reserved tokens the pool doesn't need are burned.
    function _graduate(address token, Curve storage c) private {
        c.graduated = true;
        uint256 eth = c.realEth;
        c.realEth = 0;
        uint256 fee = (eth * graduationFeeBps) / BPS;
        eth -= fee;
        feesOwed[treasury] += fee;

        uint256 tokens = Math.mulDiv(eth, c.virtualTokens, c.virtualEth);
        if (tokens > c.poolTokens) tokens = c.poolTokens;
        uint256 burned = c.poolTokens - tokens;
        c.poolTokens = 0;

        LaunchToken t = LaunchToken(token);
        address pair = t.pair();
        t.openTrading();
        IWETH(weth).deposit{value: eth}();
        if (!IWETH(weth).transfer(pair, eth)) revert TransferFailed();
        t.transfer(pair, tokens);
        uint256 liquidity = IUniswapV2Pair(pair).mint(DEAD);
        if (burned > 0) t.burn(burned);

        emit Graduated(token, pair, eth, tokens, liquidity, burned, fee);
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
