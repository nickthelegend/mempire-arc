// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MockAUSD — TEST DOUBLE — forge tests only.
/// @notice Stands in for Agora's AUSD: 6 decimals and ERC-2612 permit, which
/// are the two properties the arena relies on. Minting is open because it is a
/// mock; on Monad the arena points at the real AUSD.
contract MockAUSD is ERC20, ERC20Permit {
    constructor() ERC20("AUSD", "AUSD") ERC20Permit("AUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title MockAUSDFaucet — TEST DOUBLE — forge tests only.
/// @notice The same entry point as Agora's testnet faucet,
/// `requestFunds(address)`, paying 10,000 AUSD per call — so the relay's
/// onboarding runs the identical code path locally and on testnet.
contract MockAUSDFaucet {
    MockAUSD public immutable ausd;
    uint256 public constant AMOUNT = 10_000e6;

    event FundsRequested(address indexed to, uint256 amount);

    constructor(MockAUSD ausd_) {
        ausd = ausd_;
    }

    function requestFunds(address to) external {
        ausd.mint(to, AMOUNT);
        emit FundsRequested(to, AMOUNT);
    }
}
