// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {MarketMeta} from "../src/MarketMeta.sol";
import {IReceiver} from "../src/interfaces/IReceiver.sol";

contract MarketMetaTest is Base {
    function _report(uint64 epoch, int16 b0, int16 b1) internal pure returns (bytes memory) {
        uint16[] memory ids = new uint16[](2);
        ids[0] = 0;
        ids[1] = 5;
        int16[] memory bps = new int16[](2);
        bps[0] = b0;
        bps[1] = b1;
        return abi.encode(epoch, ids, bps);
    }

    function test_onReport_storesModifiers() public {
        vm.prank(forwarder);
        meta.onReport("", _report(1, 800, -1200));
        assertEq(meta.currentEpoch(), 1);
        assertEq(meta.modifierBps(1, 0), 800);
        assertEq(meta.modifierBps(1, 5), -1200);
        uint16[] memory q = new uint16[](3);
        q[0] = 5;
        q[1] = 0;
        q[2] = 9;
        int16[] memory out = meta.modifiersFor(1, q);
        assertEq(out[0], -1200);
        assertEq(out[1], 800);
        assertEq(out[2], 0);
    }

    function test_onlyForwarder() public {
        vm.expectRevert(MarketMeta.NotForwarder.selector);
        meta.onReport("", _report(1, 0, 0));
    }

    function test_rejectsStaleEpoch_andOutOfBounds() public {
        vm.startPrank(forwarder);
        meta.onReport("", _report(5, 0, 0));
        vm.expectRevert(MarketMeta.StaleEpoch.selector);
        meta.onReport("", _report(5, 0, 0));
        vm.expectRevert(MarketMeta.OutOfBounds.selector);
        meta.onReport("", _report(6, 1501, 0));
        vm.expectRevert(MarketMeta.OutOfBounds.selector);
        meta.onReport("", _report(6, 0, -1501));
        vm.stopPrank();
    }

    function test_workflowOwnerCheck() public {
        address owner = makeAddr("wfOwner");
        vm.prank(admin);
        meta.setExpectedWorkflowOwner(owner);
        bytes memory good = abi.encodePacked(bytes32("wf"), bytes10("mempire"), owner);
        bytes memory bad = abi.encodePacked(bytes32("wf"), bytes10("mempire"), makeAddr("other"));
        vm.startPrank(forwarder);
        vm.expectRevert(MarketMeta.WrongWorkflowOwner.selector);
        meta.onReport(bad, _report(1, 0, 0));
        meta.onReport(good, _report(1, 100, 100));
        vm.stopPrank();
        assertEq(meta.currentEpoch(), 1);
    }

    function test_supportsIReceiver() public view {
        assertTrue(meta.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(meta.supportsInterface(0x01ffc9a7));
        assertFalse(meta.supportsInterface(0xffffffff));
    }

    // ── Pyth momentum ───────────────────────────────────────────────────────

    function _upd(uint16 coinId, int64 spot, int64 ema) internal pure returns (bytes memory) {
        return abi.encode(feed(coinId), spot, int32(-8), ema);
    }

    function test_postFromPyth_derivesMomentum_inTheSameTx() public {
        vm.warp(1_000_000);
        uint16[] memory ids = new uint16[](3);
        ids[0] = 0;
        ids[1] = 1;
        ids[2] = 2;
        bytes[] memory u = new bytes[](3);
        u[0] = _upd(0, 105e8, 100e8); // +5% over EMA → +1000 bps
        u[1] = _upd(1, 90e8, 100e8); // −10% → clamped −1500
        u[2] = _upd(2, 100e8, 100e8); // flat → 0
        address poster = makeAddr("keeper");
        vm.deal(poster, 1 ether);
        vm.prank(poster);
        (uint64 epoch, int16[] memory bps) = meta.postFromPyth{value: 1 ether}(ids, u);
        assertEq(uint256(epoch), uint256(1666));
        assertEq(int256(bps[0]), int256(1000));
        assertEq(int256(bps[1]), int256(-1500));
        assertEq(int256(bps[2]), int256(0));
        assertEq(int256(meta.modifierBps(epoch, 0)), int256(1000));
        assertEq(meta.currentEpoch(), epoch);
        assertEq(uint256(meta.epochSource(epoch)), uint256(meta.SOURCE_PYTH()));
        // only the 3-wei update fee was kept
        assertEq(poster.balance, 1 ether - 3);
    }

    function test_postFromPyth_oneEpochPerWindow_andCREShareTheClock() public {
        vm.warp(1_200_000);
        uint16[] memory ids = new uint16[](1);
        bytes[] memory u = new bytes[](1);
        u[0] = _upd(0, 101e8, 100e8);
        meta.postFromPyth{value: 1}(ids, u);
        vm.expectRevert(MarketMeta.StaleEpoch.selector);
        meta.postFromPyth{value: 1}(ids, u);
        // CRE cannot write the same window either.
        vm.prank(forwarder);
        vm.expectRevert(MarketMeta.StaleEpoch.selector);
        meta.onReport("", _report(uint64(2000), 0, 0));
        vm.warp(1_200_000 + 600);
        meta.postFromPyth{value: 1}(ids, u);
    }

    function test_postFromPyth_refusesStaleOrMissingPrice_andUnderpayment() public {
        vm.warp(2_000_000);
        uint16[] memory ids = new uint16[](1);
        ids[0] = 4;
        bytes[] memory none = new bytes[](0);
        vm.expectRevert(bytes("PriceFeedNotFound"));
        meta.postFromPyth(ids, none);
        bytes[] memory u = new bytes[](1);
        u[0] = _upd(4, 1e8, 1e8);
        vm.expectRevert(MarketMeta.WrongPayment.selector);
        meta.postFromPyth{value: 0}(ids, u);
    }

    function test_momentumBps_bounds() public view {
        assertEq(int256(meta.momentumBps(100, 100)), int256(0));
        assertEq(int256(meta.momentumBps(1_100, 1_000)), int256(1500));
        assertEq(int256(meta.momentumBps(1_010, 1_000)), int256(200));
        assertEq(int256(meta.momentumBps(990, 1_000)), int256(-200));
    }

    function test_postFromPyth_feedsTheSimulationEpochAtJoin() public {
        vm.warp(3_000_000);
        uint16[] memory ids = new uint16[](1);
        bytes[] memory u = new bytes[](1);
        u[0] = _upd(0, 103e8, 100e8);
        (uint64 epoch,) = meta.postFromPyth{value: 1}(ids, u);
        (uint64 id,,) = startMonMatch(0);
        assertEq(uint256(arena.getMatch(id).metaEpoch), uint256(epoch));
    }
}
