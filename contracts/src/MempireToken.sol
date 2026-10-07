// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title $MEMPIRE — the game's one currency.
/// @notice A fixed-supply ERC-20. Every use of it in the game is a sink (merge
/// fees, chest skips, chest purchases, the shop), and the only emission is the
/// capped win reward the arena pays out of a pre-funded pool. There is no
/// `mint` after construction, so nothing in the game can print it.
contract MempireToken is ERC20, ERC20Permit {
    uint256 public constant SUPPLY = 1_000_000_000 ether;

    constructor(address recipient) ERC20("Mempire", "MEMPIRE") ERC20Permit("Mempire") {
        _mint(recipient, SUPPLY);
    }
}
