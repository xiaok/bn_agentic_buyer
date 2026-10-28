// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev The slice of GangLaunchpad (the one pad for V3 curves and 打新 sales) this router calls. `curves` / `sales` keep
///      the old cores' 12- / 14-field layouts, so decoding is unchanged.
interface IGangPadEntry {
    function curves(address token)
        external
        view
        returns (
            address creator,
            address quote,
            uint128 realQuote,
            uint128 sold,
            uint128 gradAmt,
            uint128 virtualQuote,
            bool graduated,
            uint16 buyTaxBps,
            uint16 sellTaxBps,
            uint16 dividendBps,
            address pair,
            address refPair
        );
    function buyFor(address trader, address token, uint256 quoteIn, uint256 minTokensOut)
        external
        returns (uint256 tokensOut);
    function sales(address token)
        external
        view
        returns (
            address creator,
            uint64 progressAt,
            uint16 capShares,
            uint16 holdBps,
            address quote,
            uint16 sold,
            bool launched,
            uint16 mintFeeBps,
            uint16 exitFeeBps,
            address gate,
            uint128 sharePrice,
            address pair,
            address refPool,
            uint16 markSold
        );
    function previewMint(address token, address user, uint256 shares)
        external
        view
        returns (uint256 accepted, uint256 cost, uint256 fee);
    function mintFor(address trader, address token, uint256 shares, uint256 minShares)
        external
        returns (uint256 accepted);
}

/// @dev The slice of PancakeSwap V2's router the pool entries use (the fee-on-transfer variant: tax tokens).
interface IPancakeV2Router {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

interface IWBNB {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @title GangRouter — stateless entry for V3 curve buys and 打新 mints on GangLaunchpad (implementation behind a proxy)
/// @notice The pad (GangLaunchpad: V3 curves and 打新 sales in one contract) holds every reserve and enforces every
///         rule: price, fee, tax and its split, wallet cap, Agent gate (on the trader this router names), graduation / launch. This contract only
///         moves the caller's own money into one pad call: native BNB in (wrapped to WBNB) and back out, a deadline,
///         and whatever the pad refunds (cap / fill truncation) returned to the caller in what they paid with.
///         Pool entries (`pool*`): buy / sell any token on its PancakeSwap V2 pair (V2, V3 and 打新 tokens alike once
///         they trade there) through the Pancake V2 router, with native BNB in / out. The caller names the token's
///         quote (nothing here checks the pair: Pancake reverts without one; it is the caller's own money). Bought
///         tokens go straight from Pancake to the caller; a sell passes the tokens through this contract for the
///         length of the call (the tax handler syncs a seller's dividend share to what it holds after the sell before
///         it credits that sell's tax, so this contract never earns any). Pancake is approved exactly the amount of
///         each call and set back to 0. Outputs are measured as the caller's (or, for BNB out, this contract's)
///         balance change, so a fee-on-transfer token's tax is counted, and checked against the caller's minimum.
///         Deployed as the logic of a TransparentUpgradeableProxy (AUDIT-BRIEF §21): the pad lists the PROXY with
///         setRouter, users approve the PROXY, and that address never changes. The proxy's ProxyAdmin is owned by a
///         TimelockController (48 h on mainnet; proposer / executor / canceller = the platform Safe, no admin), so a
///         new version is public for 48 h before it can run. No owner and no funds here: the only state is the pad,
///         WBNB and Pancake router addresses (set once by `initialize`) and the reentrancy flag. A listed router can
///         only spend what it was sent, and the pad only lets it act for the wallet that sent the tx (`trader ==
///         tx.origin`, AUDIT-BRIEF §23): callers must be EOAs. This router has no curve sell / withdraw entry (the
///         pad's sellFor / withdrawFor are for listed aggregators; curve sells and withdraws stay direct on the pad). A
///         token of the other kind reads as an empty curve / sale here, so `v3*` on a 打新 token and `fair*` on a V3
///         token revert UnknownToken.
/// @dev Anything sent here outside a call (tokens, BNB) stays here: every call settles against its own balance delta,
///      so a call that starts from an empty router ends with an empty router.
///      STORAGE LAYOUT (proxy storage). Upgrade rule: a new variable takes its slot from `__gap` (declared right before
///      it) and the gap shrinks by the same number of slots, so everything after the gap stays where it is; never
///      reorder, retype or remove a variable, and never change the inheritance list:
///        slot 0      ReentrancyGuard._status  (0 on a fresh proxy = not entered; 1 / 2 afterwards)
///        slot 1      pad
///        slot 2      wbnb
///        slot 3      pancakeRouter
///        slots 4–50  __gap (47 slots)
///      Initializable keeps its flag in its ERC-7201 slot
///      0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00 (not in the sequential layout). A new
///      version that needs set-up uses `reinitializer(2)` (called through ProxyAdmin.upgradeAndCall's data).
contract GangRouter is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice GangLaunchpad (both kinds of token). Set once by `initialize`.
    IGangPadEntry public pad;
    /// @notice WBNB. Set once by `initialize`.
    address public wbnb;
    /// @notice PancakeSwap V2 router the pool entries swap through. Set once by `initialize`.
    IPancakeV2Router public pancakeRouter;
    /// @dev Reserved for appended state in later versions (see the layout above).
    uint256[47] private __gap;

