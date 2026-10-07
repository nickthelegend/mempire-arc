/**
 * Shared plumbing for the relay's test scripts: signing, a self-started relay,
 * and the pass/fail tally every suite prints.
 *
 * Signing is the part that has to be right. Every write route is
 * signature-authenticated, and a test that posts unsigned bodies is testing
 * the 401 path and nothing else — which is exactly how the previous suites
 * drifted into asserting behaviour the server no longer had.
 */
import { spawn } from 'node:child_process';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

/** The exact text the relay verifies (see `authMessage` in auth.js). */
export const authMessage = (address, action, ts) => `Mempire\naction: ${action}\nwallet: ${address}\nts: ${ts}`;

/** A fresh throwaway wallet. */
export const freshAccount = () => privateKeyToAccount(generatePrivateKey());

/**
 * A local-fork dev key, derived from anvil's public test mnemonic at index
 * 7100 + i (so no key literal lives in this repo, and none of the #0–#9
 * accounts Arc testnet has swept or blocklisted). Local forks only: i = 0 deploys,
 * 1 is the relayer and 4 the oracle signer that DeployLocal registers.
 */
export const DEV_MNEMONIC = 'test test test test test test test test test test test junk';
export const DEV_BASE = 7100;
export function devKey(i) {
  const pk = mnemonicToAccount(DEV_MNEMONIC, { addressIndex: DEV_BASE + i }).getHdKey().privateKey;
  return `0x${Buffer.from(pk).toString('hex')}`;
}

/** `{ address, ts, signature }` for `action`, merged over `body`. */
export async function signed(account, action, body = {}, address = account.address) {
  const ts = Date.now();
  const signature = await account.signMessage({ message: authMessage(address, action, ts) });
  return { ...body, address, ts, signature };
}

export function tally() {
  let pass = 0;
  let fail = 0;
  const check = (label, ok, detail = '') => {
    if (ok) pass += 1; else fail += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };
  const done = () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    return fail;
  };
  return { check, done };
}

export function client(API) {
  return async function req(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, data, headers: res.headers };
  };
}

/**
 * Starts `index.js` on `port` with `env` (no MONGODB_URI, so the in-memory
 * store) and resolves once `/api/health` answers. `stop()` kills it; the
 * process is also killed if the test exits first, so a failed run never
 * leaves a relay holding the port.
 */
export async function startRelay(port, env = {}) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: new URL('.', import.meta.url),
    env: { PATH: process.env.PATH, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
  process.on('exit', kill);

  const base = `http://127.0.0.1:${port}`;
  // A cold boot off a busy external disk can take 30 s (viem alone is ~10 s to
  // import), so wait generously — and fail loudly rather than carry on.
  let up = false;
  for (let i = 0; i < 480 && !up; i += 1) {
    if (child.exitCode !== null) throw new Error(`relay exited during boot:\n${log}`);
    try {
      up = (await fetch(`${base}/api/health`)).ok;
    } catch { /* not listening yet */ }
    if (!up) await new Promise((r) => { setTimeout(r, 250); });
  }
  if (!up) { kill(); throw new Error(`relay did not answer /api/health within 120 s:\n${log}`); }
  return {
    base,
    log: () => log,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGTERM');
    }),
  };
}

/** Arc's USDC ERC-20 interface (6 decimals): FiatToken with EIP-712 domain "USDC" / "2". */
export const USDC = '0x3600000000000000000000000000000000000000';
const usdcNoncesAbi = [{ type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];

/** An EIP-2612 permit for `value` USDC units to `spender`, as the contracts' Permit struct. */
export async function usdcPermit(account, pub, chainId, spender, value) {
  const nonce = await pub.readContract({ address: USDC, abi: usdcNoncesAbi, functionName: 'nonces', args: [account.address] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const sig = await account.signTypedData({
    domain: { name: 'USDC', version: '2', chainId, verifyingContract: USDC },
    types: { Permit: [
      { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ] },
    primaryType: 'Permit',
    message: { owner: account.address, spender, value, nonce, deadline },
  });
  return { deadline, v: Number(`0x${sig.slice(130, 132)}`), r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}` };
}
