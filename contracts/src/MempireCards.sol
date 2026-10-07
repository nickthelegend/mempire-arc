// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IPyth} from "./interfaces/IPyth.sol";
import {IArenaView} from "./interfaces/IArenaView.sol";

/// @title Mempire fighters — every card is an ERC-721 you own.
/// @notice The roster is the market: each card is a fighter for one real asset
/// (a major, a memecoin or a tokenised stock), identified by its Pyth price
/// feed. Holding the asset is never required and never touched — a card is a
/// character, not collateral.
///
/// Power is earned, never bought. A card starts at level 1. Wins pay chests,
/// chests drop cards, and merging a duplicate into a card you keep promotes it,
/// up to level 10. There is no function anywhere that turns money into a level
/// without a duplicate, and duplicates come from chests.
contract MempireCards is ERC721, Ownable2Step {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    // ─────────────────────────────────────────────────────────────── constants

    uint8 public constant ARCHETYPES = 6;
    uint8 public constant MAX_LEVEL = 10;
    uint8 public constant DECK_SIZE = 8;
    uint8 public constant CHEST_SLOTS = 4;

    /// Merge fee per current level: 1→2 costs 100, 9→10 costs 900.
    uint256 public constant MERGE_FEE_PER_LEVEL = 100 ether;
    /// A card bought with $MEMPIRE instead of MON.
    uint256 public constant MINT_FEE_MEMPIRE = 250 ether;
    /// Skip a chest's unlock timer.
    uint256 public constant SKIP_FEE = 25 ether;
    /// Buy a golden chest outright. It lands even when every slot is full.
    uint256 public constant CHEST_PRICE = 100 ether;

    /// The tightest and loosest price-age bounds a fighter may be registered
    /// with. Crypto trades around the clock and uses the tight end; a stock's
    /// last print can be a long weekend old, and refusing to mint NVDA on a
    /// Saturday would be a bug, not a safety property.
    uint32 public constant MIN_PRICE_AGE = 60;
    uint32 public constant MAX_PRICE_AGE = 4 days;

    // Chest tiers: silver, golden, magic, legendary.
    uint8 internal constant SILVER = 0;
    uint8 internal constant GOLDEN = 1;
    uint8 internal constant MAGIC = 2;
    uint8 internal constant LEGENDARY = 3;

    // Chest states.
    uint8 internal constant CHEST_IDLE = 1;
    uint8 internal constant CHEST_UNLOCKING = 2;
    uint8 internal constant CHEST_REVEALING = 3;
    uint8 internal constant CHEST_OPENED = 4;

    // ─────────────────────────────────────────────────────────────── storage

    struct Coin {
        bytes32 feedId; // Pyth price feed id — the asset's identity
        uint8 archetype; // keccak256(feedId) % 6, fixed at registration
        bool active;
        uint32 maxPriceAge; // seconds; stocks need room for closed markets
        string ticker;
    }

    /// One storage slot per card.
    struct Card {
        uint16 coinId;
        uint8 level;
        uint8 archetype;
        uint64 lockedBy; // match id that last locked it; live only while that match holds cards
        int64 mintPrice; // Pyth price at mint (0 for starter and chest cards)
        int32 mintExpo;
    }

    struct Chest {
        address owner;
        uint8 tier;
        uint8 state;
        uint40 readyAt; // when its unlock timer finishes
        uint64 revealBlock; // the future block whose hash decides the drop
    }

    IERC20 public immutable mempire;
    IPyth public immutable pyth;

    address public treasury;
    address public arena;
    address public relayer;
    uint256 public mintFee;
    /// Divides every chest timer. 1 on a real deployment; 60 on testnet so a
    /// judge sees a three-hour chest open in three minutes.
    uint32 public timeScale;
    string public baseURI;

    Coin[] internal _coins;
    mapping(bytes32 feedId => bool) public feedRegistered;

    uint256 public nextCardId = 1;
    mapping(uint256 id => Card) internal _cards;
    mapping(address owner => uint256[]) internal _owned;
    mapping(uint256 id => uint256) internal _ownedIndex;
    mapping(address owner => mapping(uint16 coinId => uint16)) public coinCount;

    mapping(address => bool) public starterClaimed;

    uint256 public nextChestId = 1;
    mapping(uint256 id => Chest) public chests;
    mapping(address owner => uint8) public activeChests;
    mapping(address owner => uint256[]) internal _chestList;
    mapping(address owner => uint256) public unlockingChest;

    // ─────────────────────────────────────────────────────────────── events

    event CoinRegistered(uint16 indexed coinId, bytes32 indexed feedId, uint8 archetype, string ticker);
    event CoinActive(uint16 indexed coinId, bool active);
    event CardMinted(
        uint256 indexed cardId, address indexed owner, uint16 indexed coinId, uint8 archetype, uint8 source, int64 price, int32 expo
    );
    event CardMerged(uint256 indexed cardId, address indexed owner, uint256 burned, uint8 level, uint256 paid);
    event ChestGranted(uint256 indexed chestId, address indexed owner, uint8 tier, bool bought);
    event ChestForfeited(address indexed owner, uint8 tier);
    event ChestUnlocking(uint256 indexed chestId, uint40 readyAt);
    event ChestSkipped(uint256 indexed chestId, uint256 paid);
    event ChestOpening(uint256 indexed chestId, uint64 revealBlock);
    event ChestOpened(uint256 indexed chestId, address indexed owner, bytes32 seed, uint256[] cardIds);
    event ConfigChanged();

    // Card sources, for the indexer.
    uint8 internal constant SRC_MINT = 0;
    uint8 internal constant SRC_MEMPIRE = 1;
    uint8 internal constant SRC_STARTER = 2;
    uint8 internal constant SRC_CHEST = 3;

    // ─────────────────────────────────────────────────────────────── errors

    error UnknownCoin();
    error BadPriceAge();
    error CoinInactive();
    error FeedTaken();
    error WrongPayment();
    error NotOwner();
    error CardLocked();
    error SameCard();
    error DifferentCoins();
    error MaxLevel();
    error NotArena();
    error NotRelayer();
    error StarterTaken();
    error BadDeck();
    error DuplicateCoin();
    error BadChest();
    error ChestNotReady();
    error AnotherChestUnlocking();
    error TooEarly();
    error TransferFailed();

    constructor(
        address owner_,
        IERC20 mempire_,
        IPyth pyth_,
        address treasury_,
        uint256 mintFee_,
        uint32 timeScale_,
        string memory baseURI_
    ) ERC721("Mempire Fighter", "MFTR") Ownable(owner_) {
        mempire = mempire_;
        pyth = pyth_;
        treasury = treasury_;
        mintFee = mintFee_;
        timeScale = timeScale_ == 0 ? 1 : timeScale_;
        baseURI = baseURI_;
    }

    // ─────────────────────────────────────────────────────────────── admin

    function setArena(address arena_) external onlyOwner {
        arena = arena_;
        emit ConfigChanged();
    }

    function setRelayer(address relayer_) external onlyOwner {
        relayer = relayer_;
        emit ConfigChanged();
    }

    function setTreasury(address treasury_) external onlyOwner {
        treasury = treasury_;
        emit ConfigChanged();
    }

    function setMintFee(uint256 fee) external onlyOwner {
        mintFee = fee;
        emit ConfigChanged();
    }

    function setBaseURI(string calldata uri) external onlyOwner {
        baseURI = uri;
        emit ConfigChanged();
    }

    /// Add fighters to the roster. The archetype is derived from the feed id,
    /// not chosen, so nobody — the admin included — can hand a favoured asset a
    /// better class.
    function registerCoins(bytes32[] calldata feedIds, string[] calldata tickers, uint32[] calldata maxAges)
        external
        onlyOwner
    {
        if (feedIds.length != tickers.length || feedIds.length != maxAges.length) revert BadDeck();
        for (uint256 i; i < feedIds.length; ++i) {
            _register(feedIds[i], tickers[i], maxAges[i]);
        }
    }

    function registerCoin(bytes32 feedId, string calldata ticker, uint32 maxAge) external onlyOwner returns (uint16) {
        return _register(feedId, ticker, maxAge);
    }

    function _register(bytes32 feedId, string calldata ticker, uint32 maxAge) internal returns (uint16 coinId) {
        if (feedRegistered[feedId]) revert FeedTaken();
        if (maxAge < MIN_PRICE_AGE || maxAge > MAX_PRICE_AGE) revert BadPriceAge();
        feedRegistered[feedId] = true;
        uint8 arch = archetypeFor(feedId);
        coinId = uint16(_coins.length);
        _coins.push(Coin({feedId: feedId, archetype: arch, active: true, maxPriceAge: maxAge, ticker: ticker}));
        emit CoinRegistered(coinId, feedId, arch, ticker);
    }

    /// Pause new mints of a fighter. Cards already minted keep working.
    function setCoinActive(uint16 coinId, bool active) external onlyOwner {
        if (coinId >= _coins.length) revert UnknownCoin();
        _coins[coinId].active = active;
        emit CoinActive(coinId, active);
    }

    function archetypeFor(bytes32 feedId) public pure returns (uint8) {
        return uint8(uint256(keccak256(abi.encodePacked(feedId))) % ARCHETYPES);
    }

    // ─────────────────────────────────────────────────────────────── minting

    /// Mint a fighter for MON. The caller posts a fresh Pyth update for the
    /// asset in the same transaction; the card records the price it was minted
    /// at, and an asset with no live price cannot be minted at all — that is
    /// the eligibility gate.
    function mint(uint16 coinId, bytes[] calldata priceUpdate) external payable returns (uint256 id) {
        uint256 updateFee = pyth.getUpdateFee(priceUpdate);
        if (msg.value != mintFee + updateFee) revert WrongPayment();
        (int64 price, int32 expo) = _postPrice(coinId, priceUpdate, updateFee);
        _pay(treasury, mintFee);
        id = _mintCard(msg.sender, coinId, SRC_MINT, price, expo);
    }

    /// The same card for 250 $MEMPIRE instead of MON. One price or the other,
    /// never both; msg.value covers only the oracle's update fee.
    function mintWithMempire(uint16 coinId, bytes[] calldata priceUpdate) external payable returns (uint256 id) {
        uint256 updateFee = pyth.getUpdateFee(priceUpdate);
        if (msg.value != updateFee) revert WrongPayment();
        (int64 price, int32 expo) = _postPrice(coinId, priceUpdate, updateFee);
        mempire.safeTransferFrom(msg.sender, treasury, MINT_FEE_MEMPIRE);
        id = _mintCard(msg.sender, coinId, SRC_MEMPIRE, price, expo);
    }

    /// The starter deck: eight distinct fighters, once per address, paid for by
    /// the game's relayer so a brand-new passkey account holds a playable deck
    /// before it has ever held MON.
    function mintStarter(address to, uint16[] calldata coinIds) external returns (uint256[] memory ids) {
        if (msg.sender != relayer) revert NotRelayer();
        if (starterClaimed[to]) revert StarterTaken();
        if (coinIds.length != DECK_SIZE) revert BadDeck();
        starterClaimed[to] = true;
        ids = new uint256[](DECK_SIZE);
        for (uint256 i; i < DECK_SIZE; ++i) {
            for (uint256 j; j < i; ++j) {
                if (coinIds[i] == coinIds[j]) revert DuplicateCoin();
            }
            ids[i] = _mintCard(to, coinIds[i], SRC_STARTER, 0, 0);
        }
    }

    function _postPrice(uint16 coinId, bytes[] calldata priceUpdate, uint256 updateFee)
        internal
        returns (int64 price, int32 expo)
    {
        Coin storage c = _coin(coinId);
        if (!c.active) revert CoinInactive();
        pyth.updatePriceFeeds{value: updateFee}(priceUpdate);
        IPyth.Price memory p = pyth.getPriceNoOlderThan(c.feedId, c.maxPriceAge);
        return (p.price, p.expo);
    }

    function _mintCard(address to, uint16 coinId, uint8 source, int64 price, int32 expo) internal returns (uint256 id) {
        Coin storage c = _coin(coinId);
        id = nextCardId++;
        _cards[id] = Card({
            coinId: coinId, level: 1, archetype: c.archetype, lockedBy: 0, mintPrice: price, mintExpo: expo
        });
        // Plain `_mint`, not `_safeMint`: a receiver hook that reverts must not
        // be able to brick a chest reveal or a starter grant.
        _mint(to, id);
        emit CardMinted(id, to, coinId, c.archetype, source, price, expo);
    }

    // ─────────────────────────────────────────────────────────────── merging

    /// Merge a duplicate into a card you keep, for one level. The duplicate is
    /// burned. Priced per level in $MEMPIRE, so the last level costs what the
    /// whole climb did and level 10 is a decision rather than an afternoon.
    function merge(uint256 keepId, uint256 dupeId) external {
        if (keepId == dupeId) revert SameCard();
        if (ownerOf(keepId) != msg.sender || ownerOf(dupeId) != msg.sender) revert NotOwner();
        Card storage keep = _cards[keepId];
        Card storage dupe = _cards[dupeId];
        if (keep.coinId != dupe.coinId) revert DifferentCoins();
        if (isLocked(keepId) || isLocked(dupeId)) revert CardLocked();
        if (keep.level >= MAX_LEVEL) revert MaxLevel();

        uint256 price = MERGE_FEE_PER_LEVEL * keep.level;
        mempire.safeTransferFrom(msg.sender, treasury, price);

        keep.level += 1;
        _burn(dupeId);
        delete _cards[dupeId];
        emit CardMerged(keepId, msg.sender, dupeId, keep.level, price);
    }

    // ─────────────────────────────────────────────────────────────── decks (arena only)

    /// Lock a deck into a match and return its power (the sum of its levels).
    /// Eight cards, all owned by `player`, none already held by a live match,
    /// one card per asset.
    function lockDeck(address player, uint256[] calldata ids, uint64 matchId)
        external
        returns (uint32 power, bytes32 deckHash)
    {
        if (msg.sender != arena) revert NotArena();
        if (ids.length != DECK_SIZE) revert BadDeck();
        uint16[DECK_SIZE] memory seen;
        for (uint256 i; i < DECK_SIZE; ++i) {
            uint256 id = ids[i];
            if (_ownerOf(id) != player) revert NotOwner();
            if (isLocked(id)) revert CardLocked();
            Card storage c = _cards[id];
            for (uint256 j; j < i; ++j) {
                if (seen[j] == c.coinId) revert DuplicateCoin();
            }
            seen[i] = c.coinId;
            c.lockedBy = matchId;
            power += c.level;
        }
        deckHash = keccak256(abi.encode(ids));
    }

    /// A card is locked while the match that last locked it still holds cards.
    /// Settling, cancelling or voiding a match unlocks every card in it at once,
    /// without a single write — so no settlement path can strand a card.
    function isLocked(uint256 id) public view returns (bool) {
        uint64 m = _cards[id].lockedBy;
        return m != 0 && arena != address(0) && IArenaView(arena).holdsCards(m);
    }

    // ─────────────────────────────────────────────────────────────── chests

    /// Called by the arena when a staked match is won. Four slots: a win while
    /// they are full pays no chest, which is what makes the timer worth
    /// skipping.
    function grantChest(address player, bytes32 entropy) external {
        if (msg.sender != arena) revert NotArena();
        uint8 tier = _rollTier(keccak256(abi.encode(entropy, blockhash(block.number - 1), player)));
        if (activeChests[player] >= CHEST_SLOTS) {
            emit ChestForfeited(player, tier);
            return;
        }
        _grant(player, tier, false);
    }

    /// Buy a golden chest. It needs no slot and no timer.
    function buyChest() external returns (uint256 id) {
        mempire.safeTransferFrom(msg.sender, treasury, CHEST_PRICE);
        id = _grant(msg.sender, GOLDEN, true);
        chests[id].state = CHEST_UNLOCKING;
        chests[id].readyAt = uint40(block.timestamp);
    }

    function _grant(address player, uint8 tier, bool bought) internal returns (uint256 id) {
        id = nextChestId++;
        chests[id] = Chest({owner: player, tier: tier, state: CHEST_IDLE, readyAt: 0, revealBlock: 0});
        activeChests[player] += 1;
        _chestList[player].push(id);
        emit ChestGranted(id, player, tier, bought);
    }

    /// Start a chest's timer. One chest unlocks at a time.
    function startUnlock(uint256 chestId) external {
        Chest storage c = _ownChest(chestId);
        if (c.state != CHEST_IDLE) revert BadChest();
        uint256 current = unlockingChest[msg.sender];
        if (current != 0) {
            Chest storage cur = chests[current];
            if (cur.state == CHEST_UNLOCKING && cur.readyAt > block.timestamp) revert AnotherChestUnlocking();
        }
        c.state = CHEST_UNLOCKING;
        c.readyAt = uint40(block.timestamp + unlockSeconds(c.tier));
        unlockingChest[msg.sender] = chestId;
        emit ChestUnlocking(chestId, c.readyAt);
    }

    /// Pay to finish a chest's timer now. Works on an idle chest too.
    function skip(uint256 chestId) external {
        Chest storage c = _ownChest(chestId);
        if (c.state != CHEST_IDLE && c.state != CHEST_UNLOCKING) revert BadChest();
        if (c.state == CHEST_UNLOCKING && c.readyAt <= block.timestamp) revert BadChest();
        mempire.safeTransferFrom(msg.sender, treasury, SKIP_FEE);
        c.state = CHEST_UNLOCKING;
        c.readyAt = uint40(block.timestamp);
        emit ChestSkipped(chestId, SKIP_FEE);
    }

    /// Commit an unlocked chest to the hash of the next block. Its contents are
    /// fixed by a block that does not exist yet when this is called, and read
    /// by `reveal` once it does.
    function open(uint256 chestId) external {
        Chest storage c = _ownChest(chestId);
        if (c.state != CHEST_UNLOCKING || c.readyAt > block.timestamp) revert ChestNotReady();
        c.state = CHEST_REVEALING;
        c.revealBlock = uint64(block.number + 1);
        if (unlockingChest[msg.sender] == chestId) unlockingChest[msg.sender] = 0;
        emit ChestOpening(chestId, c.revealBlock);
    }

    /// Mint what the chest holds. `favored` names coins the caller already
    /// owns; most drops land on one of them, because a duplicate is what a
    /// player needs to level a card. Naming a coin you do not own does nothing.
    function reveal(uint256 chestId, uint16[] calldata favored) external returns (uint256[] memory ids) {
        Chest storage c = _ownChest(chestId);
        if (c.state != CHEST_REVEALING) revert BadChest();
        if (block.number <= c.revealBlock) revert TooEarly();
        bytes32 bh = blockhash(c.revealBlock);
        if (bh == bytes32(0)) {
            // Older than 256 blocks: the hash is gone. Re-commit to a new
            // future block rather than letting anyone pick a convenient one.
            c.revealBlock = uint64(block.number + 1);
            emit ChestOpening(chestId, c.revealBlock);
            return ids;
        }

        bytes32 seed = keccak256(abi.encode(bh, chestId, msg.sender));
        uint256 n = cardsIn(c.tier);
        ids = new uint256[](n);

        uint16[] memory owned = new uint16[](favored.length);
        uint256 ownedLen;
        for (uint256 i; i < favored.length && i < DECK_SIZE; ++i) {
            if (favored[i] < _coins.length && coinCount[msg.sender][favored[i]] > 0) owned[ownedLen++] = favored[i];
        }

        c.state = CHEST_OPENED;
        activeChests[msg.sender] -= 1;
        uint256 roster = _coins.length;
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint16 coinId;
            if (ownedLen > 0 && r % 100 < 65) {
                coinId = owned[(r >> 8) % ownedLen];
            } else {
                coinId = uint16((r >> 8) % roster);
            }
            ids[i] = _mintCard(msg.sender, coinId, SRC_CHEST, 0, 0);
        }
        emit ChestOpened(chestId, msg.sender, seed, ids);
    }

    function unlockSeconds(uint8 tier) public view returns (uint256) {
        uint256 s = tier == SILVER ? 15 minutes : tier == GOLDEN ? 3 hours : tier == MAGIC ? 8 hours : 12 hours;
        return s / timeScale;
    }

    function cardsIn(uint8 tier) public pure returns (uint256) {
        return uint256(tier) + 1;
    }

    /// 62 / 26 / 9 / 3.
    function _rollTier(bytes32 r) internal pure returns (uint8) {
        uint256 x = uint256(r) % 100;
        if (x < 62) return SILVER;
        if (x < 88) return GOLDEN;
        if (x < 97) return MAGIC;
        return LEGENDARY;
    }

    function _ownChest(uint256 chestId) internal view returns (Chest storage c) {
        c = chests[chestId];
        if (c.owner != msg.sender) revert BadChest();
    }

    // ─────────────────────────────────────────────────────────────── ERC-721 plumbing

    /// Locked cards cannot move or burn; the per-owner index and coin counts
    /// follow every transfer.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0) && isLocked(tokenId)) revert CardLocked();
        from = super._update(to, tokenId, auth);
        uint16 coinId = _cards[tokenId].coinId;
        if (from != address(0)) {
            _removeOwned(from, tokenId);
            coinCount[from][coinId] -= 1;
        }
        if (to != address(0)) {
            _ownedIndex[tokenId] = _owned[to].length;
            _owned[to].push(tokenId);
            coinCount[to][coinId] += 1;
        }
    }

    function _removeOwned(address from, uint256 tokenId) internal {
        uint256[] storage list = _owned[from];
        uint256 idx = _ownedIndex[tokenId];
        uint256 last = list[list.length - 1];
        list[idx] = last;
        _ownedIndex[last] = idx;
        list.pop();
        delete _ownedIndex[tokenId];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(baseURI, tokenId.toString());
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _coin(uint16 coinId) internal view returns (Coin storage) {
        if (coinId >= _coins.length) revert UnknownCoin();
        return _coins[coinId];
    }

    // ─────────────────────────────────────────────────────────────── reads

    function coinCountTotal() external view returns (uint256) {
        return _coins.length;
    }

    function coin(uint16 coinId) external view returns (Coin memory) {
        return _coin(coinId);
    }

    function roster() external view returns (Coin[] memory) {
        return _coins;
    }

    function card(uint256 id) external view returns (Card memory) {
        return _cards[id];
    }

    /// Every card an address holds, in one call.
    function cardsOf(address owner)
        external
        view
        returns (uint256[] memory ids, Card[] memory data, bool[] memory locked)
    {
        ids = _owned[owner];
        data = new Card[](ids.length);
        locked = new bool[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            data[i] = _cards[ids[i]];
            locked[i] = isLocked(ids[i]);
        }
    }

    /// Every chest an address has not yet opened.
    function chestsOf(address owner) external view returns (uint256[] memory ids, Chest[] memory data) {
        uint256[] storage list = _chestList[owner];
        uint256 want = activeChests[owner];
        ids = new uint256[](want);
        data = new Chest[](want);
        uint256 count;
        for (uint256 i = list.length; i > 0 && count < want; --i) {
            uint256 id = list[i - 1];
            Chest storage c = chests[id];
            if (c.state != CHEST_OPENED) {
                ids[count] = id;
                data[count] = c;
                ++count;
            }
        }
    }
}
