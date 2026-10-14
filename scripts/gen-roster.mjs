#!/usr/bin/env node
/**
 * Writes shared/roster.json: the fighters, one per Chainlink Data Feed on Arc mainnet.
 *
 *   node scripts/gen-roster.mjs [path/to/feeds-arc-mainnet.json]
 *
 * Source: Chainlink's reference data directory for Arc mainnet
 * (https://reference-data-directory.vercel.app/feeds-arc-mainnet.json). Every
 * fighter is an asset with a live Chainlink feed on Arc — majors, DeFi tokens,
 * gold (PAXG) and fiat currencies — so every price the game reads on chain is
 * Chainlink's. Stablecoins, exchange-rate and reserve feeds are not fighters,
 * and USD/ARS is left out because its quote is inverted (a falling peso reads
 * as a rising feed).
 *
 * feedId = keccak256(pair), e.g. keccak256("BTC / USD"): the asset's identity on
 * every chain (the archetype is derived from it on chain), independent of the
 * feed's proxy address, which differs per chain and can migrate.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { keccak256, toBytes } = require('viem');

const FIGHTERS = [
  // ticker, feed name, display name, kind, coingeckoId, hue
  ['BTC', 'BTC / USD', 'Bitcoin', 'crypto', 'bitcoin', 38],
  ['ETH', 'ETH / USD', 'Ether', 'crypto', 'ethereum', 230],
  ['SOL', 'SOL / USD', 'Solana', 'crypto', 'solana', 280],
  ['BNB', 'BNB / USD', 'BNB', 'crypto', 'binancecoin', 48],
  ['XRP', 'XRP / USD', 'XRP', 'crypto', 'ripple', 210],
  ['AVAX', 'AVAX / USD', 'Avalanche', 'crypto', 'avalanche-2', 0],
  ['TRX', 'TRX / USD', 'Tron', 'crypto', 'tron', 355],
  ['BCH', 'BCH / USD', 'Bitcoin Cash', 'crypto', 'bitcoin-cash', 130],
  ['HYPE', 'HYPE / USD', 'Hyperliquid', 'crypto', 'hyperliquid', 165],
  ['LINK', 'LINK / USD', 'Chainlink', 'defi', 'chainlink', 222],
  ['UNI', 'UNI / USD', 'Uniswap', 'defi', 'uniswap', 330],
  ['AAVE', 'AAVE / USD', 'Aave', 'defi', 'aave', 270],
  ['PAXG', 'PAXG / USD', 'Gold (PAXG)', 'rwa', 'pax-gold', 45],
  ['EUR', 'EUR / USD', 'Euro', 'rwa', null, 215],
  ['JPY', 'JPY / USD', 'Japanese Yen', 'rwa', null, 350],
  ['AUD', 'AUD / USD', 'Australian Dollar', 'rwa', null, 140],
  ['CAD', 'CAD / USD', 'Canadian Dollar', 'rwa', null, 5],
  ['MXN', 'MXN / USD', 'Mexican Peso', 'rwa', null, 120],
  ['BRL', 'BRL / USD', 'Brazilian Real', 'rwa', null, 95],
  ['KRW', 'KRW / USD', 'Korean Won', 'rwa', null, 200],
];

// Chainlink heartbeat is 24 h on Arc; allow 2 h of grace for crypto (traded
// around the clock) and four days for FX, whose feeds can sit through a closed
// weekend without a deviation update.
const AGE = { crypto: 26 * 3600, defi: 26 * 3600, rwa: 4 * 86400 };

const src = process.argv[2] ?? '/private/tmp/claude-501/-Volumes-Extreme-SSD-Projects-arc/bc4eb9da-5e94-4401-9bc1-84adcfe8acf7/scratchpad/feeds-arc-mainnet.json';
const feeds = JSON.parse(readFileSync(src, 'utf8'));
const byName = new Map(feeds.map((f) => [f.name, f]));
const art = (t) => existsSync(new URL(`../app/public/art/card_${t.toLowerCase()}.svg`, import.meta.url)) || existsSync(new URL(`../app/public/art/card_${t.toLowerCase()}.webp`, import.meta.url));

const coins = FIGHTERS.map(([ticker, pair, name, kind, coingeckoId, hue], coinId) => {
  const f = byName.get(pair);
  if (!f) throw new Error(`no Arc mainnet feed named "${pair}"`);
  return {
    coinId, ticker, name, kind, pair,
    feedId: keccak256(toBytes(pair)),
    feed: f.proxyAddress, // the Arc mainnet proxy (testnet deploys a MirrorAggregator of it)
    decimals: f.decimals,
    heartbeat: Number(f.heartbeat),
    maxPriceAge: AGE[kind],
    coingeckoId, hue, hasArt: art(ticker),
  };
});

const out = {
  chainId: 5042002,
  builtAt: new Date().toISOString(),
  source: 'Chainlink Data Feeds on Arc mainnet (reference-data-directory feeds-arc-mainnet.json); feedId = keccak256(pair)',
  coins,
};
writeFileSync(new URL('../shared/roster.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
const arch = coins.map((c) => Number(BigInt(keccak256(c.feedId)) % 6n));
console.log(`roster: ${coins.length} fighters · archetypes ${JSON.stringify(arch.reduce((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {}))}`);
