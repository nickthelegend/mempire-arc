/**
 * A throwaway chain for the suites that write to it.
 *
 * An anvil fork of Monad testnet on its own port and chain id (8613 / 31338),
 * with our contracts deployed by `DeployLocal` — so the real Agora AUSD and its
 * faucet are there, exactly as on the dev chain. The suites warp time and spend
 * the faucet's cooldown; doing that on the dev chain (8612 / 31337) would leave
 * every live price "stale" and the faucet busy for whoever is playing on it.
 *
 * `stop()` kills anvil and removes the 31338 deployment files (all gitignored).
 * If a test chain is already up on the port with its deployment, it is reused
 * and left running — `scripts/test-all.sh` starts one for every suite.
 *
 *   const tc = await startTestChain();   // { rpcUrl, chainId, dep, chain, stop }
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const TEST_PORT = Number(process.env.TEST_CHAIN_PORT ?? 8613);
export const TEST_CHAIN_ID = 31338;
const FORK_URL = process.env.FORK_URL ?? 'https://testnet-rpc.monad.xyz';
const rootDep = `${ROOT}shared/deployments/${TEST_CHAIN_ID}.json`;
const serverDep = `${ROOT}server/shared/deployments/${TEST_CHAIN_ID}.json`;

async function chainId(rpcUrl) {
  try {
    const r = await fetch(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    return Number((await r.json()).result);
  } catch { return null; }
}

/*
 * anvil's dev accounts use a public mnemonic, and on Monad testnet those
 * addresses carry EIP-7702 delegations to sweeper contracts that forward any
 * MON they receive. The fork inherits that code, so the first mint fee paid to
 * the owner (#0) empties it. Clear the delegations and restore the balances.
 */
const DEV_ACCOUNTS = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
];
async function scrubDevAccounts(rpcUrl) {
  const call = (method, params) => fetch(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  for (const a of DEV_ACCOUNTS) {
    await call('anvil_setCode', [a, '0x']);
    await call('anvil_setBalance', [a, '0x21e19e0c9bab2400000']); // 10,000 MON
  }
}

const viemChain = (rpcUrl) => ({
  id: TEST_CHAIN_ID, name: 'Anvil (test fork)',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

export async function startTestChain({ port = TEST_PORT } = {}) {
  const rpcUrl = `http://127.0.0.1:${port}`;
  const existing = await chainId(rpcUrl);
  if (existing === TEST_CHAIN_ID && existsSync(serverDep)) {
    const dep = JSON.parse(readFileSync(serverDep, 'utf8'));
    return { rpcUrl, chainId: TEST_CHAIN_ID, dep, chain: viemChain(rpcUrl), stop: async () => {} };
  }
  if (existing !== null) throw new Error(`port ${port} already serves chain ${existing}; set TEST_CHAIN_PORT`);

  const anvil = spawn('anvil', [
    '--port', String(port), '--chain-id', String(TEST_CHAIN_ID), '--prune-history', '300',
    '--fork-url', FORK_URL, '--silent', '--hardfork', 'cancun', '--retries', '10', '--timeout', '60000',
  ], { stdio: 'ignore' });
  const kill = () => { try { anvil.kill('SIGKILL'); } catch { /* gone */ } };
  process.on('exit', kill);
  for (let i = 0; i < 80 && (await chainId(rpcUrl)) !== TEST_CHAIN_ID; i += 1) {
    if (anvil.exitCode !== null) throw new Error('anvil exited during boot');
    await new Promise((r) => { setTimeout(r, 250); });
  }
  if ((await chainId(rpcUrl)) !== TEST_CHAIN_ID) { kill(); throw new Error('the test fork did not come up'); }
  await scrubDevAccounts(rpcUrl);

  const forge = spawnSync('forge', ['script', 'script/DeployLocal.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--silent'], {
    cwd: `${ROOT}contracts`, encoding: 'utf8',
  });
  if (forge.status !== 0 || !existsSync(rootDep)) {
    kill();
    throw new Error(`DeployLocal failed on the test fork:\n${(forge.stderr || forge.stdout || '').slice(-2000)}`);
  }
  mkdirSync(`${ROOT}server/shared/deployments`, { recursive: true });
  copyFileSync(rootDep, serverDep);
  const dep = JSON.parse(readFileSync(serverDep, 'utf8'));

  const cleanup = () => {
    rmSync(rootDep, { force: true });
    rmSync(serverDep, { force: true });
    rmSync(`${ROOT}contracts/broadcast/DeployLocal.s.sol/${TEST_CHAIN_ID}`, { recursive: true, force: true });
  };
  process.on('exit', cleanup);
  return {
    rpcUrl, chainId: TEST_CHAIN_ID, dep, chain: viemChain(rpcUrl),
    stop: () => new Promise((resolve) => {
      cleanup();
      if (anvil.exitCode !== null) return resolve();
      anvil.once('exit', resolve);
      anvil.kill('SIGTERM');
    }),
  };
}

// `node test-chain.mjs` holds a test chain open until Ctrl-C (test-all uses this).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tc = await startTestChain();
  console.log(`test chain ${tc.rpcUrl} (chain ${tc.chainId}) — arena ${tc.dep.arena}`);
  const down = async () => { await tc.stop(); process.exit(0); };
  process.on('SIGTERM', down);
  process.on('SIGINT', down);
  setInterval(() => {}, 1 << 30);
}
