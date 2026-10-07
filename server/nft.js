/**
 * ERC-721 metadata for Mempire fighters.
 *
 * `MempireCards.tokenURI(id)` is `baseURI + id`, and the deployment points
 * `baseURI` here (`…/nft/`). Wallets and marketplaces fetch this JSON to show
 * a card, so it is read from the chain on every request: a card's level
 * changes when a duplicate is merged into it, and a cached level would be a
 * marketplace listing that lies about what is for sale.
 *
 * A burned or never-minted id is a 404, not an empty card. `merge` burns the
 * duplicate and deletes its struct, so `card(id)` would happily return a
 * level-0 coin-0 card for it; `ownerOf` reverting is the actual test.
 */
import { BaseError, ContractFunctionRevertedError, formatUnits } from 'viem';
import { ARCHETYPE_NAMES, abis, coinById, deployment, publicClient } from './chain.js';

const APP_URL = (process.env.PUBLIC_APP_URL || 'https://mempire.fun').replace(/\/+$/, '');
const MAX_LEVEL = 10;

const KIND_PHRASE = {
  crypto: 'a major crypto asset',
  meme: 'a memecoin',
  stock: 'a tokenised stock',
};

/** True when the call reached the contract and the contract said no. */
function reverted(e) {
  return e instanceof BaseError && Boolean(e.walk((x) => x instanceof ContractFunctionRevertedError));
}

/** A Pyth price at its exponent, exactly — 18742000000 at -8 is "187.42". */
function formatPrice(price, expo) {
  const p = BigInt(price);
  return expo < 0 ? formatUnits(p, -expo) : (p * 10n ** BigInt(expo)).toString();
}

export function registerNftRoutes(app, gate) {
  const pass = (_req, _res, next) => next();
  app.get('/nft/:id', gate ?? pass, async (req, res) => {
    const raw = String(req.params.id ?? '');
    if (!/^\d{1,30}$/.test(raw) || BigInt(raw) === 0n) return res.status(404).json({ error: 'no such card' });
    if (!deployment) return res.status(503).json({ error: 'no contracts deployed on this chain' });
    const id = BigInt(raw);
    const client = publicClient();
    const read = (functionName) => client.readContract({
      address: deployment.cards, abi: abis.cards, functionName, args: [id],
    });

    let card;
    try {
      await read('ownerOf');
      card = await read('card');
    } catch (e) {
      if (reverted(e)) return res.status(404).json({ error: 'no such card' });
      return res.status(502).json({ error: 'could not read the chain' });
    }

    const coin = coinById.get(Number(card.coinId));
    const ticker = coin?.ticker ?? `COIN${card.coinId}`;
    const level = Number(card.level);
    const archetype = ARCHETYPE_NAMES[Number(card.archetype)] ?? 'Unknown';
    const attributes = [
      { trait_type: 'Ticker', value: ticker },
      { trait_type: 'Kind', value: coin?.kind ?? 'unknown' },
      { trait_type: 'Level', value: level, display_type: 'number', max_value: MAX_LEVEL },
      { trait_type: 'Archetype', value: archetype },
    ];
    // Starter and chest cards record no price; only a card minted against a
    // live Pyth update carries one.
    if (BigInt(card.mintPrice) !== 0n) {
      attributes.push({ trait_type: 'Mint price (USD)', value: formatPrice(card.mintPrice, Number(card.mintExpo)) });
    }

    res.set('cache-control', 'public, max-age=60');
    res.json({
      name: `$${ticker} · Lv ${level}`,
      description: `A Mempire fighter for ${coin?.name ?? ticker} (${ticker}), ${KIND_PHRASE[coin?.kind] ?? 'an asset'} — `
        + `a ${archetype.toLowerCase()} card at level ${level} of ${MAX_LEVEL}. `
        + 'Levels are earned by merging duplicates won from chests, never bought.',
      image: `${APP_URL}/art/card_${ticker.toLowerCase()}.png`,
      external_url: APP_URL,
      attributes,
    });
  });
}
