// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The slice of Pyth's EVM interface Mempire uses.
/// Pyth is a pull oracle: the price on chain is only as fresh as the last
/// update somebody posted, so callers post a Hermes update in the same
/// transaction and then read it back with a tight age bound.
interface IPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount);

    function updatePriceFeeds(bytes[] calldata updateData) external payable;

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory price);

    /// Pyth's exponentially-weighted moving average of the same feed, with the
    /// same expo as the spot price. The gap between the two is momentum.
    function getEmaPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory price);
}
