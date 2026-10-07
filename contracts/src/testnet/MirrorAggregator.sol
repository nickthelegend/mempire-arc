// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title MirrorAggregator — ARC TESTNET ONLY.
/// @notice Chainlink publishes its Data Feeds on Arc mainnet, not on Arc testnet.
/// So that the testnet deployment runs the exact same contract code paths as
/// mainnet (`latestRoundData`, `getRoundData`, staleness and positivity checks,
/// the 24-hour round hint), each testnet fighter points at one of these: a
/// copy of the corresponding Arc **mainnet** Chainlink feed, round for round —
/// same round ids, answers and timestamps — pushed by the relay's mirror job
/// (`server/mirror.js`), which reads them from the mainnet proxy.
///
/// Trust model: on testnet the mirror's updater is trusted to copy faithfully
/// (anyone can compare against the mainnet proxy). This contract is never
/// deployed to Arc mainnet; there the game reads Chainlink's own proxies.
contract MirrorAggregator is AggregatorV3Interface {
    struct Round {
        int256 answer;
        uint64 startedAt;
        uint64 updatedAt;
    }

    address public immutable updater;
    /// The Arc mainnet proxy this mirrors, for anyone checking the copy.
    address public immutable source;
    uint8 public immutable override decimals;
    string public override description;
    uint256 public constant override version = 4;

    uint80 public latestRound;
    mapping(uint80 roundId => Round) internal _rounds;

    event Mirrored(uint80 indexed roundId, int256 answer, uint256 updatedAt);

    error NotUpdater();
    error NotNewer();
    error NoData();

    constructor(address updater_, address source_, uint8 decimals_, string memory description_) {
        updater = updater_;
        source = source_;
        decimals = decimals_;
        description = description_;
    }

    /// Copy rounds from the mainnet feed, oldest first. Round ids only move forward.
    function push(uint80[] calldata roundIds, int256[] calldata answers, uint64[] calldata startedAts, uint64[] calldata updatedAts)
        external
    {
        if (msg.sender != updater) revert NotUpdater();
        for (uint256 i; i < roundIds.length; ++i) {
            if (roundIds[i] <= latestRound) revert NotNewer();
            _rounds[roundIds[i]] = Round(answers[i], startedAts[i], updatedAts[i]);
            latestRound = roundIds[i];
            emit Mirrored(roundIds[i], answers[i], updatedAts[i]);
        }
    }

    function getRoundData(uint80 roundId) public view override returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = _rounds[roundId];
        if (r.updatedAt == 0) revert NoData();
        return (roundId, r.answer, r.startedAt, r.updatedAt, roundId);
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latestRound);
    }
}
