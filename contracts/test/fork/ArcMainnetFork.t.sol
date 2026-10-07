// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {MempireToken} from "../../src/MempireToken.sol";
import {MempireCards} from "../../src/MempireCards.sol";
import {MempireArena} from "../../src/MempireArena.sol";
import {MarketMeta} from "../../src/MarketMeta.sol";
import {MempireCCIPGateway} from "../../src/ccip/MempireCCIPGateway.sol";
import {MempireRemoteEntry} from "../../src/ccip/MempireRemoteEntry.sol";
import {MempireMessages} from "../../src/ccip/MempireMessages.sol";
import {ITokenMessengerV2} from "../../src/interfaces/ITokenMessengerV2.sol";

interface IFiatPermit {
    function nonces(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// Against the real thing, on local forks (nothing is broadcast anywhere):
///
///  - **Arc mainnet** (5042): every roster fighter's Chainlink Data Feed is live
///    and fresh; our contracts, deployed on the fork, mint at the real feed price
///    and compute the daily meta from real feed history; the CCIP gateway accepts
///    an ENTER delivered by the real Arc CCIP router address, staking real USDC.
///  - **Base mainnet** (8453): MempireRemoteEntry quotes the real Base→Arc CCIP
///    lane and sends through the real Router and OnRamp, after a real CCTP V2
///    Fast Transfer burn of real USDC towards Arc's domain 26.
///
///   FORK_TESTS=1 forge test --match-path test/fork/ArcMainnetFork.t.sol -vv
///
/// Skipped unless FORK_TESTS=1 (needs network). RPCs: ARC_MAINNET_RPC, BASE_MAINNET_RPC.
contract ArcMainnetForkTest is Test {
    using stdJson for string;

    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant ARC_ROUTER = 0xB79791184973589c38e114D43Eb8E4588C283A18;
    uint64 internal constant ARC_SELECTOR = 6370580034781731079;
    address internal constant BASE_ROUTER = 0x881e3A65B4d4a04dD529061dd0071cf975F58bCD;
    uint64 internal constant BASE_SELECTOR = 15971525489660198786;
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant TOKEN_MESSENGER_V2 = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;

    struct Coin {
        bytes32 feedId;
        string ticker;
        uint32 maxAge;
        address feed;
        uint8 decimals;
    }

    Coin[] internal roster;
    bool internal enabled;

    function setUp() public {
        enabled = vm.envOr("FORK_TESTS", uint256(0)) == 1;
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../shared/roster.json"));
        uint256 n = abi.decode(vm.parseJson(json, ".coins[*].coinId"), (uint256[])).length;
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".coins[", vm.toString(i), "]");
            roster.push(
                Coin({
                    feedId: json.readBytes32(string.concat(k, ".feedId")),
                    ticker: json.readString(string.concat(k, ".ticker")),
                    maxAge: uint32(json.readUint(string.concat(k, ".maxPriceAge"))),
                    feed: json.readAddress(string.concat(k, ".feed")),
                    decimals: uint8(json.readUint(string.concat(k, ".decimals")))
                })
            );
        }
    }

    function _arc() internal {
        vm.createSelectFork(vm.envOr("ARC_MAINNET_RPC", string("https://rpc.mainnet.arc.io")));
        assertEq(block.chainid, 5042);
    }

    // ─────────────────────────────────────────────────────────────── feeds

    function test_fork_everyFighterHasALiveChainlinkFeedOnArc() public {
        if (!enabled) return;
        _arc();
        for (uint256 i; i < roster.length; ++i) {
            Coin memory c = roster[i];
            AggregatorV3Interface f = AggregatorV3Interface(c.feed);
            assertGt(c.feed.code.length, 0, c.ticker);
            assertEq(f.decimals(), c.decimals, c.ticker);
            (uint80 r, int256 answer,, uint256 updatedAt, uint80 answeredIn) = f.latestRoundData();
            assertGt(answer, 0, c.ticker);
            assertGe(answeredIn, r, c.ticker);
            assertLe(block.timestamp - updatedAt, c.maxAge, string.concat(c.ticker, " stale"));
            emit log_named_int(string.concat(c.ticker, " / USD"), answer);
        }
    }

