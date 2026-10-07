import { useEffect } from 'react';
import { useChain } from './chain';
import { useCollection, type MintedCard } from './collection';
import { useDeck } from './deck';
import { useLadder } from './ladder';
import { useWallet } from './wallet';
import { COINS } from '../lib/coins';

/**
 * Keeps onchain state in step with the wallet.
 *
 * Boots the registry read once regardless of connection, because a visitor who
 * has connected nothing should still see the real coin registry — that read needs
 * no signer. Then loads wallet-scoped data whenever the address changes.
 *
 * Mounted once, in Shell.
 */
export function useChainSync(): void {
  const address = useWallet((s) => s.address);
  const connected = useWallet((s) => s.connected);
  const isGuest = useWallet((s) => s.isGuest);
  const init = useChain((s) => s.init);
  const loadWallet = useChain((s) => s.loadWallet);
  const clearWallet = useChain((s) => s.clearWallet);

  useEffect(() => { void init(); }, [init]);

  // Ladder standing is per-wallet and read-only here; the match store writes it.
  useEffect(() => {
    if (connected && address) {
      void useLadder.getState().load(address);
      void useLadder.getState().loadTop();
    } else {
      useLadder.getState().reset();
    }
  }, [connected, address]);

  useEffect(() => {
    if (!connected || !address) { clearWallet(); return; }
    // A guest signs through its own browser-held keypair, so it is passed the
    // same null adapter a wallet-less session has — `canSign` resolves the
    // difference downstream.
    void loadWallet(address);
  }, [connected, address, isGuest, loadWallet, clearWallet]);


  useChainCollection();
}

/**
 * Make the collection *be* the wallet's on-chain cards.
 *
 * Without this the two never met. The collection was seeded locally from the
 * coin registry and saved to the player row, while the actual minted `Card`
 * PDAs lived on chain — and the two sets had almost no mints in common. So a
 * player looked at eight fighters, picked eight for a deck, and the Arena
 * reported "8 of your cards are not minted onchain yet", because none of the
 * cards they were shown were the ones they owned.
 *
 * That is the game failing quietly: the fighters on screen have to be the
 * cards the wallet actually owns on chain, or the collection is fiction.
 *
 * The local collection survives for exactly one case — a wallet with no minted
 * cards at all, where the seeded set is what lets someone see the game before
 * spending anything. The moment a real card exists, the chain wins.
 */
