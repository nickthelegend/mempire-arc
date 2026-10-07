#!/usr/bin/env node
// Real game activity on the LOCAL arc-anvil fork of Arc testnet, for the
// indexer to index.
//
//   node scripts/seed-local.mjs            # needs the fork :8710 + relay :8799 (scripts/local-up.sh)
//
// Two fresh wallets, funded with USDC (Arc's native gas token, which is also
// the ERC-20 at 0x3600…0000) from anvil account #0, onboarded through the
// relay (signed POST /api/onboard: 8-card starter deck), then:
//   1. a USDC Pauper match: A creates with an EIP-2612 permit (seat 0), B joins
//      with an approve (seat 1); plays + a checkpoint from each seat; both claim
//      seat 0 → settled (pot − rake to A, win reward, chest)
//   2. a second USDC Pauper match: B creates with an approve, A joins with a
//      permit, both arming session keys funded by the create/join value; plays
//      + checkpoints from the session keys; the claims disagree → void
//   3. A's chest: startUnlock → wait the real timer (or `skip` with $MEMPIRE if
//      the tier's timer is long) → open → mine 2 blocks → reveal
//   4. a merge, buying golden chests (no timer) until a drop duplicates a coin
//
// Everything it did is written to .local/seed-manifest.json, which
// scripts/verify-local.mjs checks against the indexer.
//
// Env: MEMPIRE_RPC (http://127.0.0.1:8710), MEMPIRE_RELAY (http://localhost:8799),
//      SEED_MAX_WAIT seconds to wait on a chest timer before skipping it (60).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  hashDomain,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  parseSignature,
  stringToHex,
  zeroAddress,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const indexerDir = join(here, "..");
const repoDir = join(indexerDir, "..");
const RPC = process.env.MEMPIRE_RPC ?? "http://127.0.0.1:8710";
const RELAY = process.env.MEMPIRE_RELAY ?? "http://localhost:8799";
const MAX_WAIT = Number(process.env.SEED_MAX_WAIT ?? 60);
const MNEMONIC = "test test test test test test test test test test test junk";

const dep = JSON.parse(readFileSync(join(repoDir, "shared/deployments/31337.json"), "utf8"));
const abi = (name) => JSON.parse(readFileSync(join(repoDir, "shared/abi", `${name}.json`), "utf8"));
const cardsAbi = abi("MempireCards");
const arenaAbi = abi("MempireArena");
const metaAbi = abi("MarketMeta");
const tokenAbi = abi("MempireToken");
/** Arc's USDC (FiatToken): ERC-20 + EIP-2612, EIP-712 domain "USDC" / "2". */
const USDC = dep.usdc ?? "0x3600000000000000000000000000000000000000";
const usdcAbi = [
  ...erc20Abi,
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
];

