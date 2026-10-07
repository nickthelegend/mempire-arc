// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockV3Aggregator} from "@chainlink/local/src/data-feeds/MockV3Aggregator.sol";
import {MempireToken} from "../../src/MempireToken.sol";
import {MempireCards} from "../../src/MempireCards.sol";
import {MempireArena} from "../../src/MempireArena.sol";
import {MarketMeta} from "../../src/MarketMeta.sol";

interface IMemo {
    event Memo(
        address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex
    );

    function memo(address target, bytes calldata data, bytes32 memoId, bytes calldata memoData) external;
}

interface IGatewayWallet {
    function deposit(address token, uint256 value) external;
    function availableBalance(address token, address depositor) external view returns (uint256);
}

interface IGatewayMinter {
    function gatewayMint(bytes calldata attestationPayload, bytes calldata signature) external;
}

interface IIdentityRegistry {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function ownerOf(uint256) external view returns (address);
    function tokenURI(uint256) external view returns (string memory);
}

interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
    function getSummary(uint256 agentId, address[] calldata clients, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}

/// The rest of the Arc stack Mempire uses, against Arc MAINNET's own predeploys
/// on a local fork (nothing broadcast):
///
///  - **Memo** (0x5294…e505): stakes and result claims are sent through Arc's
///    Memo contract tagged with the match id; the arena still sees the player
///    (CallFrom preserves msg.sender) and the Memo event carries the tag.
///  - **Circle Gateway** (GatewayWallet 0x7777…00eE): a player parks USDC in
///    their unified balance from Arc; the deposit is credited.
///  - **ERC-8004** (Identity 0x8004A169…, Reputation 0x8004BAa1…): the game's AI
///    opponent is registered as an agent and players rate it after a match.
///
///   FORK_TESTS=1 forge test --network arc --match-path test/fork/ArcStackFork.t.sol -vv
contract ArcStackForkTest is Test {
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant MEMO = 0x5294E9927c3306DcBaDb03fe70b92e01cCede505;
    address internal constant GATEWAY_WALLET = 0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE;
    address internal constant GATEWAY_MINTER = 0x2222222d7164433c4C09B0b0D809a9b52C04C205;
    address internal constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    bool internal enabled;

    function setUp() public {
        enabled = vm.envOr("FORK_TESTS", uint256(0)) == 1;
        if (!enabled) return;
        vm.createSelectFork(vm.envOr("ARC_MAINNET_RPC", string("https://rpc.mainnet.arc.io")));
        assertEq(block.chainid, 5042);
    }

    function test_fork_memo_tagsStakeAndClaimWithTheMatchId() public {
        if (!enabled) return;
        MempireToken token = new MempireToken(address(this));
        MempireCards cards =
            new MempireCards(address(this), token, IERC20(USDC), makeAddr("treasury"), 50_000, 1, "https://x.test/");
        MempireArena arena = new MempireArena(address(this), cards, USDC, MarketMeta(address(0)), makeAddr("treasury"), 1);
        cards.setArena(address(arena));
        cards.setRelayer(address(this));
        for (uint16 i; i < 8; ++i) {
            cards.registerCoin(keccak256(abi.encode(i)), "C", 26 hours, address(new MockV3Aggregator(8, 1e8)));
        }
        address p0 = makeAddr("p0");
        address p1 = makeAddr("p1");
        uint16[] memory ids = new uint16[](8);
        for (uint16 i; i < 8; ++i) ids[i] = i;
        uint256[] memory d0 = cards.mintStarter(p0, ids);
        uint256[] memory d1 = cards.mintStarter(p1, ids);
        vm.deal(p0, 3 ether);
        vm.deal(p1, 3 ether);
        vm.prank(p0, p0);
        IERC20(USDC).approve(address(arena), type(uint256).max);
        vm.prank(p1, p1);
        IERC20(USDC).approve(address(arena), type(uint256).max);

        MempireArena.Permit memory none;
        bytes32 tag = keccak256(abi.encodePacked("mempire:match:", uint256(1)));
        vm.recordLogs();
        vm.prank(p0, p0); // an EOA transaction, as Memo requires
        IMemo(MEMO).memo(
            address(arena), abi.encodeCall(MempireArena.createMatch, (0, d0, address(0), none)), tag, bytes("stake:seat0:$1")
        );
        assertEq(arena.getMatch(1).p0, p0, "CallFrom kept the player as msg.sender");
        _assertMemo(p0, address(arena), tag);

        vm.prank(p1, p1);
        IMemo(MEMO).memo(address(arena), abi.encodeCall(MempireArena.joinMatch, (1, d1, address(0), none)), tag, bytes("stake:seat1:$1"));
        vm.prank(p0, p0);
        arena.claim(1, 1, bytes32(0));
        uint256 before = IERC20(USDC).balanceOf(p1);
        vm.recordLogs();
        vm.prank(p1, p1); // the settling claim: the payout lands inside this memo frame
        IMemo(MEMO).memo(
            address(arena), abi.encodeCall(MempireArena.claim, (1, 1, bytes32(0))), tag, bytes("payout:winner:seat1")
        );
        assertEq(IERC20(USDC).balanceOf(p1) - before, 1.8e6, "payout, tagged with the match id");
        _assertMemo(p1, address(arena), tag);
    }

    function _assertMemo(address sender, address target, bytes32 tag) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == MEMO && logs[i].topics.length == 4 && logs[i].topics[0] == IMemo.Memo.selector) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), sender);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), target);
                assertEq(logs[i].topics[3], tag);
                seen = true;
            }
        }
        assertTrue(seen, "Memo event with the match id");
    }

    function test_fork_gateway_depositToUnifiedBalance_fromArc() public {
        if (!enabled) return;
        address p = makeAddr("player");
        vm.deal(p, 5 ether); // 5 USDC
        vm.startPrank(p, p);
        IERC20(USDC).approve(GATEWAY_WALLET, 2e6);
        IGatewayWallet(GATEWAY_WALLET).deposit(USDC, 2e6);
        vm.stopPrank();
        assertEq(IGatewayWallet(GATEWAY_WALLET).availableBalance(USDC, p), 2e6, "credited to the unified balance");
        assertEq(IERC20(USDC).balanceOf(p), 3e6);
        // A mint needs Circle's attestation; a forged one is refused by the real minter.
        vm.expectRevert();
        IGatewayMinter(GATEWAY_MINTER).gatewayMint(hex"00", hex"00");
    }

    function test_fork_erc8004_aiOpponentIdentityAndReputation() public {
        if (!enabled) return;
        address operator = makeAddr("mempireOperator");
        vm.prank(operator, operator);
        uint256 agentId = IIdentityRegistry(IDENTITY).register("https://mempire.fun/agents/kimi-strategist.json");
        assertEq(IIdentityRegistry(IDENTITY).ownerOf(agentId), operator);
        emit log_named_uint("AI opponent agentId", agentId);

        address player = makeAddr("player");
        vm.prank(player, player);
        IReputationRegistry(REPUTATION).giveFeedback(
            agentId, 80, 0, "mempire.match", "ai-won", "", "", keccak256("match:42")
        );
        address[] memory clients = new address[](1);
        clients[0] = player;
        (uint64 count, int128 value,) = IReputationRegistry(REPUTATION).getSummary(agentId, clients, "mempire.match", "");
        assertEq(count, 1);
        assertEq(value, 80);
        // The operator can't rate its own agent (ERC-8004 anti self-dealing).
        vm.prank(operator, operator);
        vm.expectRevert();
        IReputationRegistry(REPUTATION).giveFeedback(agentId, 100, 0, "mempire.match", "", "", "", bytes32(0));
    }
}
