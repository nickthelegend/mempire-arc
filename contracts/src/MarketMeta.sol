// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {IReceiver} from "./interfaces/IReceiver.sol";
import {MempireCards} from "./MempireCards.sol";

/// @title The market is the meta.
/// @notice Each epoch, one bounded modifier per fighter is written here, from
/// one of two sources:
///
///  - **Chainlink Data Feeds** (`postFromFeeds`, Arc mainnet and any fork of
///    it): anyone may post, and the contract computes every fighter's 24-hour
///    move itself, from its feed's `latestRoundData` against the feed's own
///    round from 24 hours earlier. The poster only *points at* that earlier
///    round; the contract checks it is exactly the last round published at or
///    before `now − 24h`, so the poster can neither choose the numbers nor
///    shop for a convenient round.
///  - **Chainlink CRE** (`onReport`, Arc testnet only — CRE does not serve Arc
///    mainnet): a workflow reads the roster's 24-hour moves, reaches consensus
///    across the DON, and delivers one report through the KeystoneForwarder.
///
/// An asset that ran fights a little stronger; one that dumped a little weaker.
///
/// The swing is capped at ±15% of stats, never touches elixir cost, and is
/// smaller than what levels give — so the market reshuffles the meta without
/// becoming a way to buy wins. Arena matches snapshot the epoch at join, so
/// both clients simulate the same numbers for the whole match.
contract MarketMeta is IReceiver, Ownable2Step {
    /// ±15%, in basis points.
    int16 public constant MAX_BPS = 1500;

    /// The KeystoneForwarder allowed to deliver CRE reports (Arc testnet).
    /// address(0) on Arc mainnet: `onReport` then accepts nothing.
    address public forwarder;
    /// When set, reports must come from a workflow owned by this address.
    address public expectedWorkflowOwner;

    /// Epochs are ten-minute windows, the same scheme the CRE workflow uses, so
    /// the two sources can never write two different meta into one window.
    uint64 public constant EPOCH_SECONDS = 600;
    /// The move is measured over a day.
    uint256 public constant LOOKBACK = 1 days;
    /// bps = clamp(move × 0.4, ±MAX_BPS): a +20% day gives +8% hp and damage —
    /// the same mapping the CRE workflow uses (change% × 40 bps).
    int256 public constant GAIN_NUM = 2;
    int256 public constant GAIN_DEN = 5;
    uint8 public constant SOURCE_CRE = 0;
    uint8 public constant SOURCE_FEEDS = 1;

    MempireCards public cards;
    mapping(uint64 epoch => uint8) public epochSource;

    uint64 public currentEpoch;
    mapping(uint64 epoch => uint64) public epochTimestamp;
    mapping(uint64 epoch => mapping(uint16 coinId => int16)) public modifierBps;

    event ForwarderChanged(address forwarder);
    event WorkflowOwnerChanged(address owner);
    event CardsChanged(address cards);
    event MetaPosted(uint64 indexed epoch, uint16[] coinIds, int16[] bps);
    event MetaSource(uint64 indexed epoch, uint8 source, address poster);

    error NotForwarder();
    error WrongWorkflowOwner();
    error StaleEpoch();
    error LengthMismatch();
    error OutOfBounds();
    error CardsNotSet();
    error BadPrice();
    error StalePrice();
    error BadRoundHint(uint16 coinId);

    constructor(address owner_, address forwarder_) Ownable(owner_) {
        forwarder = forwarder_;
        emit ForwarderChanged(forwarder_);
    }

    function setForwarder(address forwarder_) external onlyOwner {
        forwarder = forwarder_;
        emit ForwarderChanged(forwarder_);
    }

    function setCards(MempireCards cards_) external onlyOwner {
        cards = cards_;
        emit CardsChanged(address(cards_));
    }

    function setExpectedWorkflowOwner(address owner_) external onlyOwner {
        expectedWorkflowOwner = owner_;
        emit WorkflowOwnerChanged(owner_);
    }

    /// @inheritdoc IReceiver
    /// @dev report = abi.encode(uint64 epoch, uint16[] coinIds, int16[] bps).
    /// Stale or replayed epochs are rejected rather than ignored, so a
    /// forwarder retry of an old report is visible.
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder || forwarder == address(0)) revert NotForwarder();
        if (expectedWorkflowOwner != address(0)) {
            if (_workflowOwner(metadata) != expectedWorkflowOwner) revert WrongWorkflowOwner();
        }
        (uint64 epoch, uint16[] memory coinIds, int16[] memory bps) =
            abi.decode(report, (uint64, uint16[], int16[]));
        if (epoch <= currentEpoch) revert StaleEpoch();
        if (coinIds.length != bps.length) revert LengthMismatch();
        for (uint256 i; i < coinIds.length; ++i) {
            if (bps[i] > MAX_BPS || bps[i] < -MAX_BPS) revert OutOfBounds();
            modifierBps[epoch][coinIds[i]] = bps[i];
        }
        currentEpoch = epoch;
        epochTimestamp[epoch] = uint64(block.timestamp);
        epochSource[epoch] = SOURCE_CRE;
        emit MetaPosted(epoch, coinIds, bps);
        emit MetaSource(epoch, SOURCE_CRE, msg.sender);
    }

    /// Derive this window's meta from Chainlink Data Feeds, on chain.
    ///
    /// Permissionless and free beyond gas. For each fighter the caller names a
    /// `dayAgoRound`: the feed round that was current 24 hours ago. The
    /// contract reads the latest round and that round, and accepts the hint only
    /// if it is exactly right — published at or before `now − 24h`, with the
    /// next round published after it (or no next round in its phase) — so the
    /// modifier is fixed by the feed's own history, not by whoever posts.
    function postFromFeeds(uint16[] calldata coinIds, uint80[] calldata dayAgoRounds)
        external
        returns (uint64 epoch, int16[] memory bps)
    {
        if (address(cards) == address(0)) revert CardsNotSet();
        if (coinIds.length != dayAgoRounds.length) revert LengthMismatch();
        epoch = uint64(block.timestamp / EPOCH_SECONDS);
        if (epoch <= currentEpoch) revert StaleEpoch();
        currentEpoch = epoch;
        epochTimestamp[epoch] = uint64(block.timestamp);
        epochSource[epoch] = SOURCE_FEEDS;

        bps = new int16[](coinIds.length);
        for (uint256 i; i < coinIds.length; ++i) {
            bps[i] = feedMomentumBps(coinIds[i], dayAgoRounds[i]);
            modifierBps[epoch][coinIds[i]] = bps[i];
        }
        emit MetaPosted(epoch, coinIds, bps);
        emit MetaSource(epoch, SOURCE_FEEDS, msg.sender);
    }

    /// One fighter's modifier from its feed: the latest answer against the
    /// verified day-ago answer. Reverts on a stale or non-positive feed or a
    /// wrong hint.
    function feedMomentumBps(uint16 coinId, uint80 dayAgoRound) public view returns (int16) {
        MempireCards.Coin memory c = cards.coin(coinId);
        AggregatorV3Interface feed = AggregatorV3Interface(c.feed);
        (uint80 latestRound, int256 now_,, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        if (now_ <= 0 || updatedAt == 0 || answeredInRound < latestRound || updatedAt > block.timestamp) {
            revert BadPrice();
        }
        if (block.timestamp - updatedAt > c.maxPriceAge) revert StalePrice();

        uint256 cutoff = block.timestamp - LOOKBACK;
        (, int256 then_,, uint256 thenAt,) = feed.getRoundData(dayAgoRound);
        if (then_ <= 0 || thenAt == 0 || thenAt > cutoff || dayAgoRound > latestRound) revert BadRoundHint(coinId);
        if (dayAgoRound != latestRound) {
            // The round after the hint must postdate the cutoff, or the hint is
            // not the round that was current 24 hours ago.
            try feed.getRoundData(dayAgoRound + 1) returns (uint80, int256, uint256, uint256 nextAt, uint80) {
                if (nextAt != 0 && nextAt <= cutoff) revert BadRoundHint(coinId);
                if (nextAt == 0 && (dayAgoRound >> 64) == (latestRound >> 64)) revert BadRoundHint(coinId);
            } catch {
                // No next round in this phase: valid only if the feed has since
                // moved to a newer phase (the hint closed its phase).
                if ((dayAgoRound >> 64) == (latestRound >> 64)) revert BadRoundHint(coinId);
            }
        }
        return momentumBps(now_, then_);
    }

    /// The move from `then_` to `now_`, in basis points, times the gain, clamped.
    function momentumBps(int256 now_, int256 then_) public pure returns (int16) {
        if (now_ <= 0 || then_ <= 0) revert BadPrice();
        int256 diff = ((now_ - then_) * 10_000 * GAIN_NUM) / (then_ * GAIN_DEN);
        if (diff > MAX_BPS) return MAX_BPS;
        if (diff < -MAX_BPS) return -MAX_BPS;
        return int16(diff);
    }

    /// The modifiers a match will use, in the order asked.
    function modifiersFor(uint64 epoch, uint16[] calldata coinIds) external view returns (int16[] memory out) {
        out = new int16[](coinIds.length);
        for (uint256 i; i < coinIds.length; ++i) {
            out[i] = modifierBps[epoch][coinIds[i]];
        }
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// CRE metadata is abi.encodePacked(bytes32 workflowId, bytes10 workflowName,
    /// address workflowOwner): the owner sits at bytes [42, 62).
    function _workflowOwner(bytes calldata metadata) internal pure returns (address owner) {
        if (metadata.length < 62) return address(0);
        owner = address(bytes20(metadata[42:62]));
    }
}
