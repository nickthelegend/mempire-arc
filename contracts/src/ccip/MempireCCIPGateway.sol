// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MempireArena} from "../MempireArena.sol";
import {ITokenMessengerV2} from "../interfaces/ITokenMessengerV2.sol";
import {MempireMessages} from "./MempireMessages.sol";

/// @title MempireCCIPGateway — play Mempire on Arc from Base or Ethereum.
/// @notice "CCTP moves the dollars, CCIP carries the instruction."
///
/// USDC is not a CCIP token on Arc; it moves by Circle CCTP V2. A player on
/// Base or Ethereum (same passkey EOA, same address on every EVM chain) burns
/// USDC there with CCTP to their own address on Arc, and sends a CCIP message
/// from `MempireRemoteEntry` to this gateway saying what to do with it:
///
///  - **ENTER**: open or join a match for the player, staking from the
///    player's own USDC on Arc by the EIP-2612 permit they signed (Arc's USDC
///    domain) and locking the player's own cards. The arena only lets this
///    gateway seat a player who asked — `player` is the sender on the source
///    chain — and the permit is a second, independent authorisation.
///  - **CASH_OUT**: send the player's USDC (winnings) home: pulled here by
///    the player's permit and burned with CCTP V2 to the player's own address
///    on the source chain's domain. The recipient is never a parameter.
///
/// Defensive receiver: only allowlisted (source chain selector, sender) pairs
/// are accepted, and business logic runs in `this.process` under try/catch. A
/// message whose action fails — typically ENTER arriving before its CCTP
/// transfer has minted, or an expired permit — is stored, not lost, and
/// anyone may retry it later (`retryFailedMessage`): its effect is fixed by
/// its content, so who retries it changes nothing. Only the message's hash is
/// stored (one slot, so even a failing ENTER stays inside its CCIP gas budget);
/// the full message is in the `MessageFailed` event, and a retry must present
/// it back exactly. The gateway never holds funds between transactions.
contract MempireCCIPGateway is CCIPReceiver, Ownable2Step {
    using SafeERC20 for IERC20;

    MempireArena public immutable arena;
    IERC20 public immutable usdc;
    ITokenMessengerV2 public immutable tokenMessenger;

    /// Allowlisted source: chain selector → the MempireRemoteEntry contract there.
    mapping(uint64 selector => address sender) public remoteEntry;
    /// The CCTP domain of each allowlisted source chain (Ethereum 0, Base 6).
    mapping(uint64 selector => uint32 domain) public cctpDomain;
    /// Most a CASH_OUT may move in one message (USDC, 6 decimals). Bounds the
    /// blast radius of anything unexpected on a deployment holding real money.
    uint256 public maxCashOut;

    enum Status {
        NONE,
        FAILED,
        RESOLVED
    }

    mapping(bytes32 messageId => Status) public messageStatus;
    /// keccak256(abi.encode(message)) of each failed message, checked on retry.
    mapping(bytes32 messageId => bytes32) public failedHash;

    event RemoteEntrySet(uint64 indexed selector, address sender, uint32 cctpDomain);
    event MaxCashOutSet(uint256 amount);
    event Entered(bytes32 indexed messageId, address indexed player, uint64 matchId, bool created);
    event CashedOut(bytes32 indexed messageId, address indexed player, uint256 amount, uint32 domain);
    event MessageFailed(
        bytes32 indexed messageId, uint64 indexed sourceChainSelector, bytes sender, bytes data, bytes reason
    );
    event MessageRecovered(bytes32 indexed messageId);

    error SourceNotAllowed(uint64 selector, address sender);
    error OnlySelf();
    error NotFailed(bytes32 messageId);
    error WrongMessage(bytes32 messageId);
    error BadAction(uint8 action);
    error CashOutTooLarge(uint256 amount);

    constructor(
        address owner_,
        address router_,
        MempireArena arena_,
        IERC20 usdc_,
        ITokenMessengerV2 tokenMessenger_,
        uint256 maxCashOut_
    ) CCIPReceiver(router_) Ownable(owner_) {
        arena = arena_;
        usdc = usdc_;
        tokenMessenger = tokenMessenger_;
        maxCashOut = maxCashOut_;
    }

    // ─────────────────────────────────────────────────────────────── admin

    /// Allow (or, with sender 0, disallow) one MempireRemoteEntry per source chain.
    function setRemoteEntry(uint64 selector, address sender, uint32 domain) external onlyOwner {
        remoteEntry[selector] = sender;
        cctpDomain[selector] = domain;
        emit RemoteEntrySet(selector, sender, domain);
    }

    function setMaxCashOut(uint256 amount) external onlyOwner {
        maxCashOut = amount;
        emit MaxCashOutSet(amount);
    }

    // ─────────────────────────────────────────────────────────────── receive

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        address sender = abi.decode(message.sender, (address));
        address allowed = remoteEntry[message.sourceChainSelector];
        if (allowed == address(0) || sender != allowed) revert SourceNotAllowed(message.sourceChainSelector, sender);

        try this.process(message) {}
        catch (bytes memory reason) {
            messageStatus[message.messageId] = Status.FAILED;
            failedHash[message.messageId] = keccak256(abi.encode(message));
            emit MessageFailed(message.messageId, message.sourceChainSelector, message.sender, message.data, reason);
        }
    }

    /// The business logic. External only so a revert is catchable; callable only by this contract.
    function process(Client.Any2EVMMessage calldata message) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _process(message.messageId, message.sourceChainSelector, message.data);
    }

    /// Re-run a failed message (e.g. once its CCTP transfer has minted), presented
    /// exactly as `MessageFailed` logged it. Permissionless: the outcome is fixed
    /// by the message, not the caller. Reverts — leaving it failed — if it still fails.
    function retryFailedMessage(Client.Any2EVMMessage calldata message) external {
        bytes32 id = message.messageId;
        if (messageStatus[id] != Status.FAILED) revert NotFailed(id);
        if (keccak256(abi.encode(message)) != failedHash[id]) revert WrongMessage(id);
        messageStatus[id] = Status.RESOLVED;
        delete failedHash[id];
        _process(id, message.sourceChainSelector, message.data);
        emit MessageRecovered(id);
    }

    function _process(bytes32 messageId, uint64 sourceSelector, bytes memory data) internal {
        (uint8 action, address player, bytes memory body) = abi.decode(data, (uint8, address, bytes));
        if (action == MempireMessages.ENTER) {
            MempireMessages.Enter memory e = abi.decode(body, (MempireMessages.Enter));
            MempireArena.Permit memory p = MempireArena.Permit(e.permitDeadline, e.v, e.r, e.s);
            if (e.matchId == 0) {
                uint64 id = arena.createMatchFor(player, e.tier, e.cardIds, e.session, p);
                emit Entered(messageId, player, id, true);
            } else {
                arena.joinMatchFor(player, e.matchId, e.cardIds, e.session, p);
                emit Entered(messageId, player, e.matchId, false);
            }
        } else if (action == MempireMessages.CASH_OUT) {
            MempireMessages.CashOut memory c = abi.decode(body, (MempireMessages.CashOut));
            if (c.amount == 0 || c.amount > maxCashOut) revert CashOutTooLarge(c.amount);
            if (c.permitDeadline != 0) {
                try IERC20Permit(address(usdc)).permit(player, address(this), c.amount, c.permitDeadline, c.v, c.r, c.s) {}
                    catch {}
            }
            usdc.safeTransferFrom(player, address(this), c.amount);
            usdc.forceApprove(address(tokenMessenger), c.amount);
            uint32 domain = cctpDomain[sourceSelector];
            tokenMessenger.depositForBurn(
                c.amount, domain, bytes32(uint256(uint160(player))), address(usdc), bytes32(0), c.maxFee, c.minFinality
            );
            emit CashedOut(messageId, player, c.amount, domain);
        } else {
            revert BadAction(action);
        }
    }

    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
