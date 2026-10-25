// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {TaxLaunchToken} from "./TaxLaunchToken.sol";
import {QuoteRegistry} from "./QuoteRegistry.sol";
import {DividendVault} from "./DividendVault.sol";
import {PlatformFeeBucket} from "./PlatformFeeBucket.sol";
import {IMigratorV2, IPairFactoryV2} from "./interfaces/IMigratorV2.sol";
import {PoolCheck} from "./PoolCheck.sol";
import {PostGradTaxHandler} from "./PostGradTaxHandler.sol";

/// @title LaunchpadV2 (dual-track · untaxed / taxed)
/// @notice One pad, `create(..., bool taxed, quote, refPool)`. Both tracks: BAW gate, walletCap 1%, bonding 1%→80/20.
///         The dev supplies the reference pool (Pancake V2 pair or V3 pool) that prices the quote; the graduation
///         target is ≈ TARGET_GRAD_BNB worth of quote at that pool's price (V3 TWAP, spot fallback). If the pool's
///         other side is not WBNB, an owner-registered bridge pool (e.g. USDT/WBNB) converts it.
///         Untaxed: LaunchToken, post-grad no tax.
///         Taxed: TaxLaunchToken OUTER_TAX 1% on pair trades → 50% DivVault (>10k holders) / 40% buyback / 10% vault.
/// @dev Lazy 2026-10-23 locked defaults. NO mainnet broadcast from this pack.
contract LaunchpadV2 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant CURVE_SUPPLY = 800_000_000 ether;
    /// @dev WBNB reference only (= TARGET_GRAD_BNB/3). Pricing uses Curve.virtualQuote.
    uint256 public constant VIRTUAL_QUOTE = 5 ether;
    uint256 public constant VIRTUAL_TOKEN = 1_066_666_666_666_666_666_666_666_667;
    uint256 public constant K = VIRTUAL_QUOTE * VIRTUAL_TOKEN;
    uint256 public constant MAX_PER_WALLET = 10_000_000 ether; // 1% of TOTAL_SUPPLY
    uint256 public constant BPS = 10_000;

    /// @dev Bonding fee both tracks: 1% → PlatformFeeBucket → 80% buyback / 20% feeVault. No bonding dividend.
    uint256 public constant PROTOCOL_FEE_BPS = 100;
    /// @dev Lazy: holders need balance **strictly >** 10_000 tokens (vault uses `<=` floor).
    uint256 public constant TAXED_MIN_SHARE = 10_000 ether;
    uint256 public constant TARGET_GRAD_BNB = 15 ether;
    /// @dev Reference pool must hold at least this much (in BNB terms) of the counter asset.
    uint256 public constant MIN_REF_DEPTH_BNB = 1 ether;
    uint256 public constant MIN_GRAD_AMT = 1e6;

    struct Curve {
        address creator;
        address quote;
        uint128 realQuote;
        uint128 sold;
        uint128 gradAmt;
        uint128 virtualQuote;
        bool graduated;
        bool taxed;
        address pair;
        address refPair;
    }

    QuoteRegistry public immutable quoteRegistry; // optional ops override only (not create whitelist)
    DividendVault public immutable dividendVault;
    PlatformFeeBucket public immutable platformBucket;
    PostGradTaxHandler public immutable taxHandler;
    address public immutable wbnb;
    address public pairFactory; // Pancake V2 factory
    address public v3Factory; // Pancake V3 factory (dev may pass V3 pools as reference)
    /// @notice V3 TWAP window in seconds for reference-pool pricing (0 = spot). Falls back to spot when the
    ///         pool's observation buffer cannot cover the window.
    uint32 public twapWindow = 1800;
    /// @notice counter asset (e.g. USDT) => canonical pool against WBNB used to express it in BNB.
    mapping(address => address) public bridgePoolOf;
    IMigratorV2 public migrator;

    IERC721 public agentIdRegistry;
    bool public agentGateEnabled = true;
    bool public walletCapEnabled = true;

    mapping(address token => Curve) public curves;
    mapping(address token => string) public logoURIOf;
    address[] public allTokens;

    event Created(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        string logoURI,
        bool taxed,
        address indexed quote,
        address refPair,
        uint256 gradAmt
    );
    event Buy(
        address indexed token,
        address indexed buyer,
        uint256 quoteIn,
        uint256 taxDividend,
        uint256 taxPlatform,
        uint256 tokensOut,
        uint256 realQuote
    );
    event Sell(
        address indexed token,
        address indexed seller,
        uint256 tokensIn,
        uint256 taxDividend,
        uint256 taxPlatform,
        uint256 quoteOut,
        uint256 realQuote
    );
    event VirtualQuoteLocked(address indexed token, uint256 virtualQuote);
    event Graduated(address indexed token, address indexed pair, address quote, uint256 tokenAmount, uint256 quoteAmount);
    event MigratorSet(address indexed migrator);
    event PairFactorySet(address indexed factory);
    event AgentGateUpdated(bool enabled, address registry);
    event WalletCapUpdated(bool enabled);
    event V3FactorySet(address indexed factory);
    event TwapWindowUpdated(uint32 window);
    event BridgePoolSet(address indexed asset, address indexed pool);

    error UnknownToken();
    error AlreadyGraduated();
    error ZeroAmount();
    error GradAmtTooSmall();
    error Slippage();
    error MigratorNotSet();
    error MigratorAlreadySet();
    error ZeroAddress();
    error NotAgent();
    error WalletCapReached();
    error RefPoolRequired();
    error NoBridgePool();
    error BridgeNotWbnb();

    constructor(
        address owner_,
        address quoteRegistry_,
        address dividendVault_,
        address platformBucket_,
        address taxHandler_,
        address wbnb_,
        address pairFactory_
    ) Ownable(owner_) {
        if (
            quoteRegistry_ == address(0) || dividendVault_ == address(0) || platformBucket_ == address(0)
                || taxHandler_ == address(0) || wbnb_ == address(0)
        ) revert ZeroAddress();
        quoteRegistry = QuoteRegistry(quoteRegistry_);
        dividendVault = DividendVault(dividendVault_);
        platformBucket = PlatformFeeBucket(platformBucket_);
        taxHandler = PostGradTaxHandler(taxHandler_);
        wbnb = wbnb_;
        pairFactory = pairFactory_;
    }

    function setMigrator(address migrator_) external onlyOwner {
        if (address(migrator) != address(0)) revert MigratorAlreadySet();
        if (migrator_ == address(0)) revert ZeroAddress();
        migrator = IMigratorV2(migrator_);
        emit MigratorSet(migrator_);
    }

    function setPairFactory(address factory_) external onlyOwner {
        pairFactory = factory_;
        emit PairFactorySet(factory_);
    }

    function setAgentGate(bool enabled, address registry) external onlyOwner {
        agentGateEnabled = enabled;
        agentIdRegistry = IERC721(registry);
        emit AgentGateUpdated(enabled, registry);
    }

    function setWalletCapEnabled(bool enabled) external onlyOwner {
        walletCapEnabled = enabled;
        emit WalletCapUpdated(enabled);
    }

    function setV3Factory(address factory_) external onlyOwner {
        v3Factory = factory_;
        emit V3FactorySet(factory_);
    }

    function setTwapWindow(uint32 window) external onlyOwner {
        twapWindow = window;
        emit TwapWindowUpdated(window);
    }

    /// @notice Register the canonical `asset`/WBNB pool used to express `asset` in BNB (V2 pair or V3 pool).
    ///         Pass pool = address(0) to remove.
    function setBridgePool(address asset, address pool) external onlyOwner {
        if (asset == address(0) || asset == wbnb) revert ZeroAddress();
        if (pool != address(0)) {
            PoolCheck.PoolInfo memory info = PoolCheck.inspect(_cfg(), pool);
            if (PoolCheck.counterOf(info, asset) != wbnb) revert BridgeNotWbnb();
        }
        bridgePoolOf[asset] = pool;
        emit BridgePoolSet(asset, pool);
    }

    function _cfg() internal view returns (PoolCheck.Cfg memory) {
        return PoolCheck.Cfg({wbnb: wbnb, v2Factory: pairFactory, v3Factory: v3Factory, twapWindow: twapWindow});
    }

    // ---------------------------------------------------------------- create
    /// @param quote   Quote ERC20 the curve is denominated in (address(0) = WBNB).
    /// @param refPool Pancake V2 pair or V3 pool containing `quote`, used to price the ≈15 BNB target.
    ///                Ignored when quote == WBNB or when QuoteRegistry has an ops override for `quote`.
    function create(
        string calldata name,
        string calldata symbol,
        string calldata logoURI,
        bool taxed,
        address quote,
        address refPool
    ) external returns (address token) {
        if (address(migrator) == address(0)) revert MigratorNotSet();
        _requireAgent();

        if (quote == address(0)) quote = wbnb;
        (uint256 lockedGrad, address refUsed) = _lockGradAmt(quote, refPool);

        if (taxed) {
            dividendVault.ensureMinimumShareBalance(TAXED_MIN_SHARE);
            token = address(new TaxLaunchToken(name, symbol));
            TaxLaunchToken(token).exclude(address(dividendVault), true);
            TaxLaunchToken(token).exclude(address(platformBucket), true);
            dividendVault.registerToken(token, quote);
        } else {
            token = address(new LaunchToken(name, symbol));
        }

        if (lockedGrad < MIN_GRAD_AMT) revert GradAmtTooSmall();
        address refPair = refUsed;
        _writeCurve(token, quote, lockedGrad, taxed, refPair);
        logoURIOf[token] = logoURI;
        allTokens.push(token);

        emit Created(token, msg.sender, name, symbol, logoURI, taxed, quote, refPair, lockedGrad);
    }

    // ---------------------------------------------------------------- buy
    struct BuyVars {
        uint256 taxDiv; // always 0 on V2 bonding (kept for event ABI parity)
        uint256 taxPlat;
        uint256 net;
        uint256 refundGross;
        uint256 gradAmt;
        uint256 tokensOut;
        uint256 feeBps;
    }

    function buy(address token, uint256 quoteIn, uint256 minTokensOut)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        Curve storage c = _live(token);
        if (quoteIn == 0) revert ZeroAmount();
        _requireAgent();

        BuyVars memory v = _prepBuy(c, token, quoteIn);
        tokensOut = v.tokensOut;
        if (tokensOut < minTokensOut) revert Slippage();

        tokensOut = _execBuy(c, token, quoteIn, minTokensOut, v);
    }

    function _prepBuy(Curve storage c, address token, uint256 quoteIn) internal view returns (BuyVars memory v) {
        uint256 room = walletRoom(token, msg.sender);
        if (walletCapEnabled && room == 0) revert WalletCapReached();

        // V2: both tracks bonding fee = PROTOCOL_FEE_BPS → platform only (no bonding dividend).
        v.feeBps = PROTOCOL_FEE_BPS;
        v.taxDiv = 0;
        v.taxPlat = (quoteIn * PROTOCOL_FEE_BPS) / BPS;
        v.net = quoteIn - v.taxPlat;
        v.gradAmt = c.gradAmt;
        uint256 remaining = v.gradAmt - c.realQuote;

        if (v.net > remaining) {
            v.net = remaining;
            _recomputeFee(quoteIn, v);
            if (v.net > remaining) v.net = remaining;
        }

        v.tokensOut = _tokensOut(c, v.net);
        if (walletCapEnabled && v.tokensOut > room) {
            v.tokensOut = room;
            v.net = _quoteInFor(c, room);
            _recomputeFee(quoteIn, v);
        }
    }

    function _recomputeFee(uint256 quoteIn, BuyVars memory v) internal pure {
        uint256 spentGross = Math.ceilDiv(v.net * BPS, BPS - PROTOCOL_FEE_BPS);
        if (spentGross > quoteIn) spentGross = quoteIn;
        v.taxDiv = 0;
        v.taxPlat = (spentGross * PROTOCOL_FEE_BPS) / BPS;
        v.net = spentGross - v.taxPlat;
        v.refundGross = quoteIn - spentGross;
    }

    function _execBuy(Curve storage c, address token, uint256 quoteIn, uint256 minTokensOut, BuyVars memory v)
        internal
        returns (uint256 tokensOut)
    {
        address quoteAddr = c.quote;
        v = _pullQuoteAndPrep(c, token, quoteAddr, quoteIn, minTokensOut, v);

        c.realQuote += v.net.toUint128();
        c.sold += v.tokensOut.toUint128();

        IERC20(token).safeTransfer(msg.sender, v.tokensOut);
        _syncShareAndTax(c, token, quoteAddr, v.taxPlat);

        emit Buy(token, msg.sender, v.net, v.taxDiv, v.taxPlat, v.tokensOut, c.realQuote);

        if (v.refundGross > 0) IERC20(quoteAddr).safeTransfer(msg.sender, v.refundGross);
        if (c.realQuote >= v.gradAmt) _graduate(token, c);
        tokensOut = v.tokensOut;
    }

    function _pullQuoteAndPrep(
        Curve storage c,
        address token,
        address quoteAddr,
        uint256 quoteIn,
        uint256 minTokensOut,
        BuyVars memory v
    ) internal returns (BuyVars memory) {
        IERC20 quote = IERC20(quoteAddr);
        uint256 beforeBal = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), quoteIn);
        uint256 received = quote.balanceOf(address(this)) - beforeBal;
        if (received == 0) revert ZeroAmount();
        if (received != quoteIn) {
            v = _prepBuy(c, token, received);
            if (v.tokensOut < minTokensOut) revert Slippage();
        }
        return v;
    }

    /// @dev Bonding: platform fee only. Taxed tokens still sync share balances (no bonding reward deposit).
    function _syncShareAndTax(Curve storage c, address token, address quoteAddr, uint256 taxPlat) internal {
        IERC20 quote = IERC20(quoteAddr);
        if (c.taxed) {
            dividendVault.setShare(token, msg.sender, IERC20(token).balanceOf(msg.sender));
        }
        if (taxPlat > 0) {
            quote.forceApprove(address(platformBucket), taxPlat);
            platformBucket.notifyAccrual(quoteAddr, taxPlat);
        }
    }

    // ---------------------------------------------------------------- sell
    function sell(address token, uint256 tokensIn, uint256 minQuoteOut)
        external
        nonReentrant
        returns (uint256 quoteToUser)
    {
        Curve storage c = _live(token);
        if (tokensIn == 0) revert ZeroAmount();
        _requireAgent();

        uint256 quoteOut = _quoteOut(c, tokensIn);
        uint256 taxDiv = 0;
        uint256 taxPlat = (quoteOut * PROTOCOL_FEE_BPS) / BPS;
        quoteToUser = quoteOut - taxPlat;
        if (quoteToUser < minQuoteOut) revert Slippage();

        c.realQuote -= quoteOut.toUint128();
        c.sold -= tokensIn.toUint128();

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);

        address quoteAddr = c.quote;
        _syncShareAndTax(c, token, quoteAddr, taxPlat);
        IERC20(quoteAddr).safeTransfer(msg.sender, quoteToUser);

        emit Sell(token, msg.sender, tokensIn, taxDiv, taxPlat, quoteToUser, c.realQuote);
    }

    // ---------------------------------------------------------------- views
    function isAgent(address account) public view returns (bool) {
        if (!agentGateEnabled) return true;
        if (address(agentIdRegistry) == address(0)) return false;
        return agentIdRegistry.balanceOf(account) > 0;
    }

    function _requireAgent() internal view {
        if (agentGateEnabled && !isAgent(msg.sender)) revert NotAgent();
    }

    function walletRoom(address token, address buyer) public view returns (uint256) {
        if (!walletCapEnabled) return type(uint256).max;
        uint256 bal = IERC20(token).balanceOf(buyer);
        return bal >= MAX_PER_WALLET ? 0 : MAX_PER_WALLET - bal;
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    function gradAmtOf(address token) external view returns (uint256) {
        return curves[token].gradAmt;
    }

    function virtualQuoteOf(address token) external view returns (uint256) {
        return curves[token].virtualQuote;
    }

    function graduationRemaining(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0) || c.graduated) return 0;
        if (c.realQuote >= c.gradAmt) return 0;
        return uint256(c.gradAmt) - uint256(c.realQuote);
    }

    /// @notice Preview the graduation amount for (quote, refPool). Reverts with the same errors as `create`.
    function graduationAmountOf(address quote, address refPool) external view returns (uint256) {
        if (quote == address(0)) quote = wbnb;
        (uint256 g,) = _lockGradAmt(quote, refPool);
        return g;
    }

    /// @notice WBNB / ops-override preview only (no pool needed). 0 when a reference pool is required.
    function graduationAmountOf(address quote) external view returns (uint256) {
        if (quote == address(0) || quote == wbnb) return TARGET_GRAD_BNB;
        return quoteRegistry.graduationAmount(quote);
    }

    // ---------------------------------------------------------------- internal
    /// @dev Graduation amount in quote units:
    ///      1. quote == WBNB → TARGET_GRAD_BNB.
    ///      2. QuoteRegistry ops override > 0 → that amount (refPool optional, validated if given).
    ///      3. Otherwise price via the dev-supplied reference pool. counter == WBNB → target = 15 BNB;
    ///         else target = 15 BNB expressed in counter via bridgePoolOf[counter]. The reference pool must hold
    ///         ≥ MIN_REF_DEPTH_BNB worth of the counter asset.
    function _lockGradAmt(address quote, address refPool) internal view returns (uint256 gradAmt, address refUsed) {
        if (quote == wbnb) return (TARGET_GRAD_BNB, address(0));

        PoolCheck.Cfg memory cfg = _cfg();
        uint256 ov = quoteRegistry.graduationAmount(quote);
        if (ov > 0) {
            if (refPool != address(0)) PoolCheck.counterOf(PoolCheck.inspect(cfg, refPool), quote);
            return (ov, refPool);
        }

        if (refPool == address(0)) revert RefPoolRequired();
        PoolCheck.PoolInfo memory info = PoolCheck.inspect(cfg, refPool);
        address counter = PoolCheck.counterOf(info, quote);

        uint256 targetCounter;
        if (counter == wbnb) {
            targetCounter = TARGET_GRAD_BNB;
        } else {
            address bridge = bridgePoolOf[counter];
            if (bridge == address(0)) revert NoBridgePool();
            PoolCheck.PoolInfo memory bInfo = PoolCheck.inspect(cfg, bridge);
            if (PoolCheck.counterOf(bInfo, counter) != wbnb) revert BridgeNotWbnb();
            targetCounter = PoolCheck.convert(cfg, bInfo, bridge, counter, TARGET_GRAD_BNB);
        }

        // depth floor: counter side of the reference pool ≥ MIN_REF_DEPTH_BNB worth
        uint256 minDepth = Math.mulDiv(targetCounter, MIN_REF_DEPTH_BNB, TARGET_GRAD_BNB);
        if (PoolCheck.depthOf(info, refPool, counter) < minDepth) revert PoolCheck.ThinReferencePool();

        gradAmt = PoolCheck.convert(cfg, info, refPool, quote, targetCounter);
        if (gradAmt == 0) revert PoolCheck.GradAmtZero();
        refUsed = refPool;
    }

    function _graduate(address token, Curve storage c) internal {
        c.graduated = true;
        uint256 tokenAmount = TOTAL_SUPPLY - c.sold;
        uint256 quoteAmount = c.realQuote;
        address quote = c.quote;
        c.realQuote = 0;

        if (c.taxed) {
            TaxLaunchToken(token).unlock();
            TaxLaunchToken(token).exclude(address(migrator), true);
            IERC20(token).safeTransfer(address(migrator), tokenAmount);
            IERC20(quote).safeTransfer(address(migrator), quoteAmount);
            address pair = migrator.migrate(token, quote, tokenAmount, quoteAmount);
            c.pair = pair;
            TaxLaunchToken(token).setPair(pair);
            TaxLaunchToken(token).exclude(address(taxHandler), true);
            TaxLaunchToken(token).setTaxHandler(address(taxHandler));
        } else {
            LaunchToken(token).unlock();
            IERC20(token).safeTransfer(address(migrator), tokenAmount);
            IERC20(quote).safeTransfer(address(migrator), quoteAmount);
            address pair = migrator.migrate(token, quote, tokenAmount, quoteAmount);
            c.pair = pair;
        }
        emit Graduated(token, c.pair, quote, tokenAmount, quoteAmount);
    }

    function _writeCurve(address token, address quote, uint256 lockedGrad, bool taxed, address refPair) internal {
        uint256 vq = lockedGrad / 3;
        if (vq == 0) revert ZeroAmount();
        curves[token] = Curve({
            creator: msg.sender,
            quote: quote,
            realQuote: 0,
            sold: 0,
            gradAmt: lockedGrad.toUint128(),
            virtualQuote: vq.toUint128(),
            graduated: false,
            taxed: taxed,
            pair: address(0),
            refPair: refPair
        });
        emit VirtualQuoteLocked(token, vq);
    }

    function _tokensOut(Curve storage c, uint256 quoteIn) internal view returns (uint256) {
        uint256 vq = c.virtualQuote;
        uint256 k = vq * VIRTUAL_TOKEN;
        uint256 qReserve = vq + c.realQuote;
        uint256 tReserve = VIRTUAL_TOKEN - c.sold;
        uint256 newT = Math.ceilDiv(k, qReserve + quoteIn);
        return tReserve - newT;
    }

    function _quoteInFor(Curve storage c, uint256 tokensOut) internal view returns (uint256) {
        uint256 vq = c.virtualQuote;
        uint256 k = vq * VIRTUAL_TOKEN;
        uint256 qReserve = vq + c.realQuote;
        uint256 tReserve = VIRTUAL_TOKEN - c.sold;
        return Math.ceilDiv(k, tReserve - tokensOut) - qReserve;
    }

    function _quoteOut(Curve storage c, uint256 tokensIn) internal view returns (uint256) {
        uint256 vq = c.virtualQuote;
        uint256 k = vq * VIRTUAL_TOKEN;
        uint256 qReserve = vq + c.realQuote;
        uint256 tReserve = VIRTUAL_TOKEN - c.sold;
        uint256 newQ = Math.ceilDiv(k, tReserve + tokensIn);
        return qReserve - newQ;
    }

    function _live(address token) internal view returns (Curve storage c) {
        c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();
    }
}
