// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IPyth} from "./interfaces/IPyth.sol";

/// @title SignedPriceOracle — server-attested prices, verified on chain.
/// @notice Pyth's pull model, for a chain Pyth does not serve: an update is a
/// price the oracle's signer attested to, and the contract stores it only if
/// the signature checks out. Anyone may *post* an update — the player does,
/// inside their own mint transaction, exactly as with Pyth — but nobody
/// without the signer key can *invent* one.
///
/// Pyth is deployed on Arc testnet but not on Arc mainnet, and Chainlink CRE
/// serves Arc testnet only, so on Arc mainnet this is the game's price source.
/// The relay signs only live market quotes it just read (OKX, then CoinGecko),
/// with the quote's own timestamp as the publish time; it never signs a number
/// it did not read from a market.
///
/// Trust model, stated plainly: the signer is trusted for *what* a price is.
/// A compromised signer could stamp a wrong price on a newly minted card or
/// tilt one ten-minute epoch of the market meta by at most ±15% of a fighter's
/// stats. It can never move a stake, a pot, a card or a token: prices feed no
/// payout anywhere in the game.
///
/// Update encoding: `abi.encode(bytes32 id, int64 price, int32 expo,
/// int64 emaPrice, uint64 publishTime, bytes signature)`, signed (EIP-191) over
/// `keccak256(abi.encode(address(this), block.chainid, id, price, expo,
/// emaPrice, publishTime))` — bound to this contract and chain, so an
/// attestation can't be replayed on testnet ↔ mainnet. An update older than the
/// stored one is ignored, like Pyth's. Updates are free: no native USDC is ever
/// taken, so none can get stuck here.
contract SignedPriceOracle is IPyth {
    address public immutable signer;
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

    function getUpdateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        if (msg.value != 0) revert InsufficientFee(); // free: refuse value rather than trap it
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
