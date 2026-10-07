// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IArenaView} from "./interfaces/IArenaView.sol";
import {MempireCards} from "./MempireCards.sol";
import {MarketMeta} from "./MarketMeta.sol";

/// @title The arena — escrowed 1v1 pots, a play log on Monad, two-claim settlement.
/// @notice Two players each put up the same stake, in MON or AUSD. The match is
/// a deterministic simulation both clients run in lockstep; every card drop is
/// also written here as it happens, by a per-match session key, so the match is
/// on chain while it is being played rather than summarised afterwards.
///
/// When it ends each seat records the winner it computed. If they agree the
/// pot pays out — 90% to the winner, 10% rake — in the same transaction as the
/// second claim. If they disagree the match is void and both stakes go home.
/// If a seat never claims, the claim that did arrive stands once the deadline
/// passes; if neither claimed, both are refunded. No path leaves a pot stuck,
/// and no path leaves a card locked: cards are locked by reference to a match
/// that is live, so settling is unlocking.
///
/// The game never touches anything a player holds besides the stake they put
/// on a single match.
contract MempireArena is IArenaView, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────── constants

    uint8 public constant STATE_NONE = 0;
    uint8 public constant STATE_OPEN = 1;
    uint8 public constant STATE_ACTIVE = 2;
    uint8 public constant STATE_SETTLED = 3;

    uint8 public constant SEAT0 = 0;
    uint8 public constant SEAT1 = 1;
    uint8 public constant TIE = 2;
    /// As a claim: not yet claimed. As a winner: void — both refunded.
    uint8 public constant NONE = 3;

    /// 3 min regulation + 60 s overtime at 20 ticks a second, with slack.
    uint32 public constant MAX_TICK = 5_000;
    uint16 public constant MAX_PLAYS_PER_SEAT = 200;
    uint8 public constant DECK_SIZE = 8;
    /// Most MON a create/join may forward to its session key for gas.
    uint256 public constant MAX_SESSION_GAS = 0.5 ether;

    /// $MEMPIRE paid for a won match, for a player's first sixteen wins only:
    /// it exists to give a new player their first currency, not an income.
    uint256 public constant WIN_REWARD = 50 ether;
    uint16 public constant REWARDED_WINS_CAP = 16;

    // ─────────────────────────────────────────────────────────────── storage

    struct Match {
        address p0;
        uint64 createdAt;
        uint8 tier;
        uint8 state;
        uint8 winner;
        uint8 claim0;
        address p1;
        uint64 deadline;
        uint8 claim1;
        address s0;
        uint32 power0;
        uint32 power1;
        address s1;
        uint64 metaEpoch;
        address currency;
        uint128 stake;
        bytes32 deck0;
        bytes32 deck1;
        bytes32 final0;
        bytes32 final1;
        uint32 lastTick0;
        uint32 lastTick1;
        uint16 plays0;
        uint16 plays1;
    }

    struct Permit {
        uint256 deadline; // 0 = no permit; an allowance already exists
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    MempireCards public immutable cards;
    IERC20 public immutable mempire;
    /// Agora's AUSD — the dollar stake currency.
    address public immutable ausd;

    MarketMeta public marketMeta;
    address public treasury;
    uint16 public rakeBps = 1_000; // 10%
    uint16 public tieRakeBps = 500; // 5%
    uint32 public powerBand = 12;
    uint32 public matchTimeout = 8 minutes;

    uint64 public nextMatchId = 1;
    mapping(uint64 id => Match) internal _matches;
    mapping(address player => uint16) public rewardedWins;
    /// Payouts a recipient refused (a contract with no receive, a blocked
    /// token transfer), held for them to pull.
    mapping(address currency => mapping(address player => uint256)) public owed;

    // ─────────────────────────────────────────────────────────────── events

    event MatchCreated(
        uint64 indexed matchId,
        address indexed player,
        uint8 tier,
        address currency,
        uint128 stake,
        uint32 power,
        bytes32 deckHash,
        uint256[] cardIds,
        address session
    );
    event MatchJoined(
        uint64 indexed matchId,
        address indexed player,
        uint32 power,
        bytes32 deckHash,
        uint256[] cardIds,
        address session,
        uint64 metaEpoch,
        uint64 deadline
    );
    event MatchCancelled(uint64 indexed matchId, address indexed player);
    event Played(uint64 indexed matchId, uint8 seat, uint32 tick, uint8 cardIndex, int16 x, int16 y);
    event Checkpoint(uint64 indexed matchId, uint8 seat, uint32 tick, uint64 stateHash);
    event Claimed(uint64 indexed matchId, uint8 seat, uint8 winner, bytes32 finalHash);
    event MatchSettled(
        uint64 indexed matchId,
        uint8 winner,
        address currency,
        uint256 pot,
        uint256 rake,
        address indexed winnerAddress,
        bool byTimeout
    );
    event MatchVoided(uint64 indexed matchId, bool disputed);
    event WinRewarded(uint64 indexed matchId, address indexed player, uint256 amount, uint16 rewardedWins);
    event PayoutHeld(address indexed currency, address indexed player, uint256 amount);
    event ConfigChanged();

    // ─────────────────────────────────────────────────────────────── errors

    error BadStake();
    error BadSessionGas();
    error BadState();
    error NotASeat();
    error SelfMatch();
    error PowerMismatch();
    error BadWinner();
    error AlreadyClaimed();
    error TooEarly();
    error TooLate();
    error BadTick();
    error TooManyPlays();
    error BadCardIndex();
    error NothingOwed();
    error TransferFailed();

    constructor(address owner_, MempireCards cards_, address ausd_, MarketMeta meta_, address treasury_)
        Ownable(owner_)
    {
        cards = cards_;
        mempire = cards_.mempire();
        ausd = ausd_;
        marketMeta = meta_;
        treasury = treasury_;
    }

    // ─────────────────────────────────────────────────────────────── admin

    function setTreasury(address t) external onlyOwner {
        treasury = t;
        emit ConfigChanged();
    }

    function setMarketMeta(MarketMeta m) external onlyOwner {
        marketMeta = m;
        emit ConfigChanged();
    }

    function setRules(uint16 rake, uint16 tieRake, uint32 band, uint32 timeout) external onlyOwner {
        require(rake <= 2_000 && tieRake <= 2_000 && timeout >= 4 minutes, "bad rules");
        rakeBps = rake;
        tieRakeBps = tieRake;
        powerBand = band;
        matchTimeout = timeout;
        emit ConfigChanged();
    }

    // ─────────────────────────────────────────────────────────────── stakes

    /// Four fixed tiers per currency. A tier is a fact the chain enforces, not a
    /// label the client chooses: Pauper, Knight, Duke, Emperor.
    function stakeFor(address currency, uint8 tier) public view returns (uint128) {
        if (tier > 3) return 0;
        if (currency == address(0)) {
            return [uint128(0.01 ether), 0.05 ether, 0.25 ether, 1 ether][tier];
        }
        if (currency == ausd) {
            return [uint128(1e6), 5e6, 25e6, 100e6][tier]; // AUSD has 6 decimals
        }
        return 0;
    }

    // ─────────────────────────────────────────────────────────────── lifecycle

    /// Open a match: escrow the stake, lock the deck, arm the session key.
    /// For MON, msg.value is the stake plus any gas to forward to the session
    /// key. For AUSD, msg.value is only that gas, and the stake is pulled with
    /// an allowance or a permit signed in the same breath.
    function createMatch(
        uint8 tier,
        address currency,
        uint256[] calldata cardIds,
        address session,
        Permit calldata permit
    ) external payable nonReentrant returns (uint64 id) {
        uint128 stake = stakeFor(currency, tier);
        if (stake == 0) revert BadStake();
        uint256 sessionGas = _collectStake(currency, stake, permit);

        id = nextMatchId++;
        (uint32 power, bytes32 deckHash) = cards.lockDeck(msg.sender, cardIds, id);

        Match storage m = _matches[id];
        m.p0 = msg.sender;
        m.createdAt = uint64(block.timestamp);
        m.tier = tier;
        m.state = STATE_OPEN;
        m.winner = NONE;
        m.claim0 = NONE;
        m.claim1 = NONE;
        m.s0 = session;
        m.power0 = power;
        m.currency = currency;
        m.stake = stake;
        m.deck0 = deckHash;

        _fundSession(session, sessionGas);
        emit MatchCreated(id, msg.sender, tier, currency, stake, power, deckHash, cardIds, session);
    }

    /// Take the second seat. The stake must match the one already escrowed and
    /// the two decks must sit within the power band.
    function joinMatch(uint64 id, uint256[] calldata cardIds, address session, Permit calldata permit)
        external
        payable
        nonReentrant
    {
        Match storage m = _matches[id];
        if (m.state != STATE_OPEN) revert BadState();
        if (msg.sender == m.p0 || session == m.p0 || (session != address(0) && session == m.s0)) {
            revert SelfMatch();
        }
        uint256 sessionGas = _collectStake(m.currency, m.stake, permit);

        (uint32 power, bytes32 deckHash) = cards.lockDeck(msg.sender, cardIds, id);
        uint32 diff = power > m.power0 ? power - m.power0 : m.power0 - power;
        if (diff > powerBand) revert PowerMismatch();

        m.p1 = msg.sender;
        m.s1 = session;
        m.power1 = power;
        m.deck1 = deckHash;
        m.state = STATE_ACTIVE;
        m.deadline = uint64(block.timestamp + matchTimeout);
        m.metaEpoch = address(marketMeta) == address(0) ? 0 : marketMeta.currentEpoch();

        _fundSession(session, sessionGas);
        emit MatchJoined(id, msg.sender, power, deckHash, cardIds, session, m.metaEpoch, m.deadline);
    }

    /// Withdraw an open match nobody joined. Free: the stake comes straight back.
    function cancelMatch(uint64 id) external nonReentrant {
        Match storage m = _matches[id];
        if (m.state != STATE_OPEN) revert BadState();
        if (msg.sender != m.p0) revert NotASeat();
        m.state = STATE_SETTLED;
        m.winner = NONE;
        _pay(m.currency, m.p0, m.stake);
        emit MatchCancelled(id, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────── the play log

    /// One card drop. Sent by the seat's session key at 400 ms blocks, so the
    /// log fills in while the match is played. Ticks are monotonic per seat.
    function play(uint64 id, uint32 tick, uint8 cardIndex, int16 x, int16 y) external {
        Match storage m = _matches[id];
        uint8 seat = _activeSeat(m);
        if (cardIndex >= DECK_SIZE) revert BadCardIndex();
        if (tick > MAX_TICK) revert BadTick();
        if (seat == SEAT0) {
            if (tick < m.lastTick0) revert BadTick();
            if (m.plays0 >= MAX_PLAYS_PER_SEAT) revert TooManyPlays();
            m.lastTick0 = tick;
            m.plays0 += 1;
        } else {
            if (tick < m.lastTick1) revert BadTick();
            if (m.plays1 >= MAX_PLAYS_PER_SEAT) revert TooManyPlays();
            m.lastTick1 = tick;
            m.plays1 += 1;
        }
        emit Played(id, seat, tick, cardIndex, x, y);
    }

    /// A state-hash checkpoint. It states the past: it never moves the play
    /// cursor, so an in-flight checkpoint can never make a later card play look
    /// out of order.
    function checkpoint(uint64 id, uint32 tick, uint64 stateHash) external {
        Match storage m = _matches[id];
        uint8 seat = _activeSeat(m);
        if (tick > MAX_TICK) revert BadTick();
        emit Checkpoint(id, seat, tick, stateHash);
    }

    // ─────────────────────────────────────────────────────────────── settlement

    /// Record the result this seat's simulation produced: 0 or 1 for a seat, 2
    /// for a tie. The second claim settles the match on the spot — paid if the
    /// two agree, voided and refunded if they do not.
    function claim(uint64 id, uint8 winner, bytes32 finalHash) external nonReentrant {
        if (winner > TIE) revert BadWinner();
        Match storage m = _matches[id];
        uint8 seat = _activeSeat(m);
        uint8 other;
        if (seat == SEAT0) {
            if (m.claim0 != NONE) revert AlreadyClaimed();
            m.claim0 = winner;
            m.final0 = finalHash;
            other = m.claim1;
        } else {
            if (m.claim1 != NONE) revert AlreadyClaimed();
            m.claim1 = winner;
            m.final1 = finalHash;
            other = m.claim0;
        }
        emit Claimed(id, seat, winner, finalHash);

        if (other == NONE) return;
        if (other == winner) {
            _settle(id, m, winner, false);
        } else {
            _void(id, m, true);
        }
    }

    /// After the deadline, finish a match one seat abandoned. Permissionless,
    /// because the outcome is decided by what is stored, not by who calls:
    /// a single claim stands, and no claims at all refund both stakes.
    function claimTimeout(uint64 id) external nonReentrant {
        Match storage m = _matches[id];
        if (m.state != STATE_ACTIVE) revert BadState();
        if (block.timestamp < m.deadline) revert TooEarly();
        uint8 c = m.claim0 != NONE ? m.claim0 : m.claim1;
        if (c == NONE) {
            _void(id, m, false);
        } else {
            _settle(id, m, c, true);
        }
    }

    /// Pull a payout that could not be pushed.
    function withdraw(address currency) external nonReentrant {
        uint256 amount = owed[currency][msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[currency][msg.sender] = 0;
        if (currency == address(0)) {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(currency).safeTransfer(msg.sender, amount);
        }
    }

    function _settle(uint64 id, Match storage m, uint8 winner, bool byTimeout) internal {
        m.state = STATE_SETTLED;
        m.winner = winner;
        uint256 pot = uint256(m.stake) * 2;
        address currency = m.currency;
        uint256 rake;
        address winnerAddress;
        if (winner == TIE) {
            rake = (pot * tieRakeBps) / 10_000;
            uint256 half = (pot - rake) / 2;
            rake = pot - half * 2; // the odd unit goes to the treasury, not into thin air
            _pay(currency, m.p0, half);
            _pay(currency, m.p1, half);
        } else {
            rake = (pot * rakeBps) / 10_000;
            winnerAddress = winner == SEAT0 ? m.p0 : m.p1;
            _pay(currency, winnerAddress, pot - rake);
        }
        _pay(currency, treasury, rake);
        emit MatchSettled(id, winner, currency, pot, rake, winnerAddress, byTimeout);

        // A walkover pays the pot, but not the bonus or the chest: those are
        // for winning a match both seats finished.
        if (winnerAddress != address(0) && !byTimeout) {
            _reward(id, winnerAddress);
            cards.grantChest(winnerAddress, keccak256(abi.encode(id, m.final0, m.final1)));
        }
    }

    function _void(uint64 id, Match storage m, bool disputed) internal {
        m.state = STATE_SETTLED;
        m.winner = NONE;
        _pay(m.currency, m.p0, m.stake);
        _pay(m.currency, m.p1, m.stake);
        emit MatchVoided(id, disputed);
    }

    /// The win bonus is paid from a pool the treasury funds. An empty pool pays
    /// the pot and skips the bonus — it never blocks a settlement.
    function _reward(uint64 id, address player) internal {
        uint16 n = rewardedWins[player];
        if (n >= REWARDED_WINS_CAP) return;
        if (mempire.balanceOf(address(this)) < WIN_REWARD) return;
        rewardedWins[player] = n + 1;
        mempire.safeTransfer(player, WIN_REWARD);
        emit WinRewarded(id, player, WIN_REWARD, n + 1);
    }

    // ─────────────────────────────────────────────────────────────── internals

    function _collectStake(address currency, uint128 stake, Permit calldata permit)
        internal
        returns (uint256 sessionGas)
    {
        if (currency == address(0)) {
            if (msg.value < stake) revert BadStake();
            sessionGas = msg.value - stake;
        } else {
            sessionGas = msg.value;
            if (permit.deadline != 0) {
                // A permit that was front-run has already set the allowance it
                // was going to set; the transfer below is what must succeed.
                try IERC20Permit(currency).permit(
                    msg.sender, address(this), stake, permit.deadline, permit.v, permit.r, permit.s
                ) {} catch {}
            }
            IERC20(currency).safeTransferFrom(msg.sender, address(this), stake);
        }
        if (sessionGas > MAX_SESSION_GAS) revert BadSessionGas();
    }

    function _fundSession(address session, uint256 amount) internal {
        if (amount == 0) return;
        if (session == address(0)) revert BadSessionGas();
        (bool ok,) = session.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// Push a payout; if the recipient refuses it, hold it for them to pull.
    function _pay(address currency, address to, uint256 amount) internal {
        if (amount == 0) return;
        bool ok;
        if (currency == address(0)) {
            (ok,) = to.call{value: amount, gas: 50_000}("");
        } else {
            (bool sent, bytes memory ret) =
                currency.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
            ok = sent && (ret.length == 0 || abi.decode(ret, (bool)));
        }
        if (!ok) {
            owed[currency][to] += amount;
            emit PayoutHeld(currency, to, amount);
        }
    }

    /// The seat the caller speaks for — as the player or as its session key —
    /// in a match that is live and inside its deadline.
    function _activeSeat(Match storage m) internal view returns (uint8) {
        if (m.state != STATE_ACTIVE) revert BadState();
        if (block.timestamp > m.deadline) revert TooLate();
        if (msg.sender == m.p0 || msg.sender == m.s0) return SEAT0;
        if (msg.sender == m.p1 || msg.sender == m.s1) return SEAT1;
        revert NotASeat();
    }

    // ─────────────────────────────────────────────────────────────── reads

    function holdsCards(uint64 id) external view override returns (bool) {
        uint8 s = _matches[id].state;
        return s == STATE_OPEN || s == STATE_ACTIVE;
    }

    function getMatch(uint64 id) external view returns (Match memory) {
        return _matches[id];
    }

    /// The simulation seed both clients derive: fixed by the match id and both
    /// committed decks, so neither seat can steer it alone.
    function seedOf(uint64 id) external view returns (uint32) {
        Match storage m = _matches[id];
        if (m.state < STATE_ACTIVE) return 0;
        return uint32(uint256(keccak256(abi.encode(id, m.deck0, m.deck1))));
    }
}
