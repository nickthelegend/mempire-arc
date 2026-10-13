import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainIdFromEnv } from './chain-id.js';
test('defaults to Arc testnet and accepts mainnet and local test forks', () => {
  assert.equal(chainIdFromEnv(undefined), 5042002);
  for (const id of [5042, 5042002, 31337, 31338]) assert.equal(chainIdFromEnv(String(id)), id);
});
test('rejects malformed ids rather than creating a client on an unintended chain', () => {
  for (const raw of ['', ' ', 'NaN', '-1', '0', '5042.5', '5e3', '9007199254740992']) {
    assert.throws(() => chainIdFromEnv(raw), /CHAIN_ID/);
  }
});
