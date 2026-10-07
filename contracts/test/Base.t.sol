// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MempireToken} from "../src/MempireToken.sol";
import {MempireCards} from "../src/MempireCards.sol";
import {MempireArena} from "../src/MempireArena.sol";
import {MarketMeta} from "../src/MarketMeta.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";
import {MockPyth} from "./mocks/MockPyth.sol";
import {MockAUSD} from "./mocks/MockAUSD.sol";

abstract contract Base is Test {
    MempireToken internal token;
    MempireCards internal cards;
    MempireArena internal arena;
    MarketMeta internal meta;
    MockPyth internal pyth;
    MockAUSD internal ausd;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal relayer = makeAddr("relayer");
    address internal forwarder = makeAddr("forwarder");
    address internal alice;
    uint256 internal aliceKey;
    address internal bob;
    uint256 internal bobKey;
    address internal aliceSession = makeAddr("aliceSession");
    address internal bobSession = makeAddr("bobSession");

    uint256 internal constant MINT_FEE = 0.01 ether;
    uint16 internal constant ROSTER = 12;

    function setUp() public virtual {
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");

        pyth = new MockPyth();
        ausd = new MockAUSD();
        token = new MempireToken(admin);
        cards = new MempireCards(admin, token, IPyth(address(pyth)), treasury, MINT_FEE, 60, "https://api.mempire.fun/nft/");
        meta = new MarketMeta(admin, forwarder);
        arena = new MempireArena(admin, cards, address(ausd), meta, treasury);

        vm.startPrank(admin);
        cards.setArena(address(arena));
        cards.setRelayer(relayer);
        meta.setPyth(IPyth(address(pyth)), cards);
        for (uint16 i; i < ROSTER; ++i) {
            cards.registerCoin(feed(i), string.concat("C", vm.toString(i)), 120);
        }
        // Fund the win-reward pool and give both players some $MEMPIRE.
        token.transfer(address(arena), 10_000 ether);
        token.transfer(alice, 100_000 ether);
        token.transfer(bob, 100_000 ether);
        vm.stopPrank();

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        ausd.mint(alice, 1_000e6);
        ausd.mint(bob, 1_000e6);
    }

    function feed(uint16 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("feed", i));
    }

    function update(uint16 coinId, int64 price) internal pure returns (bytes[] memory u) {
        u = new bytes[](1);
        u[0] = abi.encode(feed(coinId), price, int32(-8));
    }

    function starterCoins(uint16 offset) internal pure returns (uint16[] memory ids) {
        ids = new uint16[](8);
        for (uint16 i; i < 8; ++i) {
            ids[i] = i + offset;
        }
    }

    function giveStarter(address who) internal returns (uint256[] memory ids) {
        vm.prank(relayer);
        ids = cards.mintStarter(who, starterCoins(0));
    }

    function noPermit() internal pure returns (MempireArena.Permit memory p) {}

    /// Alice opens a MON match, Bob joins; returns the match id.
    function startMonMatch(uint8 tier) internal returns (uint64 id, uint256[] memory aDeck, uint256[] memory bDeck) {
        aDeck = giveStarter(alice);
        bDeck = giveStarter(bob);
        uint128 stake = arena.stakeFor(address(0), tier);
        vm.prank(alice);
        id = arena.createMatch{value: stake + 0.05 ether}(tier, address(0), aDeck, aliceSession, noPermit());
        vm.prank(bob);
        arena.joinMatch{value: stake + 0.05 ether}(id, bDeck, bobSession, noPermit());
    }
}