    function _deploy(address owner) internal returns (MempireCards cards, MarketMeta meta, MempireArena arena) {
        MempireToken token = new MempireToken(owner);
        cards = new MempireCards(owner, token, IERC20(USDC), makeAddr("treasury"), 50_000, 1, "https://example.test/nft/");
        meta = new MarketMeta(owner, address(0)); // no CRE on Arc mainnet
        arena = new MempireArena(owner, cards, USDC, meta, owner, 1);
        cards.setArena(address(arena));
        cards.setRelayer(makeAddr("relayer"));
        meta.setCards(cards);
        bytes32[] memory ids = new bytes32[](roster.length);
        string[] memory tickers = new string[](roster.length);
        uint32[] memory ages = new uint32[](roster.length);
        address[] memory feeds = new address[](roster.length);
        for (uint256 i; i < roster.length; ++i) {
            ids[i] = roster[i].feedId;
            tickers[i] = roster[i].ticker;
            ages[i] = roster[i].maxAge;
            feeds[i] = roster[i].feed;
        }
        cards.registerCoins(ids, tickers, ages, feeds);
    }

    /// The round that was current 24 hours ago, found the way the relay's keeper finds it.
    function _dayAgoRound(AggregatorV3Interface f) internal view returns (uint80 r) {
        (r,,,,) = f.latestRoundData();
        uint256 cutoff = block.timestamp - 1 days;
        for (uint256 guard; guard < 500; ++guard) {
            (,,, uint256 at,) = f.getRoundData(r);
            if (at <= cutoff) return r;
            r -= 1;
        }
        revert("no round 24h back within 500 rounds");
    }

    function test_fork_mintAndDailyMeta_fromRealFeeds() public {
        if (!enabled) return;
        _arc();
        address owner = address(this);
        (MempireCards cards, MarketMeta meta,) = _deploy(owner);

        // A player with real USDC on Arc: native and ERC-20 are one balance.
        address p = makeAddr("player");
        vm.deal(p, 5 ether); // 5 USDC, native units
        assertEq(IERC20(USDC).balanceOf(p), 5e6);
        vm.startPrank(p);
        IERC20(USDC).approve(address(cards), type(uint256).max);
        uint256 id = cards.mint(0, MempireCards.Permit(0, 0, 0, 0)); // BTC
        vm.stopPrank();
        (, int256 btc,,,) = AggregatorV3Interface(roster[0].feed).latestRoundData();
        assertEq(cards.card(id).mintPrice, int64(btc), "card stamped with Chainlink's BTC/USD");
        assertEq(IERC20(USDC).balanceOf(makeAddr("treasury")), 50_000, "treasury took the $0.05 fee in real USDC");

        // The daily meta, computed on chain from the real feeds' history.
        uint16[] memory coinIds = new uint16[](roster.length);
        uint80[] memory hints = new uint80[](roster.length);
        for (uint256 i; i < roster.length; ++i) {
            coinIds[i] = uint16(i);
            hints[i] = _dayAgoRound(AggregatorV3Interface(roster[i].feed));
        }
        (uint64 epoch, int16[] memory bps) = meta.postFromFeeds(coinIds, hints);
        for (uint256 i; i < roster.length; ++i) {
            AggregatorV3Interface f = AggregatorV3Interface(roster[i].feed);
            (, int256 nowP,,,) = f.latestRoundData();
            (, int256 thenP,,,) = f.getRoundData(hints[i]);
            assertEq(bps[i], meta.momentumBps(nowP, thenP), roster[i].ticker);
            emit log_named_int(string.concat(roster[i].ticker, " meta bps"), bps[i]);
        }
        assertEq(meta.epochSource(epoch), meta.SOURCE_FEEDS());
        // A wrong hint for BTC is refused: one round too new, or one too old.
        vm.expectRevert(abi.encodeWithSelector(MarketMeta.BadRoundHint.selector, uint16(0)));
        meta.feedMomentumBps(0, hints[0] + 1);
        vm.expectRevert(abi.encodeWithSelector(MarketMeta.BadRoundHint.selector, uint16(0)));
        meta.feedMomentumBps(0, hints[0] - 1);
    }

