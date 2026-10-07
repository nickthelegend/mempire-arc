// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPyth} from "../../src/interfaces/IPyth.sol";

/// @title MockPyth — TEST DOUBLE — forge tests only.
/// @notice Stands in for Pyth on anvil, with the same interface the game calls.
/// An update is `abi.encode(bytes32 feedId, int64 price, int32 expo)` or, with
/// a moving average, `abi.encode(bytes32 feedId, int64 price, int32 expo,
/// int64 emaPrice)`. Each update costs `feePerUpdate` wei, like the real
/// contract's per-update fee. The relay's Pyth proxy builds these in mock mode
/// when no Hermes key is configured; on Monad the real Pyth contract is used.
contract MockPyth is IPyth {
    uint256 public feePerUpdate = 1;
    mapping(bytes32 => Price) public prices;
    mapping(bytes32 => Price) public emaPrices;

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256) {
        return updateData.length * feePerUpdate;
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        require(msg.value >= updateData.length * feePerUpdate, "fee");
        for (uint256 i; i < updateData.length; ++i) {
            bytes calldata u = updateData[i];
            bytes32 id;
            int64 price;
            int32 expo;
            int64 ema;
            if (u.length >= 128) {
                (id, price, expo, ema) = abi.decode(u, (bytes32, int64, int32, int64));
            } else {
                (id, price, expo) = abi.decode(u, (bytes32, int64, int32));
                ema = price;
            }
            prices[id] = Price({price: price, conf: 0, expo: expo, publishTime: block.timestamp});
            emaPrices[id] = Price({price: ema, conf: 0, expo: expo, publishTime: block.timestamp});
        }
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory p) {
        p = _fresh(prices[id], age);
    }

    function getEmaPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory p) {
        p = _fresh(emaPrices[id], age);
    }

    function _fresh(Price memory p, uint256 age) internal view returns (Price memory) {
        require(p.publishTime != 0, "PriceFeedNotFound");
        require(block.timestamp - p.publishTime <= age, "StalePrice");
        return p;
    }
}
