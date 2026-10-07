#!/usr/bin/env node
// Real game activity on the LOCAL anvil chain, for the indexer to index.
//
//   node scripts/seed-local.mjs            # needs anvil :8612 + relay :8799 (scripts/local-up.sh --relay)
//
// Two fresh wallets, funded with MON from anvil account #0, onboarded through
// the relay (signed POST /api/onboard: 8-card starter deck, AUSD, MON drip),
// then:
//   1. an AUSD Pauper match: A creates with an EIP-2612 permit (seat 0), B joins
//      with an approve (seat 1); plays + a checkpoint from each seat; both claim
//      seat 0 → settled (pot − rake to A, win reward, chest)
//   2. a MON Pauper match: B creates, A joins, both through session keys
//      funded by the create/join; plays + checkpoints; the claims disagree → void
//   3. A's chest: startUnlock → wait the real timer (or `skip` with $MEMPIRE if
//      the tier's timer is long) → open → mine 2 blocks → reveal
//   4. a merge, buying golden chests (no timer) until a drop duplicates a coin
//
// Everything it did is written to .local/seed-manifest.json, which
// scripts/verify-local.mjs checks against the indexer.
//
// Env: MEMPIRE_RPC (http://127.0.0.1:8612), MEMPIRE_RELAY (http://localhost:8799),
//      SEED_MAX_WAIT seconds to wait on a chest timer before skipping it (60).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  parseSignature,
  stringToHex,
  zeroAddress,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const here = dirname(fileURLToPath(import.meta.url));
const indexerDir = join(here, "..");
const repoDir = join(indexerDir, "..");
const RPC = process.env.MEMPIRE_RPC ?? "http://127.0.0.1:8612";
const RELAY = process.env.MEMPIRE_RELAY ?? "http://localhost:8799";
const MAX_WAIT = Number(process.env.SEED_MAX_WAIT ?? 60);
const MNEMONIC = "test test test test test test test test test test test junk";

const dep = JSON.parse(readFileSync(join(repoDir, "shared/deployments/31337.json"), "utf8"));
const abi = (name) => JSON.parse(readFileSync(join(repoDir, "shared/abi", `${name}.json`), "utf8"));
const cardsAbi = abi("MempireCards");
const arenaAbi = abi("MempireArena");
const metaAbi = abi("MarketMeta");
const tokenAbi = abi("MempireToken");
const ausdAbi = [
  ...erc20Abi,
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "eip712Domain", stateMutability: "view", inputs: [], outputs: [
    { type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" },
  ] },
];
/** Agora's testnet faucet (present on the fork): `requestFunds(to)`, one call per cooldown. */
const faucetAbi = [{ type: "function", name: "requestFunds", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }], outputs: [] }];