    error Expired();
    error NotDeployed();
    error UnknownToken();
    error NotWbnbQuote();
    error NotEnoughValue();
    error OnlyWbnb();
    error BnbTransferFailed();
    /// @notice A pool entry got 0 in (msg.value / amount, or nothing arrived from the caller).
    error ZeroAmount();
    /// @notice A pool entry's output (as received) is below the caller's minimum.
    error TooLittleReceived(uint256 received, uint256 minimum);

    /// @dev The implementation itself can never be initialized: only a proxy's storage holds a pad.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Run once, by the proxy's constructor (TransparentUpgradeableProxy's `_data`), in the deploy transaction.
    /// @param pad_ GangLaunchpad (both kinds of token)
    /// @param pancakeRouter_ PancakeSwap V2 router (mainnet 0x10ED…024E, testnet 0xD99D…50D1)
    function initialize(address pad_, address wbnb_, address pancakeRouter_) external initializer {
        if (pad_ == address(0) || wbnb_ == address(0) || pancakeRouter_ == address(0)) revert NotDeployed();
        pad = IGangPadEntry(pad_);
        wbnb = wbnb_;
        pancakeRouter = IPancakeV2Router(pancakeRouter_);
    }

    /// @notice The pad, under the old V3 core getter name (CLI / indexer compatibility).
    function v3() external view returns (IGangPadEntry) {
        return pad;
    }

    /// @notice The pad, under the old 打新 core getter name (CLI / indexer compatibility).
    function fair() external view returns (IGangPadEntry) {
        return pad;
    }

    /// @dev Only WBNB unwrapping sends BNB here. WBNB pays with `transfer` (2300 gas): through the proxy this costs one
    ///      warm implementation-slot read, the delegatecall and one warm `wbnb` read (the call that unwraps read it).
    receive() external payable {
        if (msg.sender != wbnb) revert OnlyWbnb();
    }

    modifier before(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    // ---------------------------------------------------------------- V3 (curve)
    /// @notice Buy on the curve with `quoteIn` of the token's quote (approved to this router). The pad sends any refund
    ///         of a cap / graduation cut straight to the caller (§23); `_settle` then finds nothing left here.
    function v3Buy(address token, uint256 quoteIn, uint256 minTokensOut, uint256 deadline)
        external
        nonReentrant
        before(deadline)
        returns (uint256 tokensOut)
    {
        IERC20 quote = IERC20(_v3Quote(token));
        uint256 base = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), quoteIn);
        // a fee-on-transfer quote arrives short: pass on what arrived (the pad prices on what it receives)
        uint256 arrived = quote.balanceOf(address(this)) - base;
        quote.forceApprove(address(pad), arrived);
        tokensOut = pad.buyFor(msg.sender, token, arrived, minTokensOut);
        _settle(quote, base, false);
    }

    /// @notice Buy a WBNB-quoted token with native BNB (msg.value). The pad sends any refund of a cap / graduation cut
    ///         straight to the caller as WBNB (not BNB, §23); `_settle` then finds nothing left here.
    function v3BuyBNB(address token, uint256 minTokensOut, uint256 deadline)
        external
        payable
        nonReentrant
        before(deadline)
        returns (uint256 tokensOut)
    {
        IERC20 quote = IERC20(_v3Quote(token));
        if (address(quote) != wbnb) revert NotWbnbQuote();
        uint256 base = quote.balanceOf(address(this));
        IWBNB(wbnb).deposit{value: msg.value}();
        quote.forceApprove(address(pad), msg.value);
        tokensOut = pad.buyFor(msg.sender, token, msg.value, minTokensOut);
        _settle(quote, base, true);
    }

