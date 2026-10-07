// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IReceiver} from "./interfaces/IReceiver.sol";
import {IPyth} from "./interfaces/IPyth.sol";
import {MempireCards} from "./MempireCards.sol";

/// @title The market is the meta.
/// @notice Each epoch, one bounded modifier per fighter is written here, from
/// one of two sources:
///
///  - **Chainlink CRE** (`onReport`): a workflow reads the roster's 24-hour
///    price moves from independent sources, reaches consensus across the DON,
///    and delivers one report through the KeystoneForwarder.
///  - **Pyth** (`postFromPyth`): anyone posts a fresh Pyth update in the same
///    transaction, and the contract derives each fighter's modifier from its
///    momentum — the spot price against Pyth's own moving average. No trusted
///    poster: the numbers come out of the price feed, inside the call.
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

    /// The KeystoneForwarder allowed to deliver reports. On testnet this is the
    /// simulation forwarder while `cre workflow simulate --broadcast` drives it.
    address public forwarder;
    /// When set, reports must come from a workflow owned by this address.
    address public expectedWorkflowOwner;

    /// Epochs are ten-minute windows, the same scheme the CRE workflow uses, so
    /// the two sources can never write two different meta into one window.
    uint64 public constant EPOCH_SECONDS = 600;
    /// Momentum gain: a fighter 5% above its moving average gets +10% (1000
    /// bps), capped at MAX_BPS like every other source.
    int256 public constant MOMENTUM_GAIN = 2;
    uint8 public constant SOURCE_CRE = 0;
    uint8 public constant SOURCE_PYTH = 1;

    IPyth public pyth;
    MempireCards public cards;
    mapping(uint64 epoch => uint8) public epochSource;

    uint64 public currentEpoch;
    mapping(uint64 epoch => uint64) public epochTimestamp;
    mapping(uint64 epoch => mapping(uint16 coinId => int16)) public modifierBps;

    event ForwarderChanged(address forwarder);
    event WorkflowOwnerChanged(address owner);
    event MetaPosted(uint64 indexed epoch, uint16[] coinIds, int16[] bps);
    event MetaSource(uint64 indexed epoch, uint8 source, address poster);
    event PythChanged(address pyth, address cards);

    error NotForwarder();
    error WrongWorkflowOwner();
    error StaleEpoch();
    error LengthMismatch();
    error OutOfBounds();
    error PythNotSet();
    error WrongPayment();
    error BadMomentum();
    error RefundFailed();

    constructor(address owner_, address forwarder_) Ownable(owner_) {
        forwarder = forwarder_;
        emit ForwarderChanged(forwarder_);
    }

    function setForwarder(address forwarder_) external onlyOwner {
        forwarder = forwarder_;
        emit ForwarderChanged(forwarder_);
    }

    function setPyth(IPyth pyth_, MempireCards cards_) external onlyOwner {
        pyth = pyth_;
        cards = cards_;
        emit PythChanged(address(pyth_), address(cards_));
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
        if (msg.sender != forwarder) revert NotForwarder();
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

    /// Post fresh Pyth prices and derive this window's meta from them.
    ///
    /// Permissionless: the caller only pays Pyth's update fee (excess refunded)
    /// and chooses which fighters to include. Each fighter's modifier is
    /// `clamp((spot − ema) / ema × GAIN, ±MAX_BPS)`, read back from Pyth in the
    /// same transaction under each fighter's own freshness bound — so a stale or
    /// missing price reverts rather than becoming a stat.
    function postFromPyth(uint16[] calldata coinIds, bytes[] calldata priceUpdate)
        external
        payable
        returns (uint64 epoch, int16[] memory bps)
    {
        if (address(pyth) == address(0) || address(cards) == address(0)) revert PythNotSet();
        epoch = uint64(block.timestamp / EPOCH_SECONDS);
        if (epoch <= currentEpoch) revert StaleEpoch();
        // Effects before any external call: the epoch is claimed first, so a
        // re-entrant post for the same window fails `StaleEpoch`.
        currentEpoch = epoch;
        epochTimestamp[epoch] = uint64(block.timestamp);
        epochSource[epoch] = SOURCE_PYTH;
        uint256 fee = pyth.getUpdateFee(priceUpdate);
        if (msg.value < fee) revert WrongPayment();
        pyth.updatePriceFeeds{value: fee}(priceUpdate);

        bps = new int16[](coinIds.length);
        for (uint256 i; i < coinIds.length; ++i) {
            MempireCards.Coin memory c = cards.coin(coinIds[i]);
            IPyth.Price memory p = pyth.getPriceNoOlderThan(c.feedId, c.maxPriceAge);
            IPyth.Price memory e = pyth.getEmaPriceNoOlderThan(c.feedId, c.maxPriceAge);
            bps[i] = momentumBps(p.price, e.price);
            modifierBps[epoch][coinIds[i]] = bps[i];
        }
        emit MetaPosted(epoch, coinIds, bps);
        emit MetaSource(epoch, SOURCE_PYTH, msg.sender);

        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// Spot against its moving average, in basis points, times the gain,
    /// clamped. Both prices share Pyth's expo, so the ratio needs no scaling.
    function momentumBps(int64 spot, int64 ema) public pure returns (int16) {
        if (spot <= 0 || ema <= 0) revert BadMomentum();
        int256 diff = ((int256(spot) - int256(ema)) * 10_000 * MOMENTUM_GAIN) / int256(ema);
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
