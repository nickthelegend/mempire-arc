#!/usr/bin/env node
/**
 * Refuse to build a bundle that would talk to the wrong chain.
 *
 * The chain id decides which deployment file the app reads its contract
 * addresses from. A production build with no deployment for its chain would
 * deploy fine and then sit in offline mode forever, which is a worse way to
 * find out than a failed build. A local-anvil chain id in a Vercel build is the
 * other way to ship something broken. Both are checked before Vite starts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const chainId = Number(process.env.VITE_CHAIN_ID ?? 10143);
const file = join(HERE, '..', 'src', 'shared', 'deployments', `${chainId}.json`);
const fail = [];

if (!existsSync(file)) {
  fail.push(`no deployment for chain ${chainId} at src/shared/deployments/${chainId}.json — deploy, then run \`node scripts/sync-shared.mjs\``);
} else {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  if (Number(d.chainId) !== chainId) fail.push(`deployment file is stamped chain ${d.chainId}, build is for ${chainId}`);
  for (const k of ['token', 'cards', 'arena', 'marketMeta', 'ausd', 'pyth']) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(d[k] ?? ''))) fail.push(`deployment is missing a valid "${k}" address`);
  }
}
if (process.env.VERCEL && chainId === 31337) fail.push('a Vercel build cannot target the local anvil chain (31337)');

if (fail.length) {
  console.error('\npreflight: refusing to build —');
  for (const f of fail) console.error(`  • ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`preflight: chain ${chainId} ok`);
