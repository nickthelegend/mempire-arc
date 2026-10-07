// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IPyth} from "./interfaces/IPyth.sol";

/// @title LocalPriceOracle — the price oracle for a LOCAL chain.
/// @notice Pyth's update model, on a chain Pyth does not serve: an update is a
/// price the oracle's signer attested to, and the contract stores it only if
/// the signature checks out. Anyone may *post* an update — the player does,
/// inside their own mint transaction, exactly as with Pyth — but nobody can
/// *invent* one.
///
/// On Monad the game points at the real Pyth contract and Hermes-signed
/// updates. Locally the relay signs live market quotes (it never signs a
/// number it did not read from a market), and this contract verifies them.
///
/// Update encoding: `abi.encode(bytes32 id, int64 price, int32 expo,
/// int64 emaPrice, uint64 publishTime, bytes signature)`, signed (EIP-191) over
/// `keccak256(abi.encode(address(this), block.chainid, id, price, expo,
/// emaPrice, publishTime))`. An update older than the stored one is ignored,
/// like Pyth's.
contract LocalPriceOracle is IPyth {
    address public immutable signer;
    uint256 public constant FEE_PER_UPDATE = 1;
    /// A signed price may not claim to be from the future.
    uint256 public constant MAX_CLOCK_SKEW = 60;

    mapping(bytes32 => Price) internal _price;
    mapping(bytes32 => Price) internal _ema;

    event PriceUpdated(bytes32 indexed id, int64 price, int32 expo, int64 emaPrice, uint64 publishTime);

    error BadSignature();
    error FromTheFuture();
    error InsufficientFee();
    error PriceFeedNotFound();
    error StalePrice();

    constructor(address signer_) {
        signer = signer_;
    }

    function digest(bytes32 id, int64 price, int32 expo, int64 ema, uint64 publishTime) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, id, price, expo, ema, publishTime));
    }

    function getUpdateFee(bytes[] calldata updateData) external pure returns (uint256) {
        return updateData.length * FEE_PER_UPDATE;
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        if (msg.value < updateData.length * FEE_PER_UPDATE) revert InsufficientFee();
        for (uint256 i; i < updateData.length; ++i) {
            (bytes32 id, int64 price, int32 expo, int64 ema, uint64 publishTime, bytes memory sig) =
                abi.decode(updateData[i], (bytes32, int64, int32, int64, uint64, bytes));
            bytes32 h = MessageHashUtils.toEthSignedMessageHash(digest(id, price, expo, ema, publishTime));
            if (ECDSA.recover(h, sig) != signer) revert BadSignature();
            if (publishTime > block.timestamp + MAX_CLOCK_SKEW) revert FromTheFuture();
            if (publishTime <= _price[id].publishTime) continue; // older than what we hold
            _price[id] = Price({price: price, conf: 0, expo: expo, publishTime: publishTime});
            _ema[id] = Price({price: ema, conf: 0, expo: expo, publishTime: publishTime});
            emit PriceUpdated(id, price, expo, ema, publishTime);
        }
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory p) {
        p = _fresh(_price[id], age);
    }

    function getEmaPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory p) {
        p = _fresh(_ema[id], age);
    }

    function _fresh(Price memory p, uint256 age) internal view returns (Price memory) {
        if (p.publishTime == 0) revert PriceFeedNotFound();
        if (block.timestamp > p.publishTime + age) revert StalePrice();
        return p;
    }
}
