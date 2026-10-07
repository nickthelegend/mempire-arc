// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The CCIP payloads MempireRemoteEntry sends and MempireCCIPGateway reads.
/// Message data = abi.encode(uint8 action, address player, bytes body).
library MempireMessages {
    uint8 internal constant ENTER = 1;
    uint8 internal constant CASH_OUT = 2;

    /// Open (matchId 0) or join a match on Arc. The permit is the player's
    /// EIP-2612 signature over Arc's USDC (domain "USDC"/"2", chain 5042) for
    /// the arena to pull the stake.
    struct Enter {
        uint64 matchId;
        uint8 tier;
        uint256[] cardIds;
        address session;
        uint256 permitDeadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// Send `amount` of the player's Arc USDC back to the player on the source
    /// chain with CCTP V2. The permit authorises the gateway to pull it.
    struct CashOut {
        uint256 amount;
        uint256 maxFee;
        uint32 minFinality;
        uint256 permitDeadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }
}
