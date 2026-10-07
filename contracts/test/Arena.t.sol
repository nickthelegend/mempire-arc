// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {MempireArena} from "../src/MempireArena.sol";
import {MempireCards} from "../src/MempireCards.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CircleUSDC} from "./utils/CircleUSDC.sol";

contract ArenaTest is Base {
    uint128 internal constant KNIGHT = 5e6; // 5 USDC

    function test_create_escrowsStake_locksDeck_fundsSession() public {
        uint256[] memory deck = giveStarter(alice);
        uint256 sBefore = aliceSession.balance;
        uint256 uBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        uint64 id = arena.createMatch{value: 0.03 ether}(1, deck, aliceSession, 0, noPermit());

        MempireArena.Match memory m = arena.getMatch(id);
        assertEq(m.p0, alice);
        assertEq(m.state, arena.STATE_OPEN());
        assertEq(m.stake, KNIGHT);
        assertEq(m.power0, 8);
        assertEq(m.deck0, keccak256(abi.encode(deck)));
        assertEq(m.currency, address(usdc));
        assertEq(usdc.balanceOf(address(arena)), KNIGHT);
        assertEq(uBefore - usdc.balanceOf(alice), KNIGHT);
        assertEq(address(arena).balance, 0); // session gas is forwarded, never held
        assertEq(aliceSession.balance - sBefore, 0.03 ether);
        assertTrue(cards.isLocked(deck[0]));

        vm.prank(alice);
        vm.expectRevert(MempireCards.CardLocked.selector);
        cards.transferFrom(alice, bob, deck[0]);
    }

    /// The float can be paid in ERC-20 USDC with the stake (one permit, no msg.value) —
    /// on Arc that transfer *is* the session key's gas. Mixed with native value, the cap covers both.
    function test_sessionFloat_inErc20Usdc_noValueNeeded() public {
        uint256[] memory deck = giveStarter(alice);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        arena.createMatch(1, deck, aliceSession, 0.1e6, noPermit());
        assertEq(before - usdc.balanceOf(alice), KNIGHT + 0.1e6);
        assertEq(usdc.balanceOf(aliceSession), 0.1e6);
        assertEq(usdc.balanceOf(address(arena)), KNIGHT, "only the stake stays escrowed");

        uint256[] memory bDeck = giveStarter(bob);
        vm.prank(bob);
        vm.expectRevert(MempireArena.BadSessionGas.selector);
        arena.createMatch{value: 0.2 ether}(1, bDeck, bobSession, 0.05e6 + 1, noPermit());
        vm.prank(bob);
        vm.expectRevert(MempireArena.BadSessionGas.selector);
        arena.createMatch(1, bDeck, address(0), 1, noPermit());
    }

    function test_create_rejectsWrongStake_tier_andSessionGasCap() public {
        uint256[] memory deck = giveStarter(alice);
        vm.startPrank(alice);
        vm.expectRevert(MempireArena.BadStake.selector);
        arena.createMatch(4, deck, aliceSession, 0, noPermit());
        vm.expectRevert(MempireArena.BadSessionGas.selector);
        arena.createMatch{value: 0.25 ether + 1}(1, deck, aliceSession, 0, noPermit());
        vm.expectRevert(MempireArena.BadSessionGas.selector);
        arena.createMatch{value: 1}(1, deck, address(0), 0, noPermit());
        vm.stopPrank();

        // No allowance and no permit: the USDC pull fails and nothing is locked.
        address carol = makeAddr("carol");
        CircleUSDC.mint(carol, 100e6);
        uint256[] memory cDeck = giveStarter(carol);
        vm.prank(carol);
        vm.expectRevert();
        arena.createMatch(0, cDeck, address(0), 0, noPermit());
        assertFalse(cards.isLocked(cDeck[0]));
    }

    function test_create_rejectsForeignOrLockedOrDuplicateDeck() public {
        uint256[] memory aDeck = giveStarter(alice);
        uint256[] memory bDeck = giveStarter(bob);
        vm.prank(alice);
        vm.expectRevert(MempireCards.NotOwner.selector);
        arena.createMatch(1, bDeck, aliceSession, 0, noPermit());

        vm.prank(alice);
        arena.createMatch(1, aDeck, aliceSession, 0, noPermit());
        vm.prank(alice);
        vm.expectRevert(MempireCards.CardLocked.selector);
        arena.createMatch(1, aDeck, aliceSession, 0, noPermit());

        uint256[] memory dup = new uint256[](8);
        dup[0] = mintAs(alice, 0); // same coin as aDeck[0]
        for (uint16 i = 1; i < 8; ++i) {
            dup[i] = mintAs(alice, i);
        }
        dup[7] = mintAs(alice, 0);
        vm.prank(alice);
        vm.expectRevert(MempireCards.DuplicateCoin.selector);
        arena.createMatch(1, dup, aliceSession, 0, noPermit());
    }

    function test_join_activates_snapshotsMetaEpoch_rejectsSelf() public {
        vm.prank(forwarder);
        meta.onReport("", abi.encode(uint64(7), new uint16[](0), new int16[](0)));

        uint256[] memory aDeck = giveStarter(alice);
        uint256[] memory bDeck = giveStarter(bob);
        vm.prank(alice);
        uint64 id = arena.createMatch(1, aDeck, aliceSession, 0, noPermit());

        vm.prank(alice);
        vm.expectRevert(MempireArena.SelfMatch.selector);
        arena.joinMatch(id, aDeck, aliceSession, 0, noPermit());
        vm.prank(bob);
        vm.expectRevert(MempireArena.SelfMatch.selector);
        arena.joinMatch(id, bDeck, aliceSession, 0, noPermit());

        vm.prank(bob);
        arena.joinMatch(id, bDeck, bobSession, 0, noPermit());
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
        vm.prank(bob);
        token.approve(address(cards), type(uint256).max);
        for (uint16 i; i < 8; ++i) {
            uint256 keep = mintAs(bob, i);
            uint256 d1 = mintAs(bob, i);
            uint256 d2 = mintAs(bob, i);
            vm.startPrank(bob);
            cards.merge(keep, d1);
            cards.merge(keep, d2);
            vm.stopPrank();
            bDeck[i] = keep;
        }
        vm.prank(alice);
        uint64 id = arena.createMatch(1, aDeck, aliceSession, 0, noPermit());
        vm.prank(bob);
        vm.expectRevert(MempireArena.PowerMismatch.selector);
        arena.joinMatch(id, bDeck, bobSession, 0, noPermit());
    }

    function test_cancel_refundsAndUnlocks() public {
        uint256[] memory deck = giveStarter(alice);
        vm.prank(alice);
        uint64 id = arena.createMatch(1, deck, aliceSession, 0, noPermit());
        vm.prank(bob);
        vm.expectRevert(MempireArena.NotASeat.selector);
        arena.cancelMatch(id);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        arena.cancelMatch(id);
        assertEq(usdc.balanceOf(alice) - before, KNIGHT);
        assertFalse(cards.isLocked(deck[0]));
        vm.prank(alice);
        cards.transferFrom(alice, bob, deck[0]); // free again
    }

    function test_play_bySessionKey_isMonotonic_andSeatGated() public {
        (uint64 id,,) = startMatch(1);
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
        (uint64 id, uint256[] memory aDeck,) = startMatch(1);
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 tBefore = usdc.balanceOf(treasury);
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
        assertEq(usdc.balanceOf(alice) - aBefore, pot * 90 / 100);
        assertEq(usdc.balanceOf(treasury) - tBefore, pot / 10);
        assertEq(usdc.balanceOf(address(arena)), 0);
        assertEq(token.balanceOf(alice) - tokBefore, 50 ether);
        assertEq(arena.rewardedWins(alice), 1);
        assertEq(cards.activeChests(alice), 1);
        assertEq(cards.activeChests(bob), 0);
        assertFalse(cards.isLocked(aDeck[0]));
    }

    function test_tie_splitsAfter5PercentRake() public {
        (uint64 id,,) = startMatch(2);
        uint128 stake = arena.stakeFor(2);
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);
        uint256 tBefore = usdc.balanceOf(treasury);
        vm.prank(aliceSession);
        arena.claim(id, 2, bytes32(0));
        vm.prank(bobSession);
        arena.claim(id, 2, bytes32(0));
        uint256 pot = uint256(stake) * 2;
        uint256 half = (pot - pot * 5 / 100) / 2;
        assertEq(usdc.balanceOf(alice) - aBefore, half);
        assertEq(usdc.balanceOf(bob) - bBefore, half);
        assertEq(usdc.balanceOf(treasury) - tBefore, pot - half * 2);
        assertEq(cards.activeChests(alice) + cards.activeChests(bob), 0);
    }

    function test_disagreement_voids_andRefundsBoth() public {
        (uint64 id,,) = startMatch(1);
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);
        vm.prank(aliceSession);
        arena.claim(id, 0, bytes32(0));
        vm.prank(bobSession);
        arena.claim(id, 1, bytes32(0));
        assertEq(usdc.balanceOf(alice) - aBefore, KNIGHT);
        assertEq(usdc.balanceOf(bob) - bBefore, KNIGHT);
        assertEq(arena.getMatch(id).winner, arena.NONE());
        assertEq(arena.rewardedWins(alice) + arena.rewardedWins(bob), 0);
    }

    function test_doubleClaim_reverts() public {
        (uint64 id,,) = startMatch(1);
        vm.prank(aliceSession);
        arena.claim(id, 0, bytes32(0));
        vm.prank(alice);
        vm.expectRevert(MempireArena.AlreadyClaimed.selector);
        arena.claim(id, 1, bytes32(0));
    }

    function test_timeout_singleClaimStands_noRewardNoChest() public {
        (uint64 id,,) = startMatch(1);
        vm.prank(bobSession);
        arena.claim(id, 1, bytes32(0));

        vm.expectRevert(MempireArena.TooEarly.selector);
        arena.claimTimeout(id);

        vm.warp(block.timestamp + arena.matchTimeout());
        uint256 bBefore = usdc.balanceOf(bob);
        vm.prank(makeAddr("anyone"));
        arena.claimTimeout(id);
        assertEq(usdc.balanceOf(bob) - bBefore, uint256(KNIGHT) * 2 * 90 / 100);
        assertEq(arena.rewardedWins(bob), 0);
        assertEq(cards.activeChests(bob), 0);
    }

    function test_timeout_honestLoserClaimStands() public {
        (uint64 id,,) = startMatch(1);
        // Bob lost and said so; Alice never claimed. Alice is paid.
        vm.prank(bobSession);
        arena.claim(id, 0, bytes32(0));
        vm.warp(block.timestamp + arena.matchTimeout());
        uint256 aBefore = usdc.balanceOf(alice);
        arena.claimTimeout(id);
        assertEq(usdc.balanceOf(alice) - aBefore, uint256(KNIGHT) * 2 * 90 / 100);
    }

    function test_timeout_noClaims_refundsBoth() public {
        (uint64 id, uint256[] memory aDeck,) = startMatch(1);
        vm.warp(block.timestamp + arena.matchTimeout());
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);
        arena.claimTimeout(id);
        assertEq(usdc.balanceOf(alice) - aBefore, KNIGHT);
        assertEq(usdc.balanceOf(bob) - bBefore, KNIGHT);
        assertFalse(cards.isLocked(aDeck[0]));
    }

    function test_lateClaimOrPlay_reverts() public {
        (uint64 id,,) = startMatch(1);
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
            uint64 id = arena.createMatch(0, aDeck, address(0), 0, noPermit());
            vm.prank(p[1]);
            arena.joinMatch(id, bDeck, address(0), 0, noPermit());
            vm.prank(alice);
            arena.claim(id, 0, bytes32(i));
            vm.prank(bob);
            arena.claim(id, 0, bytes32(i));
        }
        assertEq(arena.rewardedWins(alice), 16);
    }

    function test_emptyRewardPool_stillPaysPot() public {
        MempireArena bare = new MempireArena(admin, cards, address(usdc), meta, treasury, 3);
        vm.prank(admin);
        cards.setArena(address(bare));
        uint256[] memory aDeck = giveStarter(alice);
        uint256[] memory bDeck = giveStarter(bob);
        vm.prank(alice);
        usdc.approve(address(bare), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(bare), type(uint256).max);
        vm.prank(alice);
        uint64 id = bare.createMatch(0, aDeck, address(0), 0, noPermit());
        vm.prank(bob);
        bare.joinMatch(id, bDeck, address(0), 0, noPermit());
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        bare.claim(id, 0, bytes32(0));
        vm.prank(bob);
        bare.claim(id, 0, bytes32(0));
        assertEq(usdc.balanceOf(alice) - before, 1.8e6);
        assertEq(bare.rewardedWins(alice), 0);
    }

    /// Arc enforces Circle's blocklist on USDC. A winner who is blocklisted
    /// when the pot pays can't receive it — and must not be able to brick the
    /// settlement either: their leg is held, the treasury's rake still lands,
    /// and they pull it if and when they are unblocked.
    function test_blocklistedWinner_isHeldThenWithdrawn() public {
        (uint64 id,,) = startMatch(0);
        vm.prank(aliceSession);
        arena.claim(id, 0, bytes32(0));
        CircleUSDC.blacklist(alice);
        uint256 tBefore = usdc.balanceOf(treasury);
        vm.prank(bobSession);
        arena.claim(id, 0, bytes32(0)); // must not revert though the winner can't receive USDC
        assertEq(arena.getMatch(id).state, arena.STATE_SETTLED());
        assertEq(arena.owed(alice), 1.8e6);
        assertEq(usdc.balanceOf(treasury) - tBefore, 0.2e6);
        assertEq(usdc.balanceOf(address(arena)), 1.8e6);

        vm.prank(alice);
        vm.expectRevert();
        arena.withdraw(); // still blocklisted: the token refuses
        CircleUSDC.unBlacklist(alice);
        uint256 aBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        arena.withdraw();
        assertEq(usdc.balanceOf(alice) - aBefore, 1.8e6);
        assertEq(arena.owed(alice), 0);
        vm.prank(alice);
        vm.expectRevert(MempireArena.NothingOwed.selector);
        arena.withdraw();
    }

    // ── permits (Arc's USDC: EIP-712 domain "USDC" / "2") ─────────────────────

    function _permit(uint256 key, address owner, uint256 value) internal view returns (MempireArena.Permit memory p) {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                address(arena),
                value,
                usdc.nonces(owner),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        p = MempireArena.Permit({deadline: deadline, v: v, r: r, s: s});
    }

    function test_usdcDomain_isArcs() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USDC"),
                keccak256("2"),
                block.chainid,
                address(usdc)
            )
        );
        assertEq(usdc.DOMAIN_SEPARATOR(), expected);
        assertEq(usdc.decimals(), 6);
    }

    function test_permitMatch_oneTxEach_paysInDollars() public {
        (address carol, uint256 carolKey) = makeAddrAndKey("carol");
        (address dave, uint256 daveKey) = makeAddrAndKey("dave");
        CircleUSDC.mint(carol, 10e6);
        CircleUSDC.mint(dave, 10e6);
        vm.deal(carol, 1 ether);
        uint256[] memory cDeck = giveStarter(carol);
        uint256[] memory dDeck = giveStarter(dave);
        uint128 stake = arena.stakeFor(1); // 5 USDC

        MempireArena.Permit memory pc = _permit(carolKey, carol, stake);
        vm.prank(carol);
        uint64 id = arena.createMatch{value: 0.02 ether}(1, cDeck, aliceSession, 0, pc);
        assertEq(usdc.balanceOf(address(arena)), stake);
        assertEq(aliceSession.balance, 0.02 ether);

        MempireArena.Permit memory pd = _permit(daveKey, dave, stake);
        vm.prank(dave);
        arena.joinMatch(id, dDeck, bobSession, 0, pd);

        uint256 tBefore = usdc.balanceOf(treasury);
        vm.prank(aliceSession);
        arena.claim(id, 1, bytes32(0));
        vm.prank(bobSession);
        arena.claim(id, 1, bytes32(0));
        assertEq(usdc.balanceOf(dave), 5e6 + 9e6);
        assertEq(usdc.balanceOf(carol), 5e6);
        assertEq(usdc.balanceOf(treasury) - tBefore, 1e6);
        assertEq(usdc.balanceOf(address(arena)), 0);
    }

    function test_frontRunPermitStillWorks() public {
        (address carol, uint256 carolKey) = makeAddrAndKey("carol");
        CircleUSDC.mint(carol, 10e6);
        uint256[] memory cDeck = giveStarter(carol);
        uint128 stake = arena.stakeFor(0);
        MempireArena.Permit memory pc = _permit(carolKey, carol, stake);
        // Someone submits Carol's permit first; her create must still succeed.
        usdc.permit(carol, address(arena), stake, pc.deadline, pc.v, pc.r, pc.s);
        vm.prank(carol);
        arena.createMatch(0, cDeck, address(0), 0, pc);
        assertEq(usdc.balanceOf(address(arena)), stake);
    }

    // ── limits for a deployment that holds real money ─────────────────────────

    function test_stakeTiers_areDollars() public view {
        assertEq(arena.stakeFor(0), 1e6);
        assertEq(arena.stakeFor(1), 5e6);
        assertEq(arena.stakeFor(2), 25e6);
        assertEq(arena.stakeFor(3), 100e6);
        assertEq(arena.stakeFor(4), 0);
    }

    function test_maxTier_capsNewMatches() public {
        uint256[] memory deck = giveStarter(alice);
        vm.prank(admin);
        arena.setLimits(1, false); // mainnet launch: $1 and $5 only
        vm.prank(alice);
        vm.expectRevert(MempireArena.TierClosed.selector);
        arena.createMatch(2, deck, address(0), 0, noPermit());
        vm.prank(alice);
        arena.createMatch(1, deck, address(0), 0, noPermit());

        vm.expectRevert(bytes("bad tier"));
        new MempireArena(admin, cards, address(usdc), meta, treasury, 4);
        vm.prank(admin);
        vm.expectRevert(bytes("bad tier"));
        arena.setLimits(4, false);
    }

    function test_pause_blocksNewMatchesOnly() public {
        uint256[] memory aDeck = giveStarter(alice);
        uint256[] memory bDeck = giveStarter(bob);
        vm.prank(alice);
        uint64 id = arena.createMatch(0, aDeck, aliceSession, 0, noPermit());
        vm.prank(admin);
        arena.setLimits(3, true);

        vm.prank(carolAddr());
        vm.expectRevert(MempireArena.Paused.selector);
        arena.createMatch(0, new uint256[](8), address(0), 0, noPermit());

        // An open match can still be joined, played and settled while paused.
        vm.prank(bob);
        arena.joinMatch(id, bDeck, bobSession, 0, noPermit());
        vm.prank(aliceSession);
        arena.play(id, 10, 0, 0, 0);
        vm.prank(aliceSession);
        arena.claim(id, 0, bytes32(0));
        vm.prank(bobSession);
        arena.claim(id, 0, bytes32(0));
        assertEq(arena.getMatch(id).state, arena.STATE_SETTLED());
    }

    function test_limitsAndRules_ownerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arena.setLimits(3, true);
        vm.prank(admin);
        vm.expectRevert(bytes("bad rules"));
        arena.setRules(2_001, 500, 12, 8 minutes);
    }

    function carolAddr() internal returns (address) {
        return makeAddr("carol");
    }

    function test_mergeBlockedWhileLocked_freedAfterSettle() public {
        (uint64 id, uint256[] memory aDeck,) = startMatch(1);
        uint256 dupe = mintAs(alice, 0);
        vm.startPrank(alice);
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
        (uint64 id,,) = startMatch(tier);
        uint256 total = usdc.balanceOf(alice) + usdc.balanceOf(bob) + usdc.balanceOf(treasury)
            + usdc.balanceOf(address(arena));
        vm.prank(aliceSession);
        arena.claim(id, a, bytes32(0));
        vm.prank(bobSession);
        arena.claim(id, b, bytes32(0));
        assertEq(usdc.balanceOf(address(arena)), 0);
        assertEq(usdc.balanceOf(alice) + usdc.balanceOf(bob) + usdc.balanceOf(treasury), total);
    }
}
