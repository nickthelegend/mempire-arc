// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MempireToken} from "../src/MempireToken.sol";
import {MempireCards} from "../src/MempireCards.sol";
import {MempireArena} from "../src/MempireArena.sol";
import {MarketMeta} from "../src/MarketMeta.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";
import {MockPyth} from "./mocks/MockPyth.sol";
import {CircleUSDC, IFiatToken} from "./utils/CircleUSDC.sol";

abstract contract Base is Test {
    MempireToken internal token;
    MempireCards internal cards;
    MempireArena internal arena;
    MarketMeta internal meta;
    MockPyth internal pyth;
    /// Circle's FiatToken v2.2 at Arc's USDC address, with Arc's EIP-712 domain.
    IFiatToken internal usdc;

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

    uint256 internal constant MINT_FEE = 50_000; // 0.05 USDC, 6 decimals
    uint16 internal constant ROSTER = 12;

    function setUp() public virtual {
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");

        pyth = new MockPyth();
        usdc = CircleUSDC.deploy();
        token = new MempireToken(admin);
        cards = new MempireCards(
            admin, token, IERC20(address(usdc)), IPyth(address(pyth)), treasury, MINT_FEE, 60, "https://api.mempire.fun/nft/"
        );
        meta = new MarketMeta(admin, forwarder);
        arena = new MempireArena(admin, cards, address(usdc), meta, treasury, 3);

        vm.startPrank(admin);
        cards.setArena(address(arena));
        cards.setRelayer(relayer);
        meta.setOracle(IPyth(address(pyth)), cards);
        for (uint16 i; i < ROSTER; ++i) {
            cards.registerCoin(feed(i), string.concat("C", vm.toString(i)), 120);
        }
        // Fund the win-reward pool and give both players some $MEMPIRE.
        token.transfer(address(arena), 10_000 ether);
        token.transfer(alice, 100_000 ether);
        token.transfer(bob, 100_000 ether);
        vm.stopPrank();

        // Native USDC (18 decimals) for session-key gas; ERC-20 USDC (6 decimals) for stakes and mints.
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        CircleUSDC.mint(alice, 1_000e6);
        CircleUSDC.mint(bob, 1_000e6);
        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? alice : bob;
            vm.startPrank(who);
            usdc.approve(address(arena), type(uint256).max);
            usdc.approve(address(cards), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// Mint a card as `who`, paying the USDC fee and the oracle's 1-wei update fee.
    function mintAs(address who, uint16 coinId) internal returns (uint256 id) {
        vm.prank(who);
        id = cards.mint{value: 1}(coinId, update(coinId, 1), noCardPermit());
    }

    function noCardPermit() internal pure returns (MempireCards.Permit memory p) {}

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

    /// Alice opens a USDC match, Bob joins, both arm a session key with 0.05
    /// native USDC of gas; returns the match id.
    function startMatch(uint8 tier) internal returns (uint64 id, uint256[] memory aDeck, uint256[] memory bDeck) {
        aDeck = giveStarter(alice);
        bDeck = giveStarter(bob);
        vm.prank(alice);
        id = arena.createMatch{value: 0.05 ether}(tier, aDeck, aliceSession, noPermit());
        vm.prank(bob);
        arena.joinMatch{value: 0.05 ether}(id, bDeck, bobSession, noPermit());
    }
}
