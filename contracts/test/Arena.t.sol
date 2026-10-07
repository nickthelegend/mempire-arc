// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {MempireArena} from "../src/MempireArena.sol";
import {MempireCards} from "../src/MempireCards.sol";

contract RefusesMon {
    receive() external payable {
        revert("no");
    }
}

contract ArenaTest is Base {
    uint128 internal constant KNIGHT = 0.05 ether;

    function test_create_escrowsStake_locksDeck_fundsSession() public {
        uint256[] memory deck = giveStarter(alice);
        uint256 sBefore = aliceSession.balance;
        vm.prank(alice);
        uint64 id = arena.createMatch{value: KNIGHT + 0.03 ether}(1, address(0), deck, aliceSession, noPermit());

        MempireArena.Match memory m = arena.getMatch(id);
        assertEq(m.p0, alice);
        assertEq(m.state, arena.STATE_OPEN());
        assertEq(m.stake, KNIGHT);
        assertEq(m.power0, 8);
        assertEq(m.deck0, keccak256(abi.encode(deck)));
        assertEq(address(arena).balance, KNIGHT);
        assertEq(aliceSession.balance - sBefore, 0.03 ether);
        assertTrue(cards.isLocked(deck[0]));

        vm.prank(alice);
        vm.expectRevert(MempireCards.CardLocked.selector);
        cards.transferFrom(alice, bob, deck[0]);
    }

    function test_create_rejectsWrongStake_tier_andSessionGasCap() public {
        uint256[] memory deck = giveStarter(alice);
        vm.startPrank(alice);
        vm.expectRevert(MempireArena.BadStake.selector);
        arena.createMatch{value: KNIGHT - 1}(1, address(0), deck, aliceSession, noPermit());
        vm.expectRevert(MempireArena.BadStake.selector);
        arena.createMatch{value: 1 ether}(4, address(0), deck, aliceSession, noPermit());
        vm.expectRevert(MempireArena.BadSessionGas.selector);
        arena.createMatch{value: KNIGHT + 1 ether}(1, address(0), deck, aliceSession, noPermit());
        vm.expectRevert(MempireArena.BadSessionGas.selector);
        arena.createMatch{value: KNIGHT + 1}(1, address(0), deck, address(0), noPermit());
        vm.stopPrank();
    }

    function test_create_rejectsForeignOrLockedOrDuplicateDeck() public {
        uint256[] memory aDeck = giveStarter(alice);
        uint256[] memory bDeck = giveStarter(bob);
        vm.prank(alice);
        vm.expectRevert(MempireCards.NotOwner.selector);
        arena.createMatch{value: KNIGHT}(1, address(0), bDeck, aliceSession, noPermit());

        vm.prank(alice);
        arena.createMatch{value: KNIGHT}(1, address(0), aDeck, aliceSession, noPermit());
        vm.prank(alice);
        vm.expectRevert(MempireCards.CardLocked.selector);
        arena.createMatch{value: KNIGHT}(1, address(0), aDeck, aliceSession, noPermit());

        vm.prank(alice);
        uint256 extra = cards.mint{value: MINT_FEE + 1}(0, update(0, 1)); // same coin as aDeck[0]
        uint256[] memory dup = new uint256[](8);
        dup[0] = extra;
        vm.startPrank(alice);
        for (uint16 i = 1; i < 8; ++i) {
            dup[i] = cards.mint{value: MINT_FEE + 1}(i, update(i, 1));
        }
        dup[7] = cards.mint{value: MINT_FEE + 1}(0, update(0, 1));
        vm.expectRevert(MempireCards.DuplicateCoin.selector);
        arena.createMatch{value: KNIGHT}(1, address(0), dup, aliceSession, noPermit());
        vm.stopPrank();
    }

    function test_join_activates_snapshotsMetaEpoch_rejectsSelf() public {
        vm.prank(forwarder);
        meta.onReport("", abi.encode(uint64(7), new uint16[](0), new int16[](0)));

        uint256[] memory aDeck = giveStarter(alice);
        uint256[] memory bDeck = giveStarter(bob);
        vm.prank(alice);
        uint64 id = arena.createMatch{value: KNIGHT}(1, address(0), aDeck, aliceSession, noPermit());

        vm.prank(alice);
        vm.expectRevert(MempireArena.SelfMatch.selector);
        arena.joinMatch{value: KNIGHT}(id, aDeck, aliceSession, noPermit());
        vm.prank(bob);
        vm.expectRevert(MempireArena.SelfMatch.selector);
        arena.joinMatch{value: KNIGHT}(id, bDeck, aliceSession, noPermit());

        vm.prank(bob);
        arena.joinMatch{value: KNIGHT}(id, bDeck, bobSession, noPermit());
        MempireArena.Match memory m = arena.getMatch(id);
        assertEq(m.state, arena.STATE_ACTIVE());
        assertEq(m.metaEpoch, 7);
        assertEq(m.deadline, block.timestamp + arena.matchTimeout());
        assertTrue(arena.seedOf(id) != 0);
    }

    function test_join_powerBand() public {
        uint256[] memory aDeck = giveStarter(alice);
        // Bob's deck: eight level-3 cards (power 24) vs Alice's 8.
        uint256[] memory bDeck = new uint256[](8);
        vm.startPrank(bob);
        token.approve(address(cards), type(uint256).max);
        for (uint16 i; i < 8; ++i) {
            uint256 keep = cards.mint{value: MINT_FEE + 1}(i, update(i, 1));
            cards.merge(keep, cards.mint{value: MINT_FEE + 1}(i, update(i, 1)));
            cards.merge(keep, cards.mint{value: MINT_FEE + 1}(i, update(i, 1)));
            bDeck[i] = keep;
        }
        vm.stopPrank();
        vm.prank(alice);
        uint64 id = arena.createMatch{value: KNIGHT}(1, address(0), aDeck, aliceSession, noPermit());
        vm.prank(bob);
        vm.expectRevert(MempireArena.PowerMismatch.selector);
        arena.joinMatch{value: KNIGHT}(id, bDeck, bobSession, noPermit());
    }

    function test_cancel_refundsAndUnlocks() public {
        uint256[] memory deck = giveStarter(alice);
        vm.prank(alice);
        uint64 id = arena.createMatch{value: KNIGHT}(1, address(0), deck, aliceSession, noPermit());
        vm.prank(bob);
        vm.expectRevert(MempireArena.NotASeat.selector);
        arena.cancelMatch(id);

        uint256 before = alice.balance;
        vm.prank(alice);
        arena.cancelMatch(id);
        assertEq(alice.balance - before, KNIGHT);
        assertFalse(cards.isLocked(deck[0]));
        vm.prank(alice);
        cards.transferFrom(alice, bob, deck[0]); // free again
    }

    function test_play_bySessionKey_isMonotonic_andSeatGated() public {
        (uint64 id,,) = startMonMatch(1);
        vm.prank(aliceSession);
        arena.play(id, 40, 3, 100, -200);
        vm.prank(bobSession);
        arena.play(id, 41, 0, -5, 5);
        vm.prank(alice); // the player's own key also speaks for the seat
        arena.play(id, 40, 1, 0, 0);

        vm.prank(aliceSession);
        vm.expectRevert(MempireArena.BadTick.selector);
        arena.play(id, 39, 1, 0, 0);
        vm.prank(aliceSession);
        vm.expectRevert(MempireArena.BadCardIndex.selector);
        arena.play(id, 50, 8, 0, 0);
        vm.prank(aliceSession);
        vm.expectRevert(MempireArena.BadTick.selector);
        arena.play(id, 5_001, 0, 0, 0);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(MempireArena.NotASeat.selector);
        arena.play(id, 60, 0, 0, 0);

        // A checkpoint never moves the play cursor.
        vm.prank(aliceSession);
        arena.checkpoint(id, 400, 0xdeadbeef);
        vm.prank(aliceSession);
        arena.play(id, 45, 2, 0, 0);

        MempireArena.Match memory m = arena.getMatch(id);
        assertEq(m.plays0, 3);
        assertEq(m.plays1, 1);
        assertEq(m.lastTick0, 45);
    }

    function test_agreedWin_pays90_rakes10_rewards_andGrantsChest() public {
        (uint64 id, uint256[] memory aDeck,) = startMonMatch(1);
        uint256 aBefore = alice.balance;
        uint256 tBefore = treasury.balance;
        uint256 tokBefore = token.balanceOf(alice);

        vm.prank(aliceSession);
        arena.claim(id, 0, keccak256("h"));
        assertTrue(cards.isLocked(aDeck[0])); // one claim settles nothing
        vm.prank(bobSession);
        arena.claim(id, 0, keccak256("h"));

        MempireArena.Match memory m = arena.getMatch(id);
        assertEq(m.state, arena.STATE_SETTLED());
        assertEq(m.winner, 0);
        uint256 pot = uint256(KNIGHT) * 2;
        assertEq(alice.balance - aBefore, pot * 90 / 100);
        assertEq(treasury.balance - tBefore, pot / 10);
        assertEq(address(arena).balance, 0);
        assertEq(token.balanceOf(alice) - tokBefore, 50 ether);
        assertEq(arena.rewardedWins(alice), 1);
        assertEq(cards.activeChests(alice), 1);
        assertEq(cards.activeChests(bob), 0);
        assertFalse(cards.isLocked(aDeck[0]));
    }

    function test_tie_splitsAfter5PercentRake() public {
        (uint64 id,,) = startMonMatch(2);
        uint128 stake = arena.stakeFor(address(0), 2);
        uint256 aBefore = alice.balance;
        uint256 bBefore = bob.balance;
        uint256 tBefore = treasury.balance;
        vm.prank(aliceSession);
        arena.claim(id, 2, bytes32(0));
        vm.prank(bobSession);
        arena.claim(id, 2, bytes32(0));
        uint256 pot = uint256(stake) * 2;
        uint256 half = (pot - pot * 5 / 100) / 2;
        assertEq(alice.balance - aBefore, half);
        assertEq(bob.balance - bBefore, half);
        assertEq(treasury.balance - tBefore, pot - half * 2);
        assertEq(cards.activeChests(alice) + cards.activeChests(bob), 0);
    }

    function test_disagreement_voids_andRefundsBoth() public {
        (uint64 id,,) = startMonMatch(1);
        uint256 aBefore = alice.balance;
        uint256 bBefore = bob.balance;
        vm.prank(aliceSession);
        arena.claim(id, 0, bytes32(0));
        vm.prank(bobSession);
        arena.claim(id, 1, bytes32(0));
        assertEq(alice.balance - aBefore, KNIGHT);
        assertEq(bob.balance - bBefore, KNIGHT);
        assertEq(arena.getMatch(id).winner, arena.NONE());
        assertEq(arena.rewardedWins(alice) + arena.rewardedWins(bob), 0);
    }

    function test_doubleClaim_reverts() public {
        (uint64 id,,) = startMonMatch(1);
        vm.prank(aliceSession);
        arena.claim(id, 0, bytes32(0));
        vm.prank(alice);
        vm.expectRevert(MempireArena.AlreadyClaimed.selector);
        arena.claim(id, 1, bytes32(0));
    }

    function test_timeout_singleClaimStands_noRewardNoChest() public {
        (uint64 id,,) = startMonMatch(1);
        vm.prank(bobSession);
        arena.claim(id, 1, bytes32(0));

        vm.expectRevert(MempireArena.TooEarly.selector);
        arena.claimTimeout(id);

        vm.warp(block.timestamp + arena.matchTimeout());
        uint256 bBefore = bob.balance;
        vm.prank(makeAddr("anyone"));
        arena.claimTimeout(id);
        assertEq(bob.balance - bBefore, uint256(KNIGHT) * 2 * 90 / 100);
        assertEq(arena.rewardedWins(bob), 0);
        assertEq(cards.activeChests(bob), 0);
    }

    function test_timeout_honestLoserClaimStands() public {
        (uint64 id,,) = startMonMatch(1);
        // Bob lost and said so; Alice never claimed. Alice is paid.
        vm.prank(bobSession);
        arena.claim(id, 0, bytes32(0));
        vm.warp(block.timestamp + arena.matchTimeout());
        uint256 aBefore = alice.balance;
        arena.claimTimeout(id);
        assertEq(alice.balance - aBefore, uint256(KNIGHT) * 2 * 90 / 100);
    }

    function test_timeout_noClaims_refundsBoth() public {
        (uint64 id, uint256[] memory aDeck,) = startMonMatch(1);
        vm.warp(block.timestamp + arena.matchTimeout());
        uint256 aBefore = alice.balance;
        uint256 bBefore = bob.balance;
        arena.claimTimeout(id);
        assertEq(alice.balance - aBefore, KNIGHT);
        assertEq(bob.balance - bBefore, KNIGHT);
        assertFalse(cards.isLocked(aDeck[0]));
    }

    function test_lateClaimOrPlay_reverts() public {
        (uint64 id,,) = startMonMatch(1);
        vm.warp(block.timestamp + arena.matchTimeout() + 1);
        vm.prank(aliceSession);
        vm.expectRevert(MempireArena.TooLate.selector);
        arena.claim(id, 0, bytes32(0));
        vm.prank(aliceSession);
        vm.expectRevert(MempireArena.TooLate.selector);
        arena.play(id, 1, 0, 0, 0);
    }

    function test_rewardCap_sixteenWins() public {
        address[2] memory p = [alice, bob];
        uint256[] memory aDeck = giveStarter(alice);
        uint256[] memory bDeck = giveStarter(bob);
        for (uint256 i; i < 17; ++i) {
            vm.prank(p[0]);
            uint64 id = arena.createMatch{value: 0.01 ether}(0, address(0), aDeck, address(0), noPermit());
            vm.prank(p[1]);
            arena.joinMatch{value: 0.01 ether}(id, bDeck, address(0), noPermit());
            vm.prank(alice);
            arena.claim(id, 0, bytes32(i));
            vm.prank(bob);
            arena.claim(id, 0, bytes32(i));
        }
        assertEq(arena.rewardedWins(alice), 16);
    }

    function test_emptyRewardPool_stillPaysPot() public {
        MempireArena bare = new MempireArena(admin, cards, address(ausd), meta, treasury);
        vm.prank(admin);
        cards.setArena(address(bare));
        uint256[] memory aDeck = giveStarter(alice);
        uint256[] memory bDeck = giveStarter(bob);
        vm.prank(alice);
        uint64 id = bare.createMatch{value: 0.01 ether}(0, address(0), aDeck, address(0), noPermit());
        vm.prank(bob);
        bare.joinMatch{value: 0.01 ether}(id, bDeck, address(0), noPermit());
        uint256 before = alice.balance;
        vm.prank(alice);
        bare.claim(id, 0, bytes32(0));
        vm.prank(bob);
        bare.claim(id, 0, bytes32(0));
        assertEq(alice.balance - before, 0.018 ether);
        assertEq(bare.rewardedWins(alice), 0);
    }

    function test_refusedPayout_isHeldThenWithdrawn() public {
        RefusesMon wall = new RefusesMon();
        uint256[] memory aDeck = giveStarter(address(wall));
        uint256[] memory bDeck = giveStarter(bob);
        vm.deal(address(wall), 1 ether);
        vm.prank(address(wall));
        uint64 id = arena.createMatch{value: 0.01 ether}(0, address(0), aDeck, address(0), noPermit());
        vm.prank(bob);
        arena.joinMatch{value: 0.01 ether}(id, bDeck, address(0), noPermit());
        vm.prank(address(wall));
        arena.claim(id, 0, bytes32(0));
        vm.prank(bob);
        arena.claim(id, 0, bytes32(0)); // must not revert though the winner refuses MON
        assertEq(arena.owed(address(0), address(wall)), 0.018 ether);
        assertEq(arena.getMatch(id).state, arena.STATE_SETTLED());
    }

    // ── AUSD ────────────────────────────────────────────────────────────────

    function _permit(uint256 key, address owner, uint256 value) internal view returns (MempireArena.Permit memory p) {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                address(arena),
                value,
                ausd.nonces(owner),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ausd.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        p = MempireArena.Permit({deadline: deadline, v: v, r: r, s: s});
    }

    function test_ausdMatch_withPermit_paysInDollars() public {
        uint256[] memory aDeck = giveStarter(alice);
        uint256[] memory bDeck = giveStarter(bob);
        uint128 stake = arena.stakeFor(address(ausd), 1); // 5 AUSD

        MempireArena.Permit memory pa = _permit(aliceKey, alice, stake);
        vm.prank(alice);
        uint64 id = arena.createMatch{value: 0.02 ether}(1, address(ausd), aDeck, aliceSession, pa);
        assertEq(ausd.balanceOf(address(arena)), stake);
        assertEq(aliceSession.balance, 0.02 ether);

        MempireArena.Permit memory pb = _permit(bobKey, bob, stake);
        vm.prank(bob);
        arena.joinMatch(id, bDeck, bobSession, pb);

        uint256 bBefore = ausd.balanceOf(bob);
        vm.prank(aliceSession);
        arena.claim(id, 1, bytes32(0));
        vm.prank(bobSession);
        arena.claim(id, 1, bytes32(0));
        assertEq(ausd.balanceOf(bob) - bBefore, 9e6);
        assertEq(ausd.balanceOf(treasury), 1e6);
        assertEq(ausd.balanceOf(address(arena)), 0);
    }

    function test_ausdMatch_frontRunPermitStillWorks() public {
        uint256[] memory aDeck = giveStarter(alice);
        uint128 stake = arena.stakeFor(address(ausd), 0);
        MempireArena.Permit memory pa = _permit(aliceKey, alice, stake);
        // Someone submits Alice's permit first; her create must still succeed.
        ausd.permit(alice, address(arena), stake, pa.deadline, pa.v, pa.r, pa.s);
        vm.prank(alice);
        arena.createMatch(0, address(ausd), aDeck, address(0), pa);
        assertEq(ausd.balanceOf(address(arena)), stake);
    }

    function test_unknownCurrency_rejected() public {
        uint256[] memory aDeck = giveStarter(alice);
        vm.prank(alice);
        vm.expectRevert(MempireArena.BadStake.selector);
        arena.createMatch(0, address(token), aDeck, address(0), noPermit());
    }

    function test_mergeBlockedWhileLocked_freedAfterSettle() public {
        (uint64 id, uint256[] memory aDeck,) = startMonMatch(1);
        vm.startPrank(alice);
        uint256 dupe = cards.mint{value: MINT_FEE + 1}(0, update(0, 1));
        token.approve(address(cards), type(uint256).max);
        vm.expectRevert(MempireCards.CardLocked.selector);
        cards.merge(aDeck[0], dupe);
        vm.stopPrank();
        vm.prank(alice);
        arena.claim(id, 0, bytes32(0));
        vm.prank(bob);
        arena.claim(id, 0, bytes32(0));
        vm.prank(alice);
        cards.merge(aDeck[0], dupe);
        assertEq(cards.card(aDeck[0]).level, 2);
    }

    function testFuzz_settlementConservesValue(uint8 tier, uint8 a, uint8 b) public {
        tier = uint8(bound(tier, 0, 3));
        a = uint8(bound(a, 0, 2));
        b = uint8(bound(b, 0, 2));
        (uint64 id,,) = startMonMatch(tier);
        uint256 total = alice.balance + bob.balance + treasury.balance + address(arena).balance;
        vm.prank(aliceSession);
        arena.claim(id, a, bytes32(0));
        vm.prank(bobSession);
        arena.claim(id, b, bytes32(0));
        assertEq(address(arena).balance, 0);
        assertEq(alice.balance + bob.balance + treasury.balance, total);
    }
}
