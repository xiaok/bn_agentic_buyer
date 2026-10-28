// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice What GangTaxHandler reads from its launchpad (the one core that registers every route). Only the 打新
///         (Fair) share rule needs it; the handler's own `routeOf.kind` decides which rule a token follows.
interface IGangPadView {
    /// @notice Tokens `user` held at launch (minted shares × tokens per share); 0 for everyone else.
    function baselineOf(address token, address user) external view returns (uint256);

    /// @notice A Fair token's hold line (bps of the baseline): below it, a minter is out for good.
    function holdBpsOf(address token) external view returns (uint16);

    /// @notice 0 = not this pad's, 1 = Curve (V3), 2 = Fair (打新).
    function kindOf(address token) external view returns (uint8);
}
