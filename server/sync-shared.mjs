/**
 * Copies the repo's `shared/` facts into `server/shared/`.
 *
 * The relay is built and deployed from `server/` alone — Railway's build
 * context and the Dockerfile both stop at this directory — so `../shared` does
 * not exist at runtime and a `readFileSync('../shared/roster.json')` would boot
 * fine on a laptop and crash-loop in production. The roster, the ABIs and the
 * deployment addresses are therefore vendored here, and this is the one way
 * they get refreshed: run it after a contract redeploy or a roster rebuild,
 * and commit what it writes.
 *
 *   npm run sync-shared
 *
 * It mirrors rather than merges: anything in `server/shared/` that is no longer
 * upstream is removed, so a stale deployment file cannot outlive the chain it
 * described.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = new URL('../shared/', import.meta.url);
const to = new URL('./shared/', import.meta.url);

if (!existsSync(new URL('roster.json', from))) {
  console.error(`sync-shared: ${fileURLToPath(from)} has no roster.json — run this from a full checkout`);
  process.exit(1);
}

for (const part of ['abi', 'deployments']) {
  rmSync(new URL(`${part}/`, to), { recursive: true, force: true });
  cpSync(new URL(`${part}/`, from), new URL(`${part}/`, to), { recursive: true });
}
cpSync(new URL('roster.json', from), new URL('roster.json', to));

console.log(`sync-shared: roster.json, abi/, deployments/ → ${fileURLToPath(to)}`);
