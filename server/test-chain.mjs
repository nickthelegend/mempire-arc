/**
 * A throwaway chain for the suites that write to it.
 *
 * A fork of Arc mainnet on its own port and chain id (8711 / 31338), run by
 * Circle's Arc Foundry (`arc-anvil --network arc`: plain anvil can fork Arc but
 * can't move its native USDC), with our contracts deployed by `DeployLocal` —
 * so Arc's real USDC, Chainlink's Data Feeds and CCIP router are there, exactly
 * as on the dev chain. Nothing is ever broadcast to mainnet. The suites warp
 * time; doing that on the dev chain (8710 / 31337) would leave every live price
 * "stale" for whoever is playing on it.
 *
 * Binaries: ARC_ANVIL / ARC_FORGE (default `arc-anvil` / `forge` on PATH).
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
import { mnemonicToAccount } from 'viem/accounts';
import { DEV_BASE, DEV_MNEMONIC } from './test-util.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const TEST_PORT = Number(process.env.TEST_CHAIN_PORT ?? 8711);
export const TEST_CHAIN_ID = 31338;
const FORK_URL = process.env.FORK_URL ?? 'https://rpc.mainnet.arc.io';
const ANVIL = process.env.ARC_ANVIL ?? 'arc-anvil';
const FORGE = process.env.ARC_FORGE ?? 'forge';
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
 * The fork's dev accounts: anvil's public mnemonic at indices 7100+ (see
 * DeployLocal.s.sol). Each gets 10,000 USDC (native balance, 18 decimals; the
 * ERC-20 view shows the same), and any code is cleared in case a delegation was
 * ever set on one upstream.
 */
const DEV_ACCOUNTS = [0, 1, 2, 3, 4, 5].map((i) => mnemonicToAccount(DEV_MNEMONIC, { addressIndex: DEV_BASE + i }).address);
async function scrubDevAccounts(rpcUrl) {
  const call = (method, params) => fetch(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  for (const a of DEV_ACCOUNTS) {
    await call('anvil_setCode', [a, '0x']);
    await call('anvil_setBalance', [a, '0x21e19e0c9bab2400000']); // 10,000 USDC
  }
}

const viemChain = (rpcUrl) => ({
  id: TEST_CHAIN_ID, name: 'Arc fork (test)',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
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

  const anvil = spawn(ANVIL, [
    '--network', 'arc', '--port', String(port), '--chain-id', String(TEST_CHAIN_ID), '--prune-history', '300',
    '--fork-url', FORK_URL, '--silent', '--retries', '10', '--timeout', '60000',
  ], { stdio: 'ignore' });
  const kill = () => { try { anvil.kill('SIGKILL'); } catch { /* gone */ } };
  process.on('exit', kill);
  for (let i = 0; i < 80 && (await chainId(rpcUrl)) !== TEST_CHAIN_ID; i += 1) {
    if (anvil.exitCode !== null) throw new Error('anvil exited during boot');
    await new Promise((r) => { setTimeout(r, 250); });
  }
  if ((await chainId(rpcUrl)) !== TEST_CHAIN_ID) { kill(); throw new Error('the test fork did not come up'); }
  await scrubDevAccounts(rpcUrl);

  const forge = spawnSync(FORGE, ['script', 'script/DeployLocal.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--silent'], {
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