const chain = { ...foundry, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (account) => createWalletClient({ account, chain, transport: http(RPC) });

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

/** Send a contract write (viem estimates gas), wait for it, and return the receipt + decoded logs. */
async function send(account, address, contractAbi, functionName, args = [], value = 0n) {
  const hash = await wallet(account).writeContract({ address, abi: contractAbi, functionName, args, value });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  const events = parseEventLogs({ abi: [...cardsAbi, ...arenaAbi, ...metaAbi], logs: receipt.logs });
  return { hash, receipt, events, block: receipt.blockNumber };
}
const eventOf = (r, name) => r.events.find((e) => e.eventName === name);

async function fund(to, mon) {
  const hash = await wallet(funder).sendTransaction({ to, value: parseEther(mon) });
  await pub.waitForTransactionReceipt({ hash });
}

async function onboard(account) {
  const ts = Date.now();
  const message = `Mempire\naction: onboard\nwallet: ${account.address}\nts: ${ts}`;
  const signature = await account.signMessage({ message });
  const res = await fetch(`${RELAY}/api/onboard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: account.address, ts, signature }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.starter !== "minted" && body.starter !== "already") {
    throw new Error(`onboard ${account.address}: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function deckOf(address) {
  const [ids, data, locked] = await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: "cardsOf", args: [address] });
  const deck = [];
  const seen = new Set();
  for (let i = 0; i < ids.length && deck.length < 8; i++) {
    if (locked[i] || seen.has(data[i].coinId)) continue;
    seen.add(data[i].coinId);
    deck.push(ids[i]);
  }
  if (deck.length !== 8) throw new Error(`${address} has no 8-card deck (${ids.length} cards)`);
  return deck;
}

/** An EIP-2612 permit for the arena to pull `value` AUSD. */
async function ausdPermit(account, value) {
  const nonce = await pub.readContract({ address: dep.ausd, abi: ausdAbi, functionName: "nonces", args: [account.address] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  // The token's own EIP-712 domain — Agora's is "Agora Dollar", not the symbol.
  const [, name, version, chainId, verifyingContract] = await pub.readContract({ address: dep.ausd, abi: ausdAbi, functionName: "eip712Domain" });
  const signature = await account.signTypedData({
    domain: { name, version, chainId: Number(chainId), verifyingContract },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: account.address, spender: dep.arena, value, nonce, deadline },
  });
  const { v, r, s } = parseSignature(signature);
  return { deadline, v: Number(v), r, s };
}
const NO_PERMIT = { deadline: 0n, v: 0, r: `0x${"0".repeat(64)}`, s: `0x${"0".repeat(64)}` };

/** Plays and one checkpoint from a seat; returns what was sent. */
async function playSeat(sender, matchId, seat, moves, checkpointTick) {
  const plays = [];
  for (const [tick, cardIndex, x, y] of moves) {
    const r = await send(sender, dep.arena, arenaAbi, "play", [matchId, tick, cardIndex, x, y]);
    plays.push({ seat, tick, cardIndex, x, y, txHash: r.hash });
  }
  const stateHash = BigInt.asUintN(64, BigInt(keccak256(stringToHex(`m${matchId}-s${seat}-t${checkpointTick}`))));
  const c = await send(sender, dep.arena, arenaAbi, "checkpoint", [matchId, checkpointTick, stateHash]);
  return { plays, checkpoint: { seat, tick: checkpointTick, stateHash, txHash: c.hash } };
}

const mine = (n) => pub.request({ method: "anvil_mine", params: [`0x${n.toString(16)}`] });

/** open → mine → reveal. Returns the dropped card ids. */
async function openAndReveal(account, chestId, favored) {
  const o = await send(account, dep.cards, cardsAbi, "open", [chestId]);
  const revealBlock = eventOf(o, "ChestOpening").args.revealBlock;
  await mine(2);
  const r = await send(account, dep.cards, cardsAbi, "reveal", [chestId, favored]);
  const opened = eventOf(r, "ChestOpened");
  if (!opened) throw new Error(`chest ${chestId} re-committed instead of opening`);
  return { revealBlock, openTx: o.hash, revealTx: r.hash, drops: opened.args.cardIds };
}

// ─────────────────────────────────────────────────────────────── run

const funder = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
await pub.getChainId().catch(() => {
  throw new Error(`anvil is not reachable at ${RPC} — run scripts/local-up.sh --relay`);
});
const health = await fetch(`${RELAY}/api/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) throw new Error(`the relay is not reachable at ${RELAY} — run scripts/local-up.sh --relay`);

const keys = { A: generatePrivateKey(), B: generatePrivateKey(), sessionA: generatePrivateKey(), sessionB: generatePrivateKey() };
const A = privateKeyToAccount(keys.A);
const B = privateKeyToAccount(keys.B);
const sessionA = privateKeyToAccount(keys.sessionA);
const sessionB = privateKeyToAccount(keys.sessionB);
const startBlock = await pub.getBlockNumber();
log(`players  A ${A.address}\n         B ${B.address}`);

// Onboard (starter deck + AUSD + MON drip), then top up MON for gas and stakes.
for (const [name, acct] of [["A", A], ["B", B]]) {
  const o = await onboard(acct);
  log(`onboard  ${name}: starter ${o.starter}, ausd ${o.ausd}, mon ${o.mon}`);
  await fund(acct.address, "2");
}
// AUSD: the real faucet pays one onboard per cooldown, so usually one of the
// two holds 10,000 and the other is queued. Whoever holds it sends the other
// 100; if neither was paid yet, ask the faucet directly until its cooldown ends.
const ausdOf = (a) => pub.readContract({ address: dep.ausd, abi: ausdAbi, functionName: "balanceOf", args: [a.address] });
for (let i = 0; (await ausdOf(A)) + (await ausdOf(B)) < 200_000_000n; i += 1) {
  if (i >= 20) throw new Error("the AUSD faucet never paid — is AUSD_FAUCET set on the relay, and is this a fork of Monad testnet?");
  try {
    await send(funder, dep.ausdFaucet ?? "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C", faucetAbi, "requestFunds", [A.address]);
    log("ausd     faucet paid A directly");
  } catch {
    await new Promise((r) => setTimeout(r, 5000)); // inside the cooldown
  }
}
const [rich, poor] = (await ausdOf(A)) >= (await ausdOf(B)) ? [A, B] : [B, A];
if ((await ausdOf(poor)) < 10_000_000n) await send(rich, dep.ausd, ausdAbi, "transfer", [poor.address, 100_000_000n]);
// $MEMPIRE for the merge fee and any chest skip / purchase.
await send(funder, dep.token, tokenAbi, "transfer", [A.address, parseEther("2000")]);
await send(A, dep.token, tokenAbi, "approve", [dep.cards, parseEther("2000")]);

const deckA = await deckOf(A.address);
const deckB = await deckOf(B.address);
const cardInfo = async (id) => pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: "card", args: [id] });
const coinsA = await Promise.all(deckA.map(async (id) => Number((await cardInfo(id)).coinId)));
const coinsB = await Promise.all(deckB.map(async (id) => Number((await cardInfo(id)).coinId)));
const rakeBps = BigInt(await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: "rakeBps" }));
const metaEpochAtStart = await pub.readContract({ address: dep.marketMeta, abi: metaAbi, functionName: "currentEpoch" });

// ── 1. AUSD Pauper, settled: A (seat 0, permit) beats B (seat 1, approve) ──
const ausdStake = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: "stakeFor", args: [dep.ausd, 0] });
const created1 = await send(A, dep.arena, arenaAbi, "createMatch", [0, dep.ausd, deckA, zeroAddress, await ausdPermit(A, ausdStake)]);
const m1 = eventOf(created1, "MatchCreated").args.matchId;
await send(B, dep.ausd, ausdAbi, "approve", [dep.arena, ausdStake]);
const joined1 = await send(B, dep.arena, arenaAbi, "joinMatch", [m1, deckB, zeroAddress, NO_PERMIT]);
const metaEpoch1 = eventOf(joined1, "MatchJoined").args.metaEpoch;
log(`match ${m1}  AUSD Pauper, stake ${ausdStake}, meta epoch ${metaEpoch1}`);
const s1a = await playSeat(A, m1, 0, [[40, 0, -120, -300], [130, 3, 80, -260], [260, 5, 0, -200]], 300);
const s1b = await playSeat(B, m1, 1, [[55, 1, 100, 300], [190, 2, -60, 280], [310, 7, 20, 220]], 320);
const final1 = keccak256(stringToHex(`match-${m1}-seat0-wins`));
const claimA1 = await send(A, dep.arena, arenaAbi, "claim", [m1, 0, final1]);
const settle1 = await send(B, dep.arena, arenaAbi, "claim", [m1, 0, final1]);
const settled = eventOf(settle1, "MatchSettled");
if (!settled) throw new Error(`match ${m1} did not settle`);
const granted = eventOf(settle1, "ChestGranted");
const rewarded = eventOf(settle1, "WinRewarded");
log(`         settled: pot ${settled.args.pot}, rake ${settled.args.rake}, chest ${granted ? `#${granted.args.chestId} tier ${granted.args.tier}` : "none"}, reward ${rewarded ? rewarded.args.amount : 0n}`);

// ── 2. MON Pauper, void: B creates (seat 0), A joins (seat 1), session keys play, claims disagree ──
const monStake = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: "stakeFor", args: [zeroAddress, 0] });
const sessionGas = parseEther("0.05");
const created2 = await send(B, dep.arena, arenaAbi, "createMatch", [0, zeroAddress, deckB, sessionB.address, NO_PERMIT], monStake + sessionGas);
const m2 = eventOf(created2, "MatchCreated").args.matchId;
const joined2 = await send(A, dep.arena, arenaAbi, "joinMatch", [m2, deckA, sessionA.address, NO_PERMIT], monStake + sessionGas);
const metaEpoch2 = eventOf(joined2, "MatchJoined").args.metaEpoch;
log(`match ${m2}  MON Pauper, stake ${monStake}, session keys, meta epoch ${metaEpoch2}`);
const s2b = await playSeat(sessionB, m2, 0, [[30, 4, 0, -280], [150, 6, -90, -240]], 200);
const s2a = await playSeat(sessionA, m2, 1, [[45, 0, 40, 290], [170, 1, 110, 250]], 210);
const claimB2 = await send(sessionB, dep.arena, arenaAbi, "claim", [m2, 0, keccak256(stringToHex(`match-${m2}-b`))]);
const void2 = await send(sessionA, dep.arena, arenaAbi, "claim", [m2, 1, keccak256(stringToHex(`match-${m2}-a`))]);
if (!eventOf(void2, "MatchVoided")) throw new Error(`match ${m2} did not void`);
log(`         voided (disputed): both stakes refunded`);

// ── 3. A's chest from the win ──
let chest = null;
if (granted) {
  const chestId = granted.args.chestId;
  const tier = Number(granted.args.tier);
  const secs = await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: "unlockSeconds", args: [tier] });
  const unlock = await send(A, dep.cards, cardsAbi, "startUnlock", [chestId]);
  const readyAt = Number(eventOf(unlock, "ChestUnlocking").args.readyAt);
  let skipped = false;
  if (Number(secs) > MAX_WAIT) {
    await send(A, dep.cards, cardsAbi, "skip", [chestId]);
    skipped = true;
    log(`chest #${chestId}  tier ${tier}: ${secs}s timer > ${MAX_WAIT}s, skipped with $MEMPIRE`);
  } else {
    log(`chest #${chestId}  tier ${tier}: waiting the real ${secs}s timer`);
    // anvil stamps the next block with the wall clock: poll `open` as a call until it would pass.
    for (;;) {
      try {
        await pub.simulateContract({ account: A, address: dep.cards, abi: cardsAbi, functionName: "open", args: [chestId] });
        break;
      } catch {
        await sleep(2000);
      }
    }
  }
  const opened = await openAndReveal(A, chestId, coinsA);
  chest = { id: chestId, tier, unlockSeconds: secs, readyAt, skipped, ...opened };
  log(`         opened at reveal block ${opened.revealBlock}: drops ${opened.drops.join(", ")}`);
}

// ── 4. A merge: a dropped duplicate into the deck card of the same coin ──
const bought = [];
let merge = null;
for (let attempt = 0; attempt <= 4 && !merge; attempt++) {
  const [ids, data, locked] = await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: "cardsOf", args: [A.address] });
  const byCoin = new Map();
  for (let i = 0; i < ids.length; i++) {
    if (locked[i]) continue;
    const c = Number(data[i].coinId);
    byCoin.set(c, [...(byCoin.get(c) ?? []), { id: ids[i], level: Number(data[i].level) }]);
  }
  const pair = [...byCoin.values()].find((cs) => cs.length >= 2);
  if (pair) {
    const [keep, dupe] = pair.sort((a, b) => b.level - a.level || Number(a.id - b.id));
    const r = await send(A, dep.cards, cardsAbi, "merge", [keep.id, dupe.id]);
    const ev = eventOf(r, "CardMerged").args;
    merge = { keep: keep.id, burned: dupe.id, coinId: Number(data[ids.indexOf(keep.id)].coinId), newLevel: Number(ev.level), paid: ev.paid, txHash: r.hash };
    log(`merge    card ${keep.id} ← ${dupe.id}: level ${ev.level}, paid ${ev.paid}`);
    break;
  }
  if (attempt === 4) break;
  // No duplicate yet: buy a golden chest (no timer) and open it, favouring A's coins.
  const b = await send(A, dep.cards, cardsAbi, "buyChest");
  const id = eventOf(b, "ChestGranted").args.chestId;
  const opened = await openAndReveal(A, id, coinsA);
  bought.push({ id, ...opened });
  log(`buy      golden chest #${id}: drops ${opened.drops.join(", ")}`);
}
if (!merge) log("merge    no duplicate after 4 bought chests — skipped");

