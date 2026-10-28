// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SharedDividendVault} from "../common/SharedDividendVault.sol";
import {IGangLaunchpad} from "./interfaces/IGangLaunchpad.sol";
import {IGangPadHandler, IGangPadToken, IGangTokenDeployer} from "./interfaces/IGangPadDeps.sol";
import {PadCommon} from "./PadCommon.sol";

/// @title CurveLogic — GangLaunchpad's bonding-curve (V3, tax recipient) path
/// @notice External library: GangLaunchpad delegatecalls it, so it runs on the pad's storage, balance and msg.sender,
///         and its events come from the pad. LaunchpadV3's create / buy / sell / graduation, as on
///         feat/v3-no-curve-tax: no tax on the curve, every trade pays only the 1% protocol fee (→ bucket, blocking);
///         `Buy` / `Sell` keep their `tax` field, always 0 (spec §19). Dividend shares still follow the trader's balance
///         (blocking write) so the pool tax after graduation finds them.
/// @dev Reentrancy guard, the caller check of `buyFor` / `sellFor` (listed router, trader == tx.origin, §23) and the
///      A-2 gate check of `buyFor` stay in the pad's wrappers. The gate here is the pad's current setting (V3),
///      unlike 打新's per-sale snapshot.
///      Not callable directly: every state-changing entry needs the delegatecall context (a direct call reads and
///      writes the library's own empty storage and reverts on the first lookup).
library CurveLogic {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 internal constant CURVE_SUPPLY = 800_000_000 ether;
    uint256 internal constant VIRTUAL_TOKEN = 1_066_666_666_666_666_666_666_666_667;
    uint256 internal constant MAX_PER_WALLET = 10_000_000 ether; // 1% of TOTAL_SUPPLY
    uint256 internal constant PROTOCOL_FEE_BPS = 100;
    uint16 internal constant MIN_TAX_BPS = 100;
    uint16 internal constant MAX_TAX_BPS = 500;
    uint256 internal constant MIN_GRAD_AMT = 1e6;
    uint8 internal constant KIND = 1;

    struct BuyVars {
        uint256 protocolFee;
        uint256 net;
        uint256 refundGross;
        uint256 gradAmt;
        uint256 tokensOut;
    }

    // ---------------------------------------------------------------- create
    function create(
        IGangLaunchpad.Config storage c,
        mapping(address => IGangLaunchpad.Curve) storage curves,
        mapping(address => address) storage bridgePoolOf,
        IGangLaunchpad.Deps memory d,
        string calldata name,
        string calldata symbol,
        string calldata logoURI,
        string calldata metaURI,
        address quote,
        address refPool,
        IGangLaunchpad.TaxConfig calldata tax
    ) external returns (address token) {
        if (c.migrator == address(0)) revert IGangLaunchpad.MigratorNotSet();
        _requireAgent(c, msg.sender);
        string memory reason = checkTax(d, msg.sender, tax);
        if (bytes(reason).length != 0) revert IGangLaunchpad.BadTaxConfig(reason);

        if (quote == address(0)) quote = d.wbnb;
        PadCommon.requireQuote(d, quote);
        (uint256 lockedGrad, address refUsed) = PadCommon.toQuote(c, bridgePoolOf, d, quote, refPool, PadCommon.REF_BNB);
        if (lockedGrad < MIN_GRAD_AMT) revert IGangLaunchpad.GradAmtTooSmall();

        if (tax.buyTaxBps == 0) {
            token = IGangTokenDeployer(d.tokenDeployer).deploy(name, symbol, metaURI, address(0), 0, 0, false);
        } else {
            token = _createTaxed(d, name, symbol, metaURI, quote, tax);
        }

        _writeCurve(curves[token], token, quote, lockedGrad, tax, refUsed);

        emit IGangLaunchpad.Created(token, msg.sender, name, symbol, logoURI, quote, refUsed, lockedGrad);
        emit IGangLaunchpad.TaxConfigured(token, tax.buyTaxBps, tax.sellTaxBps, tax.dividendBps, tax.recipient);
    }

    function _createTaxed(
        IGangLaunchpad.Deps memory d,
        string calldata name,
        string calldata symbol,
        string calldata uri,
        address quote,
        IGangLaunchpad.TaxConfig calldata tax
    ) private returns (address token) {
        token = IGangTokenDeployer(d.tokenDeployer)
            .deploy(name, symbol, uri, d.taxHandler, tax.buyTaxBps, tax.sellTaxBps, false);
        if (tax.dividendBps > 0) {
            SharedDividendVault vault = SharedDividendVault(d.dividendVault);
            // internal audit 5 C-F4: a floor the vault owner raised above TAXED_MIN_SHARE would leave the new token with
            // no shareholders and send the holders' part of its tax elsewhere. Checked only for a dividend token, after
            // the token is deployed (打新 checks it on every create, before anything else).
            if (vault.minimumShareBalanceOf(address(this)) > PadCommon.MIN_SHARE) {
                revert IGangLaunchpad.VaultFloorTooHigh();
            }
            vault.ensureMinimumShareBalance(PadCommon.MIN_SHARE);
            vault.registerToken(token, quote);
        }
        IGangPadHandler(d.taxHandler).register(token, quote, tax.recipient, tax.dividendBps, KIND);
    }

    /// @dev Empty string = valid. The recipient is the creator itself (no listing needed) or a whitelisted address
    ///      (2026-10-27, AUDIT-BRIEF §22). `creator` = 0 means "unknown": only the whitelist counts (the pad's old
    ///      `checkTaxConfig(tax)`); a zero recipient never matches it, the branch above handles that case.
    function checkTax(IGangLaunchpad.Deps memory d, address creator, IGangLaunchpad.TaxConfig calldata tax)
        public
        view
        returns (string memory)
    {
        if (tax.buyTaxBps == 0 && tax.sellTaxBps == 0) {
            if (tax.dividendBps != 0 || tax.recipient != address(0)) {
                return "untaxed: dividendBps / recipient must be empty";
            }
            return "";
        }
        if (
            tax.buyTaxBps < MIN_TAX_BPS || tax.buyTaxBps > MAX_TAX_BPS || tax.sellTaxBps < MIN_TAX_BPS
                || tax.sellTaxBps > MAX_TAX_BPS
        ) return "buyTaxBps and sellTaxBps must each be 100-500 (1%-5%)";
        if (tax.dividendBps > PadCommon.BPS) return "dividendBps > 10000";
        if (tax.recipient == address(0)) {
            if (tax.dividendBps != PadCommon.BPS) return "no recipient: dividendBps must be 10000";
            return "";
        }
        if (tax.recipient != creator && !IGangPadHandler(d.taxHandler).isListed(tax.recipient)) {
            return "recipient not listed";
        }
        return "";
    }

    function _writeCurve(
        IGangLaunchpad.Curve storage cv,
        address token,
        address quote,
        uint256 lockedGrad,
        IGangLaunchpad.TaxConfig calldata tax,
        address refPair
    ) private {
        uint256 vq = lockedGrad / 3;
        if (vq == 0) revert IGangLaunchpad.ZeroAmount();
        cv.creator = msg.sender;
        cv.quote = quote;
        cv.gradAmt = lockedGrad.toUint128();
        cv.virtualQuote = vq.toUint128();
        cv.buyTaxBps = tax.buyTaxBps;
        cv.sellTaxBps = tax.sellTaxBps;
        cv.dividendBps = tax.dividendBps;
        cv.refPair = refPair;
        emit IGangLaunchpad.VirtualQuoteLocked(token, vq);
    }

    // ---------------------------------------------------------------- buy
    /// @dev msg.sender pays (the trader itself, or a router the pad checked); `trader` receives the tokens and any
    ///      refund of the cut (in the quote ERC-20, §23).
    function buy(
        IGangLaunchpad.Config storage c,
        mapping(address => IGangLaunchpad.Curve) storage curves,
        IGangLaunchpad.Deps memory d,
        address trader,
        address token,
        uint256 quoteIn,
        uint256 minTokensOut
    ) external returns (uint256 tokensOut) {
        IGangLaunchpad.Curve storage cv = _live(curves, token);
        if (quoteIn == 0) revert IGangLaunchpad.ZeroAmount();
        _requireAgent(c, trader);

        BuyVars memory v = _prepBuy(c, cv, token, trader, quoteIn);
        if (v.tokensOut < minTokensOut) revert IGangLaunchpad.Slippage();

        tokensOut = _execBuy(c, cv, d, token, trader, quoteIn, v);
    }

    function _prepBuy(
        IGangLaunchpad.Config storage c,
        IGangLaunchpad.Curve storage cv,
        address token,
        address trader,
        uint256 quoteIn
    ) private view returns (BuyVars memory v) {
        bool capped = c.walletCapEnabled;
        uint256 room = walletRoom(capped, token, trader);
        if (capped && room == 0) revert IGangLaunchpad.WalletCapReached();

        _applyFee(quoteIn, v);
        v.gradAmt = cv.gradAmt;
        uint256 remaining = v.gradAmt - cv.realQuote;

        if (v.net > remaining) {
            v.net = remaining;
            _recomputeFee(quoteIn, v);
            if (v.net > remaining) v.net = remaining;
        }

        v.tokensOut = _tokensOut(cv, v.net);
        if (capped && v.tokensOut > room) {
            v.tokensOut = room;
            v.net = _quoteInFor(cv, room);
            _recomputeFee(quoteIn, v);
        }
    }

    /// @dev The curve's only charge: 1% of the gross (no tax on the curve, 2026-10-27).
    function _applyFee(uint256 gross, BuyVars memory v) private pure {
        v.protocolFee = (gross * PROTOCOL_FEE_BPS) / PadCommon.BPS;
        v.net = gross - v.protocolFee;
    }

    function _recomputeFee(uint256 quoteIn, BuyVars memory v) private pure {
        uint256 spentGross = Math.ceilDiv(v.net * PadCommon.BPS, PadCommon.BPS - PROTOCOL_FEE_BPS);
        if (spentGross > quoteIn) spentGross = quoteIn;
        _applyFee(spentGross, v);
        v.refundGross = quoteIn - spentGross;
    }

    function _execBuy(
        IGangLaunchpad.Config storage c,
        IGangLaunchpad.Curve storage cv,
        IGangLaunchpad.Deps memory d,
        address token,
        address trader,
        uint256 quoteIn,
        BuyVars memory v
    ) private returns (uint256 tokensOut) {
        address quoteAddr = cv.quote;
        PadCommon.pullExact(quoteAddr, quoteIn);

        cv.realQuote += v.net.toUint128();
        cv.sold += v.tokensOut.toUint128();

        IERC20(token).safeTransfer(trader, v.tokensOut);
        _syncShareAndFee(cv, d, token, trader, quoteAddr, v.protocolFee);

        // `tax` stays in the event (ABI unchanged for indexers): always 0, the curve charges none
        emit IGangLaunchpad.Buy(token, trader, v.net, v.protocolFee, 0, v.tokensOut, cv.realQuote);

        // §23: the cut (cap / graduation) goes back to the trader, not the caller — aggregators assume exact-in and
        // may not forward or sweep a leftover. Direct `buy`: trader = msg.sender, as before.
        if (v.refundGross > 0) IERC20(quoteAddr).safeTransfer(trader, v.refundGross);
        if (cv.realQuote >= v.gradAmt) _graduate(c, token, cv);
        tokensOut = v.tokensOut;
    }

    /// @dev No tax on the curve: the trade pays only `protocolFee` (→ PlatformFeeBucket, blocking). A dividend token's
    ///      share still follows the trader's balance (blocking write, as V2's taxed track), so the pool tax after
    ///      graduation is credited to the right holders; nothing is paid to holders or to the recipient here.
    function _syncShareAndFee(
        IGangLaunchpad.Curve storage cv,
        IGangLaunchpad.Deps memory d,
        address token,
        address account,
        address quoteAddr,
        uint256 protocolFee
    ) private {
        if (cv.dividendBps > 0) {
            SharedDividendVault(d.dividendVault).setShare(token, account, IERC20(token).balanceOf(account));
        }
        PadCommon.toPlatform(d, quoteAddr, protocolFee);
    }

    // ---------------------------------------------------------------- sell
    /// @dev `trader` sells; the quote goes to msg.sender. Direct `sell`: trader = msg.sender, `viaCaller` false, the
    ///      tokens move with the trader's allowance to the pad (as before). `sellFor`: the pad checked the caller (a
    ///      listed router) and trader == tx.origin, `viaCaller` true, the tokens move with the trader's allowance to
    ///      the caller (`GangToken.pullFor`, locked tokens only — curve sells only exist before graduation).
    function sell(
        IGangLaunchpad.Config storage c,
        mapping(address => IGangLaunchpad.Curve) storage curves,
        IGangLaunchpad.Deps memory d,
        address trader,
        bool viaCaller,
        address token,
        uint256 tokensIn,
        uint256 minQuoteOut
    ) external returns (uint256 quoteToUser) {
        IGangLaunchpad.Curve storage cv = _live(curves, token);
        if (tokensIn == 0) revert IGangLaunchpad.ZeroAmount();
        _requireAgent(c, trader);

        uint256 quoteOut = _quoteOut(cv, tokensIn);
        uint256 protocolFee = (quoteOut * PROTOCOL_FEE_BPS) / PadCommon.BPS;
        quoteToUser = quoteOut - protocolFee;
        if (quoteToUser < minQuoteOut) revert IGangLaunchpad.Slippage();

        cv.realQuote -= quoteOut.toUint128();
        cv.sold -= tokensIn.toUint128();

        if (viaCaller) IGangPadToken(token).pullFor(trader, msg.sender, tokensIn);
        else IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);

        address quoteAddr = cv.quote;
        _syncShareAndFee(cv, d, token, trader, quoteAddr, protocolFee);
        IERC20(quoteAddr).safeTransfer(msg.sender, quoteToUser);

        // `tax` stays in the event (ABI unchanged for indexers): always 0, the curve charges none
        emit IGangLaunchpad.Sell(token, trader, tokensIn, protocolFee, 0, quoteToUser, cv.realQuote);
    }

    // ---------------------------------------------------------------- views
    /// @notice What `create` would lock as the graduation amount for `quote` (0 = WBNB) and `refPool`.
    function graduationAmountOf(
        IGangLaunchpad.Config storage c,
        mapping(address => address) storage bridgePoolOf,
        IGangLaunchpad.Deps memory d,
        address quote,
        address refPool
    ) external view returns (uint256 g) {
        if (quote == address(0)) quote = d.wbnb;
        (g,) = PadCommon.toQuote(c, bridgePoolOf, d, quote, refPool, PadCommon.REF_BNB);
    }

    /// @dev Room left under the 1% wallet cap (max when the cap is off). Internal: also inlined into the pad's view.
    function walletRoom(bool capped, address token, address buyer) internal view returns (uint256) {
        if (!capped) return type(uint256).max;
        uint256 bal = IERC20(token).balanceOf(buyer);
        return bal >= MAX_PER_WALLET ? 0 : MAX_PER_WALLET - bal;
    }

    // ---------------------------------------------------------------- internal
    function _requireAgent(IGangLaunchpad.Config storage c, address account) private view {
        if (c.agentGateEnabled && !PadCommon.isAgent(c, account)) revert IGangLaunchpad.NotAgent();
    }

    function _graduate(IGangLaunchpad.Config storage c, address token, IGangLaunchpad.Curve storage cv) private {
        cv.graduated = true;
        uint256 tokenAmount = PadCommon.TOTAL_SUPPLY - cv.sold;
        uint256 quoteAmount = cv.realQuote;
        address quote = cv.quote;
        cv.realQuote = 0;

        // taxed: unlock, migrate, then setPair (tax and share syncing start); untaxed: never setPair (Untaxed)
        cv.pair = PadCommon.migrate(c, token, quote, tokenAmount, quoteAmount, cv.buyTaxBps > 0);
        emit IGangLaunchpad.Graduated(token, cv.pair, quote, tokenAmount, quoteAmount);
    }

    function _tokensOut(IGangLaunchpad.Curve storage cv, uint256 quoteIn) private view returns (uint256) {
        uint256 vq = cv.virtualQuote;
        uint256 k = vq * VIRTUAL_TOKEN;
        uint256 qReserve = vq + cv.realQuote;
        uint256 tReserve = VIRTUAL_TOKEN - cv.sold;
        uint256 newT = Math.ceilDiv(k, qReserve + quoteIn);
        return tReserve - newT;
    }

    function _quoteInFor(IGangLaunchpad.Curve storage cv, uint256 tokensOut) private view returns (uint256) {
        uint256 vq = cv.virtualQuote;
        uint256 k = vq * VIRTUAL_TOKEN;
        uint256 qReserve = vq + cv.realQuote;
        uint256 tReserve = VIRTUAL_TOKEN - cv.sold;
        return Math.ceilDiv(k, tReserve - tokensOut) - qReserve;
    }

    function _quoteOut(IGangLaunchpad.Curve storage cv, uint256 tokensIn) private view returns (uint256) {
        uint256 vq = cv.virtualQuote;
        uint256 k = vq * VIRTUAL_TOKEN;
        uint256 qReserve = vq + cv.realQuote;
        uint256 tReserve = VIRTUAL_TOKEN - cv.sold;
        uint256 newQ = Math.ceilDiv(k, tReserve + tokensIn);
        return qReserve - newQ;
    }

    function _live(mapping(address => IGangLaunchpad.Curve) storage curves, address token)
        private
        view
        returns (IGangLaunchpad.Curve storage cv)
    {
        cv = curves[token];
        if (cv.creator == address(0)) revert IGangLaunchpad.UnknownToken();
        if (cv.graduated) revert IGangLaunchpad.AlreadyGraduated();
    }
}