/** The fork: chain 31337, gas paid in native USDC (18 decimals natively). */
const chain = {
  id: 31337,
  name: "Arc testnet fork",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
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

/** Native value on Arc is USDC: `usdc` whole dollars arrive as gas money and as ERC-20 balance. */
async function fund(to, usdc) {
  const hash = await wallet(funder).sendTransaction({ to, value: parseEther(usdc) });
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

/**
 * USDC's EIP-712 domain. FiatToken's separator binds a chain id; on a fork it
 * may still carry Arc testnet's (5042002) rather than the fork's 31337, so the
 * one that reproduces DOMAIN_SEPARATOR() on chain is used.
 */
let usdcDomain;
async function usdcPermitDomain() {
  if (usdcDomain) return usdcDomain;
  const onchain = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: "DOMAIN_SEPARATOR" });
  for (const chainId of [await pub.getChainId(), 5042002, 5042]) {
    const domain = { name: "USDC", version: "2", chainId, verifyingContract: USDC };
    if (hashDomain({ domain, types: { EIP712Domain: [
      { name: "name", type: "string" }, { name: "version", type: "string" },
      { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    ] } }) === onchain) return (usdcDomain = domain);
  }
  throw new Error(`USDC DOMAIN_SEPARATOR ${onchain} matches no known domain — is ${RPC} an Arc fork?`);
}

/** An EIP-2612 permit for the arena to pull `value` USDC (6 decimals). */
async function usdcPermit(account, value) {
  const nonce = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: "nonces", args: [account.address] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const signature = await account.signTypedData({
    domain: await usdcPermitDomain(),
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
const forkChainId = await pub.getChainId().catch(() => {
  throw new Error(`the arc-anvil fork is not reachable at ${RPC} — run scripts/local-up.sh`);
});
if (forkChainId !== 31337) throw new Error(`${RPC} is chain ${forkChainId}, not the local fork (31337)`);
const health = await fetch(`${RELAY}/api/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) throw new Error(`the relay is not reachable at ${RELAY} — run scripts/local-up.sh`);

const keys = { A: generatePrivateKey(), B: generatePrivateKey(), sessionA: generatePrivateKey(), sessionB: generatePrivateKey() };
const A = privateKeyToAccount(keys.A);
const B = privateKeyToAccount(keys.B);
const sessionA = privateKeyToAccount(keys.sessionA);
const sessionB = privateKeyToAccount(keys.sessionB);
const startBlock = await pub.getBlockNumber();
log(`players  A ${A.address}\n         B ${B.address}`);

// Onboard (starter deck, plus the relay's test-chain USDC drip if configured),
// then top up USDC for gas, stakes and session-key floats.
for (const [name, acct] of [["A", A], ["B", B]]) {
  const o = await onboard(acct);
  log(`onboard  ${name}: starter ${o.starter}, usdc ${o.usdc}`);
  await fund(acct.address, "20");
}
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
const stake = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: "stakeFor", args: [0] }); // Pauper: 1 USDC

// ── 1. USDC Pauper, settled: A (seat 0, permit) beats B (seat 1, approve) ──
const created1 = await send(A, dep.arena, arenaAbi, "createMatch", [0, deckA, zeroAddress, await usdcPermit(A, stake)]);
const m1 = eventOf(created1, "MatchCreated").args.matchId;
await send(B, USDC, usdcAbi, "approve", [dep.arena, stake]);
const joined1 = await send(B, dep.arena, arenaAbi, "joinMatch", [m1, deckB, zeroAddress, NO_PERMIT]);
const metaEpoch1 = eventOf(joined1, "MatchJoined").args.metaEpoch;
log(`match ${m1}  USDC Pauper, stake ${stake}, meta epoch ${metaEpoch1}`);
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

// ── 2. USDC Pauper, void: B creates (seat 0, approve), A joins (seat 1, permit),
//       session keys play (their gas float rides on msg.value), claims disagree ──
const sessionGas = parseEther("0.2"); // 0.2 USDC of native gas; the arena caps it at 0.25
await send(B, USDC, usdcAbi, "approve", [dep.arena, stake]);
const created2 = await send(B, dep.arena, arenaAbi, "createMatch", [0, deckB, sessionB.address, NO_PERMIT], sessionGas);
const m2 = eventOf(created2, "MatchCreated").args.matchId;
const joined2 = await send(A, dep.arena, arenaAbi, "joinMatch", [m2, deckA, sessionA.address, await usdcPermit(A, stake)], sessionGas);
const metaEpoch2 = eventOf(joined2, "MatchJoined").args.metaEpoch;
log(`match ${m2}  USDC Pauper, stake ${stake}, session keys, meta epoch ${metaEpoch2}`);
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
  contracts: { cards: dep.cards, arena: dep.arena, marketMeta: dep.marketMeta, usdc: USDC },
  players: { A: A.address.toLowerCase(), B: B.address.toLowerCase() },
  sessions: { A: sessionA.address.toLowerCase(), B: sessionB.address.toLowerCase() },
  decks: { A: deckA, B: deckB },
  deckCoins: { A: coinsA, B: coinsB },
  rakeBps,
  metaEpochAtStart,
  metaEpochNow,
  match1: {
    id: m1, currency: "USDC", tier: 0, stake, seat0: "A", seat1: "B", metaEpoch: metaEpoch1,
    pot: settled.args.pot, rake: settled.args.rake, winnerSeat: 0, final: final1,
    plays: [...s1a.plays, ...s1b.plays], checkpoints: [s1a.checkpoint, s1b.checkpoint],
    claimTxs: [claimA1.hash, settle1.hash],
    chest: granted ? { id: granted.args.chestId, tier: Number(granted.args.tier) } : null,
    reward: rewarded ? rewarded.args.amount : 0n,
  },
  match2: {
    id: m2, currency: "USDC", tier: 0, stake, seat0: "B", seat1: "A", metaEpoch: metaEpoch2,
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
