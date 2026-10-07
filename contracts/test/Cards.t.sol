// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {MempireCards} from "../src/MempireCards.sol";

contract CardsTest is Base {
    function test_mintWithMon_recordsPythPrice_andPaysTreasury() public {
        uint256 before = treasury.balance;
        vm.prank(alice);
        uint256 id = cards.mint{value: MINT_FEE + 1}(3, update(3, 6_950_000_000_000));
        MempireCards.Card memory c = cards.card(id);
        assertEq(cards.ownerOf(id), alice);
        assertEq(c.coinId, 3);
        assertEq(c.level, 1);
        assertEq(c.mintPrice, 6_950_000_000_000);
        assertEq(c.mintExpo, -8);
        assertEq(c.archetype, cards.archetypeFor(feed(3)));
        assertEq(treasury.balance - before, MINT_FEE);
        assertEq(cards.coinCount(alice, 3), 1);
    }

    function test_mint_wrongPayment_reverts() public {
        vm.prank(alice);
        vm.expectRevert(MempireCards.WrongPayment.selector);
        cards.mint{value: MINT_FEE}(3, update(3, 1));
    }

    function test_mint_withoutFreshPrice_reverts() public {
        bytes[] memory none = new bytes[](0);
        vm.prank(alice);
        vm.expectRevert(bytes("PriceFeedNotFound"));
        cards.mint{value: MINT_FEE}(3, none);
    }

    function test_mint_stalePrice_reverts() public {
        vm.prank(alice);
        cards.mint{value: MINT_FEE + 1}(3, update(3, 100));
        vm.warp(block.timestamp + 10 minutes);
        bytes[] memory none = new bytes[](0);
        vm.prank(alice);
        vm.expectRevert(bytes("StalePrice"));
        cards.mint{value: MINT_FEE}(3, none);
    }

    function test_mintWithMempire_takesTokensNotMon() public {
        uint256 tBefore = token.balanceOf(treasury);
        uint256 monBefore = treasury.balance;
        vm.startPrank(alice);
        token.approve(address(cards), type(uint256).max);
        cards.mintWithMempire{value: 1}(5, update(5, 42));
        vm.stopPrank();
        assertEq(token.balanceOf(treasury) - tBefore, 250 ether);
        assertEq(treasury.balance, monBefore);
    }

    function test_registerCoins_batch_andPriceAgeBounds() public {
        bytes32[] memory f = new bytes32[](2);
        f[0] = keccak256("stock");
        f[1] = keccak256("crypto");
        string[] memory t = new string[](2);
        t[0] = "NVDA";
        t[1] = "BTC2";
        uint32[] memory a = new uint32[](2);
        a[0] = 4 days;
        a[1] = 120;
        vm.prank(admin);
        cards.registerCoins(f, t, a);
        assertEq(cards.coinCountTotal(), ROSTER + 2);
        assertEq(cards.coin(ROSTER).maxPriceAge, 4 days);

        // A stock priced three days ago (a long weekend) still mints.
        vm.prank(alice);
        bytes[] memory u = new bytes[](1);
        u[0] = abi.encode(f[0], int64(18_000_000_000), int32(-8));
        cards.mint{value: MINT_FEE + 1}(ROSTER, u);
        vm.warp(block.timestamp + 3 days);
        vm.prank(alice);
        cards.mint{value: MINT_FEE}(ROSTER, new bytes[](0));

        vm.startPrank(admin);
        vm.expectRevert(MempireCards.BadPriceAge.selector);
        cards.registerCoin(keccak256("z"), "Z", 5 days);
        vm.expectRevert(MempireCards.BadPriceAge.selector);
        cards.registerCoin(keccak256("z"), "Z", 10);
        vm.stopPrank();
    }

    function test_inactiveCoin_cannotMint() public {
        vm.prank(admin);
        cards.setCoinActive(2, false);
        vm.prank(alice);
        vm.expectRevert(MempireCards.CoinInactive.selector);
        cards.mint{value: MINT_FEE + 1}(2, update(2, 1));
    }

    function test_registerCoin_rejectsDuplicateFeed_andIsOwnerOnly() public {
        vm.prank(admin);
        vm.expectRevert(MempireCards.FeedTaken.selector);
        cards.registerCoin(feed(0), "DUP", 120);
        vm.prank(alice);
        vm.expectRevert();
        cards.registerCoin(keccak256("x"), "X", 120);
    }

    function test_starter_onlyRelayer_oncePerAddress_distinctCoins() public {
        vm.prank(alice);
        vm.expectRevert(MempireCards.NotRelayer.selector);
        cards.mintStarter(alice, starterCoins(0));

        uint256[] memory ids = giveStarter(alice);
        assertEq(ids.length, 8);
        (uint256[] memory owned,,) = cards.cardsOf(alice);
        assertEq(owned.length, 8);

        vm.prank(relayer);
        vm.expectRevert(MempireCards.StarterTaken.selector);
        cards.mintStarter(alice, starterCoins(0));

        uint16[] memory dup = starterCoins(0);
        dup[7] = 0;
        vm.prank(relayer);
        vm.expectRevert(MempireCards.DuplicateCoin.selector);
        cards.mintStarter(bob, dup);
    }

    function test_merge_levelsUp_burnsDuplicate_chargesPerLevel() public {
        vm.startPrank(alice);
        uint256 keep = cards.mint{value: MINT_FEE + 1}(1, update(1, 1));
        uint256 d1 = cards.mint{value: MINT_FEE + 1}(1, update(1, 1));
        uint256 d2 = cards.mint{value: MINT_FEE + 1}(1, update(1, 1));
        token.approve(address(cards), type(uint256).max);

        uint256 t0 = token.balanceOf(treasury);
        cards.merge(keep, d1);
        assertEq(cards.card(keep).level, 2);
        assertEq(token.balanceOf(treasury) - t0, 100 ether);
        vm.expectRevert();
        cards.ownerOf(d1);

        cards.merge(keep, d2);
        assertEq(cards.card(keep).level, 3);
        assertEq(token.balanceOf(treasury) - t0, 300 ether);
        assertEq(cards.coinCount(alice, 1), 1);
        vm.stopPrank();
    }

    function test_merge_rejectsSelf_differentCoins_foreignCards() public {
        vm.startPrank(alice);
        uint256 a = cards.mint{value: MINT_FEE + 1}(1, update(1, 1));
        uint256 b = cards.mint{value: MINT_FEE + 1}(2, update(2, 1));
        token.approve(address(cards), type(uint256).max);
        vm.expectRevert(MempireCards.SameCard.selector);
        cards.merge(a, a);
        vm.expectRevert(MempireCards.DifferentCoins.selector);
        cards.merge(a, b);
        vm.stopPrank();

        vm.prank(bob);
        uint256 c = cards.mint{value: MINT_FEE + 1}(1, update(1, 1));
        vm.prank(alice);
        vm.expectRevert(MempireCards.NotOwner.selector);
        cards.merge(a, c);
    }

    function test_merge_capsAtTen() public {
        vm.startPrank(alice);
        token.approve(address(cards), type(uint256).max);
        uint256 keep = cards.mint{value: MINT_FEE + 1}(4, update(4, 1));
        for (uint256 i; i < 9; ++i) {
            uint256 d = cards.mint{value: MINT_FEE + 1}(4, update(4, 1));
            cards.merge(keep, d);
        }
        assertEq(cards.card(keep).level, 10);
        uint256 extra = cards.mint{value: MINT_FEE + 1}(4, update(4, 1));
        vm.expectRevert(MempireCards.MaxLevel.selector);
        cards.merge(keep, extra);
        vm.stopPrank();
    }

    function test_lockDeck_onlyArena() public {
        uint256[] memory ids = giveStarter(alice);
        vm.expectRevert(MempireCards.NotArena.selector);
        cards.lockDeck(alice, ids, 1);
    }

    function test_tokenURI_pointsAtMetadataServer() public {
        uint256[] memory ids = giveStarter(alice);
        assertEq(cards.tokenURI(ids[0]), "https://api.mempire.fun/nft/1");
    }

    function test_transferKeepsIndexAndCountsConsistent() public {
        uint256[] memory ids = giveStarter(alice);
        vm.prank(alice);
        cards.transferFrom(alice, bob, ids[2]);
        (uint256[] memory a,,) = cards.cardsOf(alice);
        (uint256[] memory b,,) = cards.cardsOf(bob);
        assertEq(a.length, 7);
        assertEq(b.length, 1);
        assertEq(b[0], ids[2]);
        assertEq(cards.coinCount(alice, 2), 0);
        assertEq(cards.coinCount(bob, 2), 1);
        for (uint256 i; i < a.length; ++i) {
            assertTrue(a[i] != ids[2]);
        }
    }

    // ── chests ──────────────────────────────────────────────────────────────

    function _grant(address who) internal returns (uint256 id) {
        id = cards.nextChestId();
        vm.prank(address(arena));
        cards.grantChest(who, keccak256("e"));
    }

    function test_grantChest_onlyArena_andFourSlots() public {
        vm.expectRevert(MempireCards.NotArena.selector);
        cards.grantChest(alice, bytes32(0));
        for (uint256 i; i < 4; ++i) {
            _grant(alice);
        }
        assertEq(cards.activeChests(alice), 4);
        uint256 next = cards.nextChestId();
        _grant(alice); // forfeited
        assertEq(cards.nextChestId(), next);
        assertEq(cards.activeChests(alice), 4);
    }

    function test_chest_timer_open_reveal_mintsCards() public {
        giveStarter(alice);
        uint256 id = _grant(alice);
        (, uint8 tier,,,) = cards.chests(id);

        vm.startPrank(alice);
        vm.expectRevert(MempireCards.ChestNotReady.selector);
        cards.open(id);
        cards.startUnlock(id);
        vm.expectRevert(MempireCards.ChestNotReady.selector);
        cards.open(id);
        vm.warp(block.timestamp + cards.unlockSeconds(tier));
        cards.open(id);
        vm.expectRevert(MempireCards.TooEarly.selector);
        cards.reveal(id, starterCoins(0));
        vm.roll(block.number + 2);
        uint256[] memory got = cards.reveal(id, starterCoins(0));
        vm.stopPrank();

        assertEq(got.length, cards.cardsIn(tier));
        for (uint256 i; i < got.length; ++i) {
            assertEq(cards.ownerOf(got[i]), alice);
        }
        assertEq(cards.activeChests(alice), 0);
        vm.prank(alice);
        vm.expectRevert(MempireCards.BadChest.selector);
        cards.reveal(id, starterCoins(0));
    }

    function test_chest_oneUnlockAtATime_andSkipCosts25() public {
        uint256 a = _grant(alice);
        uint256 b = _grant(alice);
        vm.startPrank(alice);
        cards.startUnlock(a);
        vm.expectRevert(MempireCards.AnotherChestUnlocking.selector);
        cards.startUnlock(b);
        token.approve(address(cards), type(uint256).max);
        uint256 t0 = token.balanceOf(treasury);
        cards.skip(a);
        assertEq(token.balanceOf(treasury) - t0, 25 ether);
        cards.startUnlock(b); // a is finished, so b may start
        cards.open(a);
        vm.stopPrank();
    }

    function test_chest_staleRevealRecommits() public {
        uint256 id = _grant(alice);
        vm.startPrank(alice);
        token.approve(address(cards), type(uint256).max);
        cards.skip(id);
        cards.open(id);
        vm.roll(block.number + 300);
        uint256[] memory none = cards.reveal(id, new uint16[](0));
        assertEq(none.length, 0);
        (,, uint8 state,, uint64 revealBlock) = cards.chests(id);
        assertEq(state, 3);
        assertEq(revealBlock, block.number + 1);
        vm.roll(block.number + 2);
        uint256[] memory got = cards.reveal(id, new uint16[](0));
        assertGt(got.length, 0);
        vm.stopPrank();
    }

    function test_chest_onlyOwner() public {
        uint256 id = _grant(alice);
        vm.prank(bob);
        vm.expectRevert(MempireCards.BadChest.selector);
        cards.startUnlock(id);
    }

    function test_buyChest_landsWhenFull_andOpensNow() public {
        for (uint256 i; i < 4; ++i) {
            _grant(alice);
        }
        vm.startPrank(alice);
        token.approve(address(cards), type(uint256).max);
        uint256 id = cards.buyChest();
        assertEq(cards.activeChests(alice), 5);
        cards.open(id);
        vm.roll(block.number + 2);
        uint256[] memory got = cards.reveal(id, new uint16[](0));
        assertEq(got.length, 2); // golden
        vm.stopPrank();
        (uint256[] memory ids,) = cards.chestsOf(alice);
        assertEq(ids.length, 4);
    }

    function test_reveal_favoredCoinsYieldDuplicates() public {
        giveStarter(alice);
        uint256 dupes;
        uint256 total;
        // A local block counter: under via-ir, block.number is read once per
        // test function, so rolling relative to it never advances.
        uint256 bn = block.number;
        vm.startPrank(alice);
        token.approve(address(cards), type(uint256).max);
        for (uint256 k; k < 30; ++k) {
            uint256 id = cards.buyChest();
            cards.open(id);
            bn += 2;
            vm.roll(bn);
            uint256[] memory got = cards.reveal(id, starterCoins(0));
            for (uint256 i; i < got.length; ++i) {
                if (cards.card(got[i]).coinId < 8) ++dupes;
                ++total;
            }
        }
        vm.stopPrank();
        // 65% favoured plus 8/12 of the rest: comfortably over half.
        assertGt(dupes * 100, total * 55);
    }
}