const endBlock = await pub.getBlockNumber();
const metaEpochNow = await pub.readContract({ address: dep.marketMeta, abi: metaAbi, functionName: "currentEpoch" });
const manifest = {
  chainId: chain.id,
  createdAt: new Date().toISOString(),
  startBlock,
  endBlock,
  contracts: { cards: dep.cards, arena: dep.arena, marketMeta: dep.marketMeta, ausd: dep.ausd },
  players: { A: A.address.toLowerCase(), B: B.address.toLowerCase() },
  sessions: { A: sessionA.address.toLowerCase(), B: sessionB.address.toLowerCase() },
  decks: { A: deckA, B: deckB },
  deckCoins: { A: coinsA, B: coinsB },
  rakeBps,
  metaEpochAtStart,
  metaEpochNow,
  match1: {
    id: m1, currency: "AUSD", tier: 0, stake: ausdStake, seat0: "A", seat1: "B", metaEpoch: metaEpoch1,
    pot: settled.args.pot, rake: settled.args.rake, winnerSeat: 0, final: final1,
    plays: [...s1a.plays, ...s1b.plays], checkpoints: [s1a.checkpoint, s1b.checkpoint],
    claimTxs: [claimA1.hash, settle1.hash],
    chest: granted ? { id: granted.args.chestId, tier: Number(granted.args.tier) } : null,
    reward: rewarded ? rewarded.args.amount : 0n,
  },
  match2: {
    id: m2, currency: "MON", tier: 0, stake: monStake, seat0: "B", seat1: "A", metaEpoch: metaEpoch2,
    plays: [...s2b.plays, ...s2a.plays], checkpoints: [s2b.checkpoint, s2a.checkpoint],
    claims: [0, 1], claimTxs: [claimB2.hash, void2.hash],
  },
  chest,
  boughtChests: bought,
  merge,
};
mkdirSync(join(indexerDir, ".local"), { recursive: true });
writeFileSync(join(indexerDir, ".local/seed-manifest.json"), json(manifest));
log(`blocks   ${startBlock} → ${endBlock}; manifest .local/seed-manifest.json`);
log("next     node scripts/verify-local.mjs");