    // ─────────────────────────────────────────────────────────────── CCIP

    function test_fork_gatewayAcceptsAnEnterFromTheRealArcRouter() public {
        if (!enabled) return;
        _arc();
        address owner = address(this);
        (MempireCards cards,, MempireArena arena) = _deploy(owner);
        MempireCCIPGateway gateway = new MempireCCIPGateway(
            owner, ARC_ROUTER, arena, IERC20(USDC), ITokenMessengerV2(TOKEN_MESSENGER_V2), 100e6
        );
        arena.setEntryGateway(address(gateway));
        address remote = makeAddr("remoteEntryOnBase");
        gateway.setRemoteEntry(BASE_SELECTOR, remote, 6);

        (address p, uint256 key) = makeAddrAndKey("crossChainPlayer");
        vm.prank(makeAddr("relayer"));
        uint16[] memory starter = new uint16[](8);
        for (uint16 i; i < 8; ++i) starter[i] = i;
        uint256[] memory deck = cards.mintStarter(p, starter);
        vm.deal(p, 3 ether); // as if CCTP had minted 3 USDC to the player on Arc

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IFiatPermit(USDC).DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        p,
                        address(arena),
                        uint256(1e6),
                        IFiatPermit(USDC).nonces(p),
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        MempireMessages.Enter memory e = MempireMessages.Enter(0, 0, deck, address(0), deadline, v, r, s);
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: keccak256("fork-enter"),
            sourceChainSelector: BASE_SELECTOR,
            sender: abi.encode(remote),
            data: abi.encode(MempireMessages.ENTER, p, abi.encode(e)),
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
        vm.prank(ARC_ROUTER); // delivered by Chainlink's Arc mainnet router (its OffRamp calls through it)
        uint256 g = gasleft();
        gateway.ccipReceive(m);
        emit log_named_uint("ENTER(create) gas on Arc", g - gasleft());
        assertEq(arena.getMatch(1).p0, p);
        assertEq(IERC20(USDC).balanceOf(address(arena)), 1e6, "real USDC escrowed by the player's permit");
        assertLt(g - gasleft(), 450_000, "inside MempireRemoteEntry.ENTER_GAS");
    }

    function test_fork_baseSide_cctpBurnAndCcipSend_onTheRealLane() public {
        if (!enabled) return;
        vm.createSelectFork(vm.envOr("BASE_MAINNET_RPC", string("https://mainnet.base.org")));
        assertEq(block.chainid, 8453);
        IRouterClient router = IRouterClient(BASE_ROUTER);
        assertTrue(router.isChainSupported(ARC_SELECTOR), "Base -> Arc CCIP lane");
        address arcGateway = makeAddr("arcGateway"); // the address the Arc deploy would print
        MempireRemoteEntry remote = new MempireRemoteEntry(
            router, ARC_SELECTOR, arcGateway, IERC20(BASE_USDC), ITokenMessengerV2(TOKEN_MESSENGER_V2)
        );

        address p = makeAddr("basePlayer");
        deal(BASE_USDC, p, 10e6);
        vm.deal(p, 1 ether);
        uint256[] memory deck = new uint256[](8);
        MempireMessages.Enter memory e = MempireMessages.Enter(0, 0, deck, address(0), 0, 0, 0, 0);
        uint256 fee = remote.quoteEnter(e);
        emit log_named_uint("CCIP fee Base->Arc ENTER (wei of ETH)", fee);
        assertGt(fee, 0);

        vm.startPrank(p);
        IERC20(BASE_USDC).approve(address(remote), 2e6);
        vm.recordLogs();
        // Real CCTP V2 Fast Transfer burn towards Arc (domain 26) + real ccipSend to Arc.
        bytes32 messageId = remote.enter{value: fee * 2}(e, 2e6, 2_000); // maxFee 0.002 USDC
        vm.stopPrank();
        assertTrue(messageId != bytes32(0));
        assertEq(IERC20(BASE_USDC).balanceOf(p), 8e6, "2 USDC burned by CCTP");
        assertEq(p.balance, 1 ether - fee, "fee paid in ETH, excess refunded");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawCcip;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(remote)) sawCcip = true;
        }
        assertTrue(sawCcip);
    }
}