    // ---------------------------------------------------------------- 打新
    /// @notice Mint `shares` (cut to what is left / the cap, never below `minShares`) paying cost + mint fee in the
    ///         sale's quote (approved to this router). The position, tokens and fee escrow are the caller's.
    function fairMint(address token, uint256 shares, uint256 minShares, uint256 deadline)
        external
        nonReentrant
        before(deadline)
        returns (uint256 accepted)
    {
        (IERC20 quote, uint256 need) = _fairCost(token, shares);
        uint256 base = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), need);
        quote.forceApprove(address(pad), need);
        accepted = pad.mintFor(msg.sender, token, shares, minShares);
        _settle(quote, base, false);
    }

    /// @notice fairMint for a WBNB-quoted sale with native BNB: msg.value must cover cost + mint fee; the rest comes back.
    function fairMintBNB(address token, uint256 shares, uint256 minShares, uint256 deadline)
        external
        payable
        nonReentrant
        before(deadline)
        returns (uint256 accepted)
    {
        (IERC20 quote, uint256 need) = _fairCost(token, shares);
        if (address(quote) != wbnb) revert NotWbnbQuote();
        if (msg.value < need) revert NotEnoughValue();
        uint256 base = quote.balanceOf(address(this));
        IWBNB(wbnb).deposit{value: msg.value}();
        quote.forceApprove(address(pad), need);
        accepted = pad.mintFor(msg.sender, token, shares, minShares);
        _settle(quote, base, true);
    }

    // ---------------------------------------------------------------- PancakeSwap V2 pool
    /// @notice Buy `token` on its Pancake V2 pair with native BNB: wrapped, swapped along [WBNB, token] (quote = WBNB)
    ///         or [WBNB, quote, token], tokens sent by Pancake straight to the caller.
    /// @return tokensOut what the caller's token balance grew by (after any buy tax), at least `minTokensOut`
    function poolBuyBNB(address token, address quote, uint256 minTokensOut, uint256 deadline)
        external
        payable
        nonReentrant
        before(deadline)
        returns (uint256 tokensOut)
    {
        if (msg.value == 0) revert ZeroAmount();
        address w = wbnb;
        uint256 base = IERC20(w).balanceOf(address(this));
        IWBNB(w).deposit{value: msg.value}();
        tokensOut = _swapTo(_path(w, quote, token, quote == w), msg.value, msg.sender, deadline);
        if (tokensOut < minTokensOut) revert TooLittleReceived(tokensOut, minTokensOut);
        _settle(IERC20(w), base, true);
    }

    /// @notice Buy `token` on its Pancake V2 pair with `quoteIn` of `quote` (approved to this router) along
    ///         [quote, token]; tokens sent by Pancake straight to the caller.
    /// @return tokensOut what the caller's token balance grew by (after any buy tax), at least `minTokensOut`
    function poolBuy(address token, address quote, uint256 quoteIn, uint256 minTokensOut, uint256 deadline)
        external
        nonReentrant
        before(deadline)
        returns (uint256 tokensOut)
    {
        uint256 base = IERC20(quote).balanceOf(address(this));
        uint256 arrived = _pull(IERC20(quote), quoteIn, base);
        tokensOut = _swapTo(_path(quote, address(0), token, true), arrived, msg.sender, deadline);
        if (tokensOut < minTokensOut) revert TooLittleReceived(tokensOut, minTokensOut);
        _settle(IERC20(quote), base, false);
    }

    /// @notice Sell `amountIn` of `token` (approved to this router) on its Pancake V2 pair for `quote` along
    ///         [token, quote]; the quote is sent by Pancake straight to the caller.
    /// @return quoteOut what the caller's quote balance grew by, at least `minQuoteOut`
    function poolSell(address token, address quote, uint256 amountIn, uint256 minQuoteOut, uint256 deadline)
        external
        nonReentrant
        before(deadline)
        returns (uint256 quoteOut)
    {
        uint256 base = IERC20(token).balanceOf(address(this));
        uint256 arrived = _pull(IERC20(token), amountIn, base);
        quoteOut = _swapTo(_path(token, address(0), quote, true), arrived, msg.sender, deadline);
        if (quoteOut < minQuoteOut) revert TooLittleReceived(quoteOut, minQuoteOut);
        _settle(IERC20(token), base, false);
    }

    /// @notice Sell `amountIn` of `token` (approved to this router) on its Pancake V2 pair for native BNB along
    ///         [token, WBNB] (quote = WBNB) or [token, quote, WBNB]; the WBNB comes here, is unwrapped and sent on.
    /// @return bnbOut the BNB sent to the caller, at least `minBnbOut`
    function poolSellForBNB(address token, address quote, uint256 amountIn, uint256 minBnbOut, uint256 deadline)
        external
        nonReentrant
        before(deadline)
        returns (uint256 bnbOut)
    {
        address w = wbnb;
        uint256 baseToken = IERC20(token).balanceOf(address(this));
        uint256 baseW = IERC20(w).balanceOf(address(this));
        uint256 arrived = _pull(IERC20(token), amountIn, baseToken);
        bnbOut = _swapTo(_path(token, quote, w, quote == w), arrived, address(this), deadline);
        if (bnbOut < minBnbOut) revert TooLittleReceived(bnbOut, minBnbOut);
        _settle(IERC20(token), baseToken, false);
        _settle(IERC20(w), baseW, true); // exactly bnbOut: unwrapped and sent to the caller
    }

    // ---------------------------------------------------------------- internal
    /// @dev Pull `amount` of `t` from the caller; what arrived (a fee-on-transfer token arrives short), never 0.
    function _pull(IERC20 t, uint256 amount, uint256 base) internal returns (uint256 arrived) {
        if (amount == 0) revert ZeroAmount();
        t.safeTransferFrom(msg.sender, address(this), amount);
        arrived = t.balanceOf(address(this)) - base;
        if (arrived == 0) revert ZeroAmount();
    }

    /// @dev [a, b] when `direct`, else [a, mid, b].
    function _path(address a, address mid, address b, bool direct) internal pure returns (address[] memory p) {
        if (direct) {
            p = new address[](2);
            (p[0], p[1]) = (a, b);
        } else {
            p = new address[](3);
            (p[0], p[1], p[2]) = (a, mid, b);
        }
    }

    /// @dev Swap exactly `amountIn` of path[0] (held here) on Pancake V2, output to `to`; Pancake is approved exactly
    ///      `amountIn` and back to 0 afterwards. Returns what `to`'s balance of the last token grew by.
    function _swapTo(address[] memory path, uint256 amountIn, address to, uint256 deadline)
        internal
        returns (uint256 out)
    {
        IPancakeV2Router r = pancakeRouter;
        IERC20 tokenIn = IERC20(path[0]);
        IERC20 tokenOut = IERC20(path[path.length - 1]);
        uint256 prior = tokenOut.balanceOf(to);
        tokenIn.forceApprove(address(r), amountIn);
        // the minimum is checked on what the caller actually gets (after any tax), so Pancake's is 0
        r.swapExactTokensForTokensSupportingFeeOnTransferTokens(amountIn, 0, path, to, deadline);
        tokenIn.forceApprove(address(r), 0);
        out = tokenOut.balanceOf(to) - prior;
    }

    function _v3Quote(address token) internal view returns (address quote) {
        (, quote,,,,,,,,,,) = pad.curves(token);
        if (quote == address(0)) revert UnknownToken();
    }

    /// @dev What the pad will pull for `shares` minted by msg.sender right now (same block, same state as the mint).
    function _fairCost(address token, uint256 shares) internal view returns (IERC20 quote, uint256 need) {
        address q;
        (,,,, q,,,,,,,,,) = pad.sales(token);
        if (q == address(0)) revert UnknownToken();
        (, uint256 cost, uint256 fee) = pad.previewMint(token, msg.sender, shares);
        return (IERC20(q), cost + fee);
    }

    /// @dev Return to msg.sender whatever this call left above `base` (unspent msg.value of fairMintBNB, a pool
    ///      leftover), as BNB if asked. Curve buys leave nothing: the pad refunds the trader directly (§23).
    function _settle(IERC20 quote, uint256 base, bool asBnb) internal {
        uint256 left = quote.balanceOf(address(this)) - base;
        if (left == 0) return;
        if (!asBnb) {
            quote.safeTransfer(msg.sender, left);
            return;
        }
        IWBNB(wbnb).withdraw(left);
        (bool ok,) = msg.sender.call{value: left}("");
        if (!ok) revert BnbTransferFailed();
    }
}
