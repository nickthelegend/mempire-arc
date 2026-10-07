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

    // ── Chainlink Data Feeds momentum ───────────────────────────────────────

    /// Give coin `id` a feed history: round 2 at T−30h (the day-ago round),
    /// round 3 at T−20h, round 4 (latest) at T−1h.
    function _history(uint16 id, int256 dayAgo, int256 latest) internal returns (uint80 hint) {
        uint256 t = block.timestamp;
        feeds[id].updateRoundData(2, dayAgo, t - 30 hours, t - 30 hours);
        feeds[id].updateRoundData(3, (dayAgo + latest) / 2, t - 20 hours, t - 20 hours);
        feeds[id].updateRoundData(4, latest, t - 1 hours, t - 1 hours);
        return 2;
    }

    function _one(uint16 id, uint80 hint) internal pure returns (uint16[] memory ids, uint80[] memory hints) {
        ids = new uint16[](1);
        ids[0] = id;
        hints = new uint80[](1);
        hints[0] = hint;
    }

    function test_postFromFeeds_computesTheDailyMove_onChain() public {
        uint16[] memory ids = new uint16[](3);
        uint80[] memory hints = new uint80[](3);
        ids[0] = 0;
        ids[1] = 1;
        ids[2] = 2;
        hints[0] = _history(0, 100e8, 110e8); // +10% day → +400 bps (×0.4)
        hints[1] = _history(1, 100e8, 50e8); // −50% → clamped −1500
        hints[2] = _history(2, 100e8, 100e8); // flat → 0
        address poster = makeAddr("anyone");
        vm.prank(poster);
        (uint64 epoch, int16[] memory bps) = meta.postFromFeeds(ids, hints);
        assertEq(uint256(epoch), block.timestamp / 600);
        assertEq(int256(bps[0]), int256(400));
        assertEq(int256(bps[1]), int256(-1500));
        assertEq(int256(bps[2]), int256(0));
        assertEq(int256(meta.modifierBps(epoch, 0)), int256(400));
        assertEq(uint256(meta.epochSource(epoch)), uint256(meta.SOURCE_FEEDS()));
    }

    /// The poster points at the day-ago round; it cannot shop for a better one.
    function test_postFromFeeds_rejectsAWrongRoundHint() public {
        _history(0, 100e8, 110e8);
        (uint16[] memory ids, uint80[] memory hints) = _one(0, 3); // T−20h: too recent
        vm.expectRevert(abi.encodeWithSelector(MarketMeta.BadRoundHint.selector, uint16(0)));
        meta.postFromFeeds(ids, hints);
        // An older round than the right one: its successor is also before the cutoff.
        feeds[0].updateRoundData(1, 90e8, block.timestamp - 40 hours, block.timestamp - 40 hours);
        feeds[0].updateRoundData(4, 110e8, block.timestamp - 1 hours, block.timestamp - 1 hours); // latest again
        (ids, hints) = _one(0, 1);
        vm.expectRevert(abi.encodeWithSelector(MarketMeta.BadRoundHint.selector, uint16(0)));
        meta.postFromFeeds(ids, hints);
        // A round that does not exist.
        (ids, hints) = _one(0, 9);
        vm.expectRevert(abi.encodeWithSelector(MarketMeta.BadRoundHint.selector, uint16(0)));
        meta.postFromFeeds(ids, hints);
        // The right one.
        (ids, hints) = _one(0, 2);
        meta.postFromFeeds(ids, hints);
    }

    function test_postFromFeeds_refusesStaleOrNonPositiveFeeds() public {
        _history(4, 100e8, 101e8);
        (uint16[] memory ids, uint80[] memory hints) = _one(4, 2);
        vm.warp(block.timestamp + 26 hours); // latest round now 27h old
        vm.expectRevert(MarketMeta.StalePrice.selector);
        meta.postFromFeeds(ids, hints);
        feeds[4].updateRoundData(5, 0, block.timestamp, block.timestamp);
        vm.expectRevert(MarketMeta.BadPrice.selector);
        meta.postFromFeeds(ids, hints);
    }

    function test_postFromFeeds_oneEpochPerWindow_andCREShareTheClock() public {
        _history(0, 100e8, 101e8);
        (uint16[] memory ids, uint80[] memory hints) = _one(0, 2);
        meta.postFromFeeds(ids, hints);
        vm.expectRevert(MarketMeta.StaleEpoch.selector);
        meta.postFromFeeds(ids, hints);
        // CRE cannot write the same window either.
        vm.prank(forwarder);
        vm.expectRevert(MarketMeta.StaleEpoch.selector);
        meta.onReport("", _report(uint64(block.timestamp / 600), 0, 0));
        vm.warp(block.timestamp + 600);
        meta.postFromFeeds(ids, hints);
    }

    function test_momentumBps_bounds() public view {
        assertEq(int256(meta.momentumBps(100, 100)), int256(0));
        assertEq(int256(meta.momentumBps(1_200, 1_000)), int256(800)); // +20% day → +8%
        assertEq(int256(meta.momentumBps(2_000, 1_000)), int256(1500)); // clamped
        assertEq(int256(meta.momentumBps(900, 1_000)), int256(-400));
    }

    function test_postFromFeeds_feedsTheSimulationEpochAtJoin() public {
        _history(0, 100e8, 103e8);
        (uint16[] memory ids, uint80[] memory hints) = _one(0, 2);
        (uint64 epoch,) = meta.postFromFeeds(ids, hints);
        (uint64 id,,) = startMatch(0);
        assertEq(uint256(arena.getMatch(id).metaEpoch), uint256(epoch));
    }

    /// Arc mainnet has no CRE: deployed with forwarder 0, onReport accepts nothing.
    function test_noForwarder_acceptsNoReports() public {
        MarketMeta bare = new MarketMeta(admin, address(0));
        vm.prank(address(0));
        vm.expectRevert(MarketMeta.NotForwarder.selector);
        bare.onReport("", abi.encode(uint64(1), new uint16[](0), new int16[](0)));
    }
}
