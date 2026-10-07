// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {LocalPriceOracle} from "../src/LocalPriceOracle.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";

contract LocalPriceOracleTest is Test {
    LocalPriceOracle internal oracle;
    uint256 internal signerKey;
    bytes32 internal constant FEED = keccak256("BTC/USD");

    function setUp() public {
        address signer;
        (signer, signerKey) = makeAddrAndKey("oracle");
        oracle = new LocalPriceOracle(signer);
        vm.warp(1_700_000_000);
    }

    function _update(uint256 key, int64 price, int64 ema, uint64 t) internal view returns (bytes memory) {
        bytes32 d = MessageHashUtils.toEthSignedMessageHash(oracle.digest(FEED, price, -8, ema, t));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, d);
        return abi.encode(FEED, price, int32(-8), ema, t, abi.encodePacked(r, s, v));
    }

    function _post(bytes memory u) internal {
        bytes[] memory us = new bytes[](1);
        us[0] = u;
        oracle.updatePriceFeeds{value: 1}(us);
    }

    function test_signedUpdate_isStored_andReadBack() public {
        _post(_update(signerKey, 65_000e8, 63_000e8, uint64(block.timestamp)));
        IPyth.Price memory p = oracle.getPriceNoOlderThan(FEED, 60);
        IPyth.Price memory e = oracle.getEmaPriceNoOlderThan(FEED, 60);
        assertEq(int256(p.price), int256(65_000e8));
        assertEq(int256(e.price), int256(63_000e8));
        assertEq(p.publishTime, block.timestamp);
    }

    function test_anUpdateNotSignedByTheOracle_isRefused() public {
        (, uint256 other) = makeAddrAndKey("someone");
        bytes memory forged = _update(other, 1, 1, uint64(block.timestamp));
        bytes[] memory us = new bytes[](1);
        us[0] = forged;
        vm.expectRevert(LocalPriceOracle.BadSignature.selector);
        oracle.updatePriceFeeds{value: 1}(us);
    }

    function test_aTamperedPrice_isRefused() public {
        bytes memory u = _update(signerKey, 100e8, 100e8, uint64(block.timestamp));
        (bytes32 id,, int32 expo, int64 ema, uint64 t, bytes memory sig) =
            abi.decode(u, (bytes32, int64, int32, int64, uint64, bytes));
        bytes[] memory us = new bytes[](1);
        us[0] = abi.encode(id, int64(999e8), expo, ema, t, sig);
        vm.expectRevert(LocalPriceOracle.BadSignature.selector);
        oracle.updatePriceFeeds{value: 1}(us);
    }

    function test_freshnessIsThePublishTime_notThePostTime() public {
        _post(_update(signerKey, 100e8, 100e8, uint64(block.timestamp - 200)));
        vm.expectRevert(LocalPriceOracle.StalePrice.selector);
        oracle.getPriceNoOlderThan(FEED, 120);
        oracle.getPriceNoOlderThan(FEED, 300);
    }

    function test_futureAndOlderUpdates() public {
        bytes[] memory us = new bytes[](1);
        us[0] = _update(signerKey, 1, 1, uint64(block.timestamp + 3600));
        vm.expectRevert(LocalPriceOracle.FromTheFuture.selector);
        oracle.updatePriceFeeds{value: 1}(us);

        _post(_update(signerKey, 200e8, 200e8, uint64(block.timestamp)));
        _post(_update(signerKey, 100e8, 100e8, uint64(block.timestamp - 10))); // older: ignored
        assertEq(int256(oracle.getPriceNoOlderThan(FEED, 60).price), int256(200e8));
    }

    function test_unknownFeed_andFee() public {
        vm.expectRevert(LocalPriceOracle.PriceFeedNotFound.selector);
        oracle.getPriceNoOlderThan(keccak256("nope"), 60);
        bytes[] memory us = new bytes[](1);
        us[0] = _update(signerKey, 1, 1, uint64(block.timestamp));
        vm.expectRevert(LocalPriceOracle.InsufficientFee.selector);
        oracle.updatePriceFeeds{value: 0}(us);
    }
}
