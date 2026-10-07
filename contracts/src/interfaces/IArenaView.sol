// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice What the card contract needs to know about a match: whether it is
/// still holding the cards it was opened with.
interface IArenaView {
    /// True while the match is Open or Active, the two states in which its
    /// decks must not move, merge or burn.
    function holdsCards(uint64 matchId) external view returns (bool);
}
