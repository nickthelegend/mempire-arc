// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CCIPLocalSimulator, IRouterClient} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";
import {CCIPLocalRouter} from "@chainlink/local/src/ccip/CCIPLocalRouter.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {Base} from "./Base.t.sol";
import {MempireArena} from "../src/MempireArena.sol";
import {MempireCCIPGateway} from "../src/ccip/MempireCCIPGateway.sol";
import {MempireRemoteEntry} from "../src/ccip/MempireRemoteEntry.sol";
import {MempireMessages} from "../src/ccip/MempireMessages.sol";
import {ITokenMessengerV2} from "../src/interfaces/ITokenMessengerV2.sol";
import {CircleUSDC} from "./utils/CircleUSDC.sol";
import {MockTokenMessengerV2} from "./mocks/MockTokenMessengerV2.sol";
import {SourceUSDC} from "./mocks/SourceUSDC.sol";

/// Cross-chain play, through Chainlink Local's CCIP simulator.
///
/// The source side (MempireRemoteEntry, "Base") and the destination side
/// (MempireCCIPGateway on "Arc") talk through CCIPLocalSimulator's router, which
/// executes the receiver synchronously with the gas limit the sender asked for —
/// so the ENTER/CASH_OUT gas budgets are tested for real. CCTP is a recording
/// test double: the test decides when the burned USDC "mints" on Arc, which is
/// how both arrival orders (CCTP first, CCIP first) are exercised.
contract CCIPGatewayTest is Base {
    CCIPLocalSimulator internal sim;
    IRouterClient internal router;
    uint64 internal selector;

    MockTokenMessengerV2 internal baseCctp;
    MockTokenMessengerV2 internal arcCctp;
    SourceUSDC internal baseUsdc;
    MempireCCIPGateway internal gateway;
    MempireRemoteEntry internal remote;

    address internal carol;
    uint256 internal carolKey;
    address internal dave;
    uint256 internal daveKey;

    uint32 internal constant BASE_DOMAIN = 6;

    function setUp() public override {
        super.setUp();
        sim = new CCIPLocalSimulator();
        (uint64 chainSelector, IRouterClient sourceRouter, IRouterClient destRouter,,,,) = sim.configuration();
        selector = chainSelector;
        router = sourceRouter;

        baseCctp = new MockTokenMessengerV2();
        arcCctp = new MockTokenMessengerV2();
        baseUsdc = new SourceUSDC();

        gateway = new MempireCCIPGateway(
            admin, address(destRouter), arena, IERC20(address(usdc)), ITokenMessengerV2(address(arcCctp)), 100e6
        );
        remote = new MempireRemoteEntry(router, selector, address(gateway), IERC20(address(baseUsdc)), baseCctp);
        vm.startPrank(admin);
        gateway.setRemoteEntry(selector, address(remote), BASE_DOMAIN);
        arena.setEntryGateway(address(gateway));
        vm.stopPrank();

        (carol, carolKey) = makeAddrAndKey("carol");
        (dave, daveKey) = makeAddrAndKey("dave");
        for (uint256 i; i < 2; ++i) {
            address p = i == 0 ? carol : dave;
            baseUsdc.mint(p, 20e6);
            vm.deal(p, 1 ether); // the source chain's native token, for the CCIP fee
            vm.prank(p);
            baseUsdc.approve(address(remote), type(uint256).max);
            giveStarter(p);
        }
    }

    // ─────────────────────────────────────────────────────────────── helpers

    /// The player's EIP-2612 signature over Arc's USDC (domain USDC / 2).
    function _permit(uint256 key, address owner, address spender, uint256 value)
        internal
        view
        returns (uint256 deadline, uint8 v, bytes32 r, bytes32 s)
    {
        deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                spender,
                value,
                usdc.nonces(owner),
                deadline
            )
        );
        (v, r, s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    function _deck(address p) internal view returns (uint256[] memory ids) {
        (ids,,) = cards.cardsOf(p);
    }

    function _enter(uint256 key, address p, uint64 matchId, uint8 tier) internal view returns (MempireMessages.Enter memory e) {
        (uint256 d, uint8 v, bytes32 r, bytes32 s) = _permit(key, p, address(arena), arena.stakeFor(tier));
        e = MempireMessages.Enter({
            matchId: matchId, tier: tier, cardIds: _deck(p), session: address(0), permitDeadline: d, v: v, r: r, s: s
        });
    }

    /// "CCTP delivers": the burned Base USDC is minted to the recipient on Arc.
    function _deliver(uint256 burnIndex) internal {
        (, uint256 amount, uint32 domain, bytes32 recipient,,,) = baseCctp.burns(burnIndex);
        assertEq(domain, 26, "burned towards Arc's CCTP domain");
        CircleUSDC.mint(address(uint160(uint256(recipient))), amount);
    }

    /// The failed message, rebuilt from the gateway's MessageFailed log — as the relay's watcher does.
    function _lastFailed() internal returns (Client.Any2EVMMessage memory m) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory l = logs[i - 1];
            if (l.topics[0] != MempireCCIPGateway.MessageFailed.selector) continue;
            (bytes memory sender, bytes memory data,) = abi.decode(l.data, (bytes, bytes, bytes));
            return Client.Any2EVMMessage({
                messageId: l.topics[1],
                sourceChainSelector: uint64(uint256(l.topics[2])),
                sender: sender,
                data: data,
                destTokenAmounts: new Client.EVMTokenAmount[](0)
            });
        }
        revert("no MessageFailed");
    }

    // ─────────────────────────────────────────────────────────────── ENTER

    /// CCIP outruns CCTP: the instruction lands before the dollars, is stored
    /// rather than lost, and anyone completes it once the USDC has minted.
    function test_enter_ccipBeforeCctp_isStored_thenRetried() public {
        MempireMessages.Enter memory e = _enter(carolKey, carol, 0, 0);
        vm.recordLogs();
        vm.prank(carol);
        remote.enter{value: 0}(e, 2e6, 0);
        Client.Any2EVMMessage memory failed = _lastFailed();
        bytes32 messageId = failed.messageId;

        // Both halves left Base in one transaction.
        assertEq(baseUsdc.balanceOf(carol), 18e6);
        (address from, uint256 amount,, bytes32 recipient,, , uint32 finality) = baseCctp.burns(0);
        assertEq(from, address(remote));
        assertEq(amount, 2e6);
        assertEq(recipient, bytes32(uint256(uint160(carol))), "minted to the player's own address on Arc");
        assertEq(finality, 1000, "CCTP Fast Transfer");
        assertEq(uint8(gateway.messageStatus(messageId)), uint8(MempireCCIPGateway.Status.FAILED));
        assertEq(failed.sourceChainSelector, selector);
        assertEq(arena.nextMatchId(), 1, "nothing opened yet");

        vm.expectRevert(); // still no USDC on Arc: the retry fails and the message stays stored
        gateway.retryFailedMessage(failed);
        assertEq(uint8(gateway.messageStatus(messageId)), uint8(MempireCCIPGateway.Status.FAILED));

        _deliver(0);
        // A doctored copy is refused.
        Client.Any2EVMMessage memory forged = Client.Any2EVMMessage({
            messageId: failed.messageId,
            sourceChainSelector: failed.sourceChainSelector,
            sender: failed.sender,
            data: abi.encode(MempireMessages.ENTER, dave, bytes("")),
            destTokenAmounts: failed.destTokenAmounts
        });
        vm.expectRevert(abi.encodeWithSelector(MempireCCIPGateway.WrongMessage.selector, messageId));
        gateway.retryFailedMessage(forged);
        vm.prank(makeAddr("anyone"));
        gateway.retryFailedMessage(failed);
        assertEq(uint8(gateway.messageStatus(messageId)), uint8(MempireCCIPGateway.Status.RESOLVED));
        MempireArena.Match memory m = arena.getMatch(1);
        assertEq(m.p0, carol, "seated as the player who sent it, not as the gateway");
        assertEq(m.state, arena.STATE_OPEN());
        assertEq(usdc.balanceOf(address(arena)), 1e6);
        assertEq(usdc.balanceOf(carol), 1e6);
        assertEq(usdc.balanceOf(address(gateway)), 0, "the gateway never holds funds");

        vm.expectRevert(abi.encodeWithSelector(MempireCCIPGateway.NotFailed.selector, messageId));
        gateway.retryFailedMessage(failed);
    }

    /// CCTP first, then a cross-chain join: the match goes Active in the CCIP delivery itself.
    function test_enter_join_fromBase_andSettle_thenCashOutHome() public {
        CircleUSDC.mint(carol, 5e6); // carol already on Arc
        vm.startPrank(carol);
        usdc.approve(address(arena), type(uint256).max);
        uint64 id = arena.createMatch(1, _deck(carol), address(0), 0, noPermit());
        vm.stopPrank();

        // Dave plays from Base: CCTP has already minted his $5 on Arc (Fast Transfer
        // takes seconds), then one source transaction carries the join.
        MempireMessages.Enter memory e = _enter(daveKey, dave, id, 1);
        vm.prank(dave);
        remote.enter{value: 0}(e, 5e6, 0); // bridges $5 more and joins
        assertEq(arena.getMatch(id).state, arena.STATE_OPEN(), "join waits for the dollars");
        _deliver(0);
        // Re-sending the same instruction once the dollars are there is harmless and lands at once.
        e = _enter(daveKey, dave, id, 1);
        vm.prank(dave);
        remote.enter{value: 0}(e, 0, 0);
        MempireArena.Match memory m = arena.getMatch(id);
        assertEq(m.p1, dave);
        assertEq(m.state, arena.STATE_ACTIVE());

        // Both seats record the result on Arc (dave with his own key: same address everywhere).
        vm.prank(carol);
        arena.claim(id, 1, bytes32(0));
        vm.prank(dave);
        arena.claim(id, 1, bytes32(0));
        assertEq(usdc.balanceOf(dave), 9e6, "won $9 of the $10 pot");

        // Cash out from Base: the gateway pulls by permit and burns via CCTP to dave on Base.
        (uint256 d, uint8 v, bytes32 r, bytes32 s) = _permit(daveKey, dave, address(gateway), 9e6);
        MempireMessages.CashOut memory c = MempireMessages.CashOut({
            amount: 9e6, maxFee: 0, minFinality: 2000, permitDeadline: d, v: v, r: r, s: s
        });
        vm.prank(dave);
        remote.cashOut{value: 0}(c);
        assertEq(usdc.balanceOf(dave), 0);
        assertEq(arcCctp.burnCount(), 1);
        (address from, uint256 amount, uint32 domain, bytes32 recipient, address token,, uint32 fin) = arcCctp.burns(0);
        assertEq(from, address(gateway));
        assertEq(amount, 9e6);
        assertEq(domain, BASE_DOMAIN, "back to the chain the instruction came from");
        assertEq(recipient, bytes32(uint256(uint160(dave))), "to the player, never a parameter");
        assertEq(token, address(usdc));
        assertEq(fin, 2000);
    }

    // ─────────────────────────────────────────────────────────────── defences

    function test_onlyAllowlistedSourceAndSender() public {
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: bytes32("x"),
            sourceChainSelector: selector,
            sender: abi.encode(makeAddr("impostor")),
            data: abi.encode(MempireMessages.ENTER, carol, bytes("")),
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
        vm.prank(gateway.getRouter());
        vm.expectRevert(
            abi.encodeWithSelector(MempireCCIPGateway.SourceNotAllowed.selector, selector, makeAddr("impostor"))
        );
        gateway.ccipReceive(m);

        m.sender = abi.encode(address(remote));
        m.sourceChainSelector = 1234;
        vm.prank(gateway.getRouter());
        vm.expectRevert(abi.encodeWithSelector(MempireCCIPGateway.SourceNotAllowed.selector, uint64(1234), address(remote)));
        gateway.ccipReceive(m);

        // Not the router at all.
        vm.expectRevert();
        gateway.ccipReceive(m);
        // The business logic is reachable only through the receiver.
        vm.expectRevert(MempireCCIPGateway.OnlySelf.selector);
        gateway.process(m);
    }

    function test_arenaSeatsOnlyThroughTheGateway() public {
        uint256[] memory deck = _deck(carol);
        vm.expectRevert(MempireArena.NotGateway.selector);
        arena.createMatchFor(carol, 0, deck, address(0), noPermit());
        vm.prank(address(gateway));
        vm.expectRevert(MempireArena.NotGateway.selector);
        arena.createMatchFor(address(0), 0, deck, address(0), noPermit());
    }

    /// The player is msg.sender on the source chain: Dave cannot spend Carol's
    /// stake by naming her deck — her permit doesn't verify for him, and her
    /// cards aren't his to lock.
    function test_cannotEnterForSomeoneElse() public {
        CircleUSDC.mint(carol, 5e6);
        MempireMessages.Enter memory e = _enter(carolKey, carol, 0, 0);
        vm.recordLogs();
        vm.prank(dave); // dave relays carol's signed order
        remote.enter{value: 0}(e, 0, 0);
        _lastFailed(); // stored as failed
        assertEq(usdc.balanceOf(carol), 5e6, "carol's USDC untouched");
        assertEq(arena.nextMatchId(), 1);
    }

    function test_cashOut_isCapped_andTooLargeIsStoredNotLost() public {
        CircleUSDC.mint(carol, 500e6);
        (uint256 d, uint8 v, bytes32 r, bytes32 s) = _permit(carolKey, carol, address(gateway), 200e6);
        MempireMessages.CashOut memory c =
            MempireMessages.CashOut({amount: 200e6, maxFee: 0, minFinality: 2000, permitDeadline: d, v: v, r: r, s: s});
        vm.recordLogs();
        vm.prank(carol);
        remote.cashOut{value: 0}(c);
        Client.Any2EVMMessage memory failed = _lastFailed();
        assertEq(usdc.balanceOf(carol), 500e6);
        // The owner can raise the cap; then the stored message completes on retry.
        vm.prank(admin);
        gateway.setMaxCashOut(250e6);
        gateway.retryFailedMessage(failed);
        assertEq(usdc.balanceOf(carol), 300e6);
    }

    /// CCIP fees in the source chain's native token, quoted, with any excess refunded.
    function test_fee_quoted_paidNatively_excessRefunded() public {
        CCIPLocalRouter(address(router)).setFee(0.01 ether);
        CircleUSDC.mint(carol, 5e6);
        MempireMessages.Enter memory e = _enter(carolKey, carol, 0, 0);
        assertEq(remote.quoteEnter(e), 0.01 ether);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(MempireRemoteEntry.FeeTooLow.selector, 0.001 ether, 0.01 ether));
        remote.enter{value: 0.001 ether}(e, 0, 0);
        uint256 before = carol.balance;
        vm.prank(carol);
        remote.enter{value: 0.05 ether}(e, 0, 0);
        assertEq(before - carol.balance, 0.01 ether);
        assertEq(arena.getMatch(1).p0, carol);
    }

    function test_remoteEntryOnlyAllowlistedBy_owner() public {
        vm.prank(carol);
        vm.expectRevert();
        gateway.setRemoteEntry(selector, carol, 6);
    }
}
