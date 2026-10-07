/**
 * Privy: the match policy, and an honest "not configured" without keys.
 *
 * The session signer may only do what MATCH_POLICY allows. That policy is
 * created in Privy (enforced in its TEE) and checked here again before Privy is
 * asked to sign, so this suite exercises the local check directly: arena
 * play/checkpoint/claim pass; anything else — another method, another
 * contract, a value, another chain, an expired or missing consent — is refused.
 *
 * Then the routes, with no Privy keys: every one answers 503 and the config
 * names exactly which keys are missing. There is no stand-in mode to test.
 *
 *   node test-privy.mjs   (forks Monad testnet on :8613 for a real deployment)
 */
import { encodeFunctionData, erc20Abi } from 'viem';
import { startTestChain } from './test-chain.mjs';
import { client, startRelay, tally } from './test-util.mjs';

// chain.js reads CHAIN_ID when it loads, so pick the test fork first.
const tc = await startTestChain();
process.env.CHAIN_ID = String(tc.chainId);
const { abis, deployment } = await import('./chain.js');
const { checkPolicy, matchPolicy } = await import('./privy.js');

const { check, done } = tally();
const PORT = Number(process.env.PORT ?? 8795);
const arena = deployment.arena;
const now = Math.floor(Date.now() / 1000);
const consent = { expiresAt: now + 3600 };
const call = (fn, args) => ({ to: arena, data: encodeFunctionData({ abi: abis.arena, functionName: fn, args }), value: 0 });

console.log('1. the policy document');
const policy = matchPolicy();
check('three ALLOW rules, one per arena method', policy.rules.length === 3 && policy.rules.every((r) => r.action === 'ALLOW'));
check('rules name play, checkpoint and claim', ['arena.play', 'arena.checkpoint', 'arena.claim'].every((n) => policy.rules.some((r) => r.name === n)));
check('every rule pins to=arena, value=0 and the chain id', policy.rules.every((r) => {
  const t = Object.fromEntries(r.conditions.filter((c) => c.field_source === 'ethereum_transaction').map((c) => [c.field, c.value]));
  return t.to === arena && t.value === '0' && Number(t.chain_id) > 0;
}));
check('every rule decodes the calldata with that method\'s ABI', policy.rules.every((r) => r.conditions.some((c) => c.field_source === 'ethereum_calldata' && c.abi?.length === 1)));

console.log('\n2. the local check');
check('play is allowed', checkPolicy(call('play', [1n, 40, 2, 100, -100]), consent) === null);
check('checkpoint is allowed', checkPolicy(call('checkpoint', [1n, 400, 5n]), consent) === null);
check('claim is allowed', checkPolicy(call('claim', [1n, 0, `0x${'ab'.repeat(32)}`]), consent) === null);
check('cancelMatch is refused', /not allowed/.test(checkPolicy(call('cancelMatch', [1n]), consent) ?? ''));
check('withdraw is refused', /not allowed/.test(checkPolicy(call('withdraw', ['0x0000000000000000000000000000000000000000']), consent) ?? ''));
check('a token transfer is refused', /only the arena/.test(checkPolicy({ to: deployment.ausd, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [arena, 1n] }), value: 0 }, consent) ?? ''));
check('any value is refused', /value must be 0/.test(checkPolicy({ ...call('play', [1n, 1, 0, 0, 0]), value: 1 }, consent) ?? ''));
check('another chain is refused', /wrong chain/.test(checkPolicy({ ...call('play', [1n, 1, 0, 0, 0]), chainId: 1 }, consent) ?? ''));
check('garbage calldata is refused', /not an arena call/.test(checkPolicy({ to: arena, data: '0xdeadbeef', value: 0 }, consent) ?? ''));
check('no consent is refused', /no session signer consent/.test(checkPolicy(call('play', [1n, 1, 0, 0, 0]), null) ?? ''));
check('an expired consent is refused', /expired/.test(checkPolicy(call('play', [1n, 1, 0, 0, 0]), { expiresAt: now - 1 }) ?? ''));

console.log('\n3. no keys → honest 503s, no stand-in');
const relay = await startRelay(PORT, { CHAIN_ID: String(tc.chainId), RPC_URL: tc.rpcUrl });
const req = client(relay.base);
try {
  const cfg = await req('GET', '/api/privy/config');
  check('config says off', cfg.data?.mode === 'off');
  check('config names the four missing keys', ['PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'PRIVY_AUTHORIZATION_KEY', 'PRIVY_SIGNER_ID'].every((k) => cfg.data?.missing?.includes(k)));
  for (const [m, path] of [['POST', '/api/privy/signers'], ['DELETE', '/api/privy/signers'], ['POST', '/api/privy/act']]) {
    const r = await req(m, path, { accessToken: 'x', tx: call('play', [1n, 1, 0, 0, 0]) });
    check(`${m} ${path} is 503`, r.status === 503, String(r.status));
  }
  const gone = await req('POST', '/api/privy/mock/login', { email: 'a@b.c' });
  check('there is no mock login route', gone.status === 404);
} finally {
  await relay.stop();
  await tc.stop();
}
process.exit(done() ? 1 : 0);
