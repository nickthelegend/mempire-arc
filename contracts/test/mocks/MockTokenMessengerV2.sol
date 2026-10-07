// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITokenMessengerV2} from "../../src/interfaces/ITokenMessengerV2.sol";

/// @notice TEST DOUBLE for Circle's CCTP V2 TokenMessenger: takes the tokens
/// (as the real one burns them) and records the burn, so a test can assert
/// exactly what would be minted where, and "deliver" it when it chooses —
/// which is how the tests exercise CCTP and CCIP arriving in either order.
contract MockTokenMessengerV2 is ITokenMessengerV2 {
    struct Burn {
        address from;
        uint256 amount;
        uint32 domain;
        bytes32 mintRecipient;
        address token;
        uint256 maxFee;
        uint32 minFinality;
    }

    Burn[] public burns;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        IERC20(burnToken).transferFrom(msg.sender, address(this), amount);
        burns.push(Burn(msg.sender, amount, destinationDomain, mintRecipient, burnToken, maxFee, minFinalityThreshold));
    }

    function burnCount() external view returns (uint256) {
        return burns.length;
    }
}