function useChainCollection(): void {
  const cards = useChain((s) => s.cards);
  const mode = useChain((s) => s.mode);

  useEffect(() => {
    if (cards.length === 0) {
      // No cards on chain for this account (or nobody signed in): the
      // collection is empty, not a set of cards the player does not own.
      if (useCollection.getState().cards.length) useCollection.setState({ cards: [], nextId: 1 });
      return;
    }
    if (mode === 'offline') return;

    const mapped: MintedCard[] = cards.map((c) => ({
      // Keyed on the PDA id so the mapping is stable across reloads and two
      // cards for the same coin can never collide.
      id: `chain_${c.id}`,
      mint: c.mint,
      archetype: c.archetype as MintedCard['archetype'],
      level: c.level,
    }));

    /**
     * Chain cards, plus a seeded card for every coin not yet minted.
     *
     * Replacing the collection outright was a trap. A wallet with one minted
     * card ended up with a one-card collection, `repoint` could fill exactly
     * one deck slot, and `deck needs 8 cards` then blocked every mode —
     * including free Practice, which had worked a moment earlier. Minting your
     * first fighter, the thing the app tells you to do, locked you out of the
     * game, and the only way back was minting seven more distinct coins.
     *
     * So the chain still wins for any coin it knows about, and the seeded card
     * survives for the rest. An unminted card is honest about what it is: the
     * Arena already reports "N of your cards are not minted onchain yet" and
     * holds the match to rating only, which is precisely the pre-mint state.
     */
    const merged: MintedCard[] = [
      ...mapped,
    ];

    const current = useCollection.getState().cards;
    const collectionMatches = current.length === merged.length
      && current.every((c, i) => c.id === merged[i].id && c.level === merged[i].level);

    const fieldableMints = new Set(COINS.map((c) => c.mint));
    // Cards that exist *and* this build can field. A card whose coin was
    // registered after this client was built passes the first test and fails
    // the second, and a deck holding one is just as dead as a deck holding a
    // dangling id — so staleness has to mean both, or the re-point below never
    // runs for the case that needs it most.
    const valid0 = new Set(
      merged.filter((c) => fieldableMints.has(c.mint)).map((c) => c.id),
    );
    const deckNow = useDeck.getState();
    // Checked separately from the collection because the two are restored by
    // different effects and either can land first — this way whichever runs
    // last still leaves both consistent.
    const deckStale = [deckNow.active, ...deckNow.slots]
      .some((slot) => slot.some((id) => !valid0.has(id)));

    if (collectionMatches && !deckStale) return;

    if (!collectionMatches) {
      useCollection.setState({ cards: merged, nextId: merged.length + 1 });
    }

    // Re-point the decks at the cards that now exist. A deck naming ids from
    // the old local set would be eight dangling references, which reads to the
    // player as their deck having been wiped.
    const deck = useDeck.getState();
    const valid = new Set(merged.map((c) => c.id));

    /**
     * Only cards this build can actually field.
     *
     * The coin registry lives on chain and keeps growing; the client ships with
     * whatever list it was built against. A card minted from a coin registered
     * after that build is real, owned, and completely unusable here —
     * `buildDecks` resolves every deck card's mint against `COINS` and returns
     * null on the first miss, which surfaces as "your deck has retired cards"
     * with no way to fix it, because the offending card cannot be rendered on
     * the Deck tab either.
     *
     * Auto-filling a deck with one of those manufactured exactly that dead end.
     * The card stays in the collection — the player does own it — but it is
     * never chosen for them.
     */
    const usable = merged.filter((c) => fieldableMints.has(c.mint));

    const cardById = new Map(merged.map((c) => [c.id, c]));

    /**
     * Re-point one deck slot, preferring cards that actually exist on chain.
     *
     * Keeping whatever was saved is not enough. A staked match requires all
     * eight deck cards to be minted, so a single seeded starter squatting in a
     * slot is the difference between escrow opening and the match dropping to
     * "ladder only" — and that is what happened: a wallet holding ten minted
     * coins queued with seven seeded cards, matched a real opponent, and
     * neither side staked anything. The deck had simply never been rebuilt
     * after they minted, because the saved one was still fillable.
     *
     * So a seeded card is swapped out whenever there is a minted coin free to
     * take its place. Seeded cards remain the fallback for a wallet that has
     * not minted anything — they are what makes the game playable before you
     * spend — but they never hold a slot a real card could occupy.
     */
    const repoint = (slot: string[]): string[] => {
      const kept = slot.filter((id) => valid.has(id) && usable.some((c) => c.id === id));
      const usedMints = new Set(kept.map((id) => cardById.get(id)?.mint));

      // Minted, fieldable, and not already represented — one card per coin.
      const spare = mapped
        .filter((c) => fieldableMints.has(c.mint) && !usedMints.has(c.mint));

      const promoted = kept.map((id) => {
        const card = cardById.get(id);
        if (!card?.seeded) return id;
        const swap = spare.shift();
        if (!swap) return id;
        usedMints.delete(card.mint);
        usedMints.add(swap.mint);
        return swap.id;
      });

      if (promoted.length >= 8) return promoted.slice(0, 8);

      // Still short: fill from anything left, minted first (`merged` is ordered
      // chain-then-seeded), one card per coin.
      for (const c of usable) {
        if (promoted.length >= 8) break;
        if (!promoted.includes(c.id) && !usedMints.has(c.mint)) {
          promoted.push(c.id);
          usedMints.add(c.mint);
        }
      }
      return promoted;
    };

    const slots = deck.slots.map(repoint);
    useDeck.setState({ slots, active: repoint(deck.active) });

    /*
     * Free cards still locked to a match that has already settled.
     *
     * Settlement frees exactly the card accounts it was handed, so a match
     * settled by the other player leaves this wallet's eight cards naming it
     * forever. The deck then cannot be fielded and nothing in the app fixes
     * it — a real wallet was found with eight cards locked to a settled match
     * and no way out short of a script.
     *
     * The program lets anyone pay for `release_cards` once a match is settled,
     * so the client can clean up after itself without the opponent online.
     * Best-effort and never awaited: it is housekeeping, and a failure leaves
     * exactly the state that was already there.
     */
    // No release step: a card is locked only while the match holding it is
    // live, so settling a match frees its cards in the same transaction.
  }, [cards, mode]);
}
