// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITokenMessengerV2} from "../interfaces/ITokenMessengerV2.sol";
import {MempireMessages} from "./MempireMessages.sol";

/// @title MempireRemoteEntry — the Base / Ethereum side of cross-chain play.
/// @notice One transaction on the source chain does both halves:
///
///  1. **CCTP V2** burns the player's USDC here and mints it to the *same
///     address* on Arc (domain 26) — Fast Transfer by default, seconds.
///  2. **CCIP** carries the instruction to MempireCCIPGateway on Arc: enter a
///     match (with the stake permit and deck), or cash winnings out.
///
/// `player` is always `msg.sender`: nobody can enter or cash out for someone
/// else, and a cash-out always lands back at the player's own address. The
/// CCIP fee is paid in this chain's native token (`feeToken = address(0)`);
/// any excess is refunded. No owner, no admin, nothing held between calls.
contract MempireRemoteEntry {
    using SafeERC20 for IERC20;

    /// Arc's CCTP domain.
    uint32 public constant ARC_DOMAIN = 26;
    /// Gas for the gateway's work on Arc: create/join locks eight cards and
    /// moves a stake (~450k measured in tests); cash-out ~200k. Unused gas is
    /// not refunded by CCIP, so this is a measured bound, not a guess.
    uint256 public constant ENTER_GAS = 700_000;
    uint256 public constant CASH_OUT_GAS = 300_000;

    IRouterClient public immutable router;
    uint64 public immutable arcSelector;
    address public immutable arcGateway;
    IERC20 public immutable usdc;
    ITokenMessengerV2 public immutable tokenMessenger;

    event EnterSent(bytes32 indexed messageId, address indexed player, uint256 bridged, uint64 matchId, uint8 tier);
    event CashOutSent(bytes32 indexed messageId, address indexed player, uint256 amount);

    error FeeTooLow(uint256 sent, uint256 fee);
    error RefundFailed();

    constructor(IRouterClient router_, uint64 arcSelector_, address arcGateway_, IERC20 usdc_, ITokenMessengerV2 messenger_) {
        router = router_;
        arcSelector = arcSelector_;
        arcGateway = arcGateway_;
        usdc = usdc_;
        tokenMessenger = messenger_;
    }

    /// Bridge `bridgeAmount` USDC to yourself on Arc (0 to skip, if you already
    /// hold USDC there) and enter a match. msg.value pays the CCIP fee.
    function enter(MempireMessages.Enter calldata order, uint256 bridgeAmount, uint256 cctpMaxFee)
        external
        payable
        returns (bytes32 messageId)
    {
        if (bridgeAmount != 0) _bridgeToArc(bridgeAmount, cctpMaxFee);
        Client.EVM2AnyMessage memory m = _message(MempireMessages.ENTER, abi.encode(order), ENTER_GAS);
        messageId = _send(m);
        emit EnterSent(messageId, msg.sender, bridgeAmount, order.matchId, order.tier);
    }

    /// Ask the gateway to send `c.amount` of your Arc USDC back here, by CCTP.
    function cashOut(MempireMessages.CashOut calldata c) external payable returns (bytes32 messageId) {
        Client.EVM2AnyMessage memory m = _message(MempireMessages.CASH_OUT, abi.encode(c), CASH_OUT_GAS);
        messageId = _send(m);
        emit CashOutSent(messageId, msg.sender, c.amount);
    }

    /// The CCIP fee for an enter / cash-out, in this chain's native token.
    function quoteEnter(MempireMessages.Enter calldata order) external view returns (uint256) {
        return router.getFee(arcSelector, _message(MempireMessages.ENTER, abi.encode(order), ENTER_GAS));
    }

    function quoteCashOut(MempireMessages.CashOut calldata c) external view returns (uint256) {
        return router.getFee(arcSelector, _message(MempireMessages.CASH_OUT, abi.encode(c), CASH_OUT_GAS));
    }

    function _bridgeToArc(uint256 amount, uint256 maxFee) internal {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        usdc.forceApprove(address(tokenMessenger), amount);
        // Fast Transfer (1000): minted on Arc in seconds, for up to maxFee.
        tokenMessenger.depositForBurn(
            amount, ARC_DOMAIN, bytes32(uint256(uint160(msg.sender))), address(usdc), bytes32(0), maxFee, 1000
        );
    }

    function _message(uint8 action, bytes memory body, uint256 gasLimit)
        internal
        view
        returns (Client.EVM2AnyMessage memory)
    {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(arcGateway),
            data: abi.encode(action, msg.sender, body),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            extraArgs: Client._argsToBytes(Client.GenericExtraArgsV2({gasLimit: gasLimit, allowOutOfOrderExecution: true})),
            feeToken: address(0)
        });
    }

    function _send(Client.EVM2AnyMessage memory m) internal returns (bytes32 messageId) {
        uint256 fee = router.getFee(arcSelector, m);
        if (msg.value < fee) revert FeeTooLow(msg.value, fee);
        messageId = router.ccipSend{value: fee}(arcSelector, m);
        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }
}
