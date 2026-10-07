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
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/** The exact text the relay verifies (see `authMessage` in auth.js). */
export const authMessage = (address, action, ts) => `Mempire\naction: ${action}\nwallet: ${address}\nts: ${ts}`;

/** A fresh throwaway wallet. */
export const freshAccount = () => privateKeyToAccount(generatePrivateKey());

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
