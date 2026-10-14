import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, type PublicClient } from 'viem';
import { recoverCall, saveCall, readCall, type DurableCall } from '../src/chain/durable-call';

function fixture() {
  let raw: string | null = null;
  const storage = { getItem: () => raw, setItem: (_: string, value: string) => { raw = value; }, removeItem: () => { raw = null; } };
  const call: DurableCall = { version: 1, chainId: 5042002, from: `0x${'11'.repeat(20)}`, to: `0x${'22'.repeat(20)}`,
    dataHash: keccak256('0x1234'), value: '0', gas: '42000', nonce: 3, hash: `0x${'aa'.repeat(32)}` };
  const blockHash = `0x${'bb'.repeat(32)}`;
  const receipt = { transactionHash: call.hash, from: call.from, to: call.to, blockHash, blockNumber: 10n, status: 'success' };
  const tx = { hash: call.hash, from: call.from, to: call.to, input: '0x1234', value: 0n, gas: 42000n, nonce: 3, blockHash };
  let finalReads = 0;
  const client = {
    getChainId: async () => call.chainId,
    getTransactionReceipt: async () => receipt,
    getTransaction: async () => tx,
    getBlock: async (args: { blockTag?: string }) => {
      assert.ok(readCall(storage, call.chainId, call.from), 'journal stays locked until final proof');
      if (args.blockTag === 'finalized') return { number: ++finalReads === 1 ? 9n : 10n, hash: blockHash };
      return { number: 10n, hash: blockHash };
    },
  };
  saveCall(storage, call);
  return { storage, call, receipt, tx, client, finalReads: () => finalReads };
}

test('a mined original waits for finality, verifies the canonical block, then clears its journal', async () => {
  const f = fixture();
  assert.equal(await recoverCall(f.client as unknown as PublicClient, f.storage, f.call.chainId, f.call.from), f.receipt);
  assert.equal(f.finalReads(), 2);
  assert.equal(readCall(f.storage, f.call.chainId, f.call.from), null);
});

test('finality waiting never relaxes the original call or canonical block binding', async () => {
  for (const mismatch of ['input', 'canonical']) {
    const f = fixture();
    if (mismatch === 'input') f.tx.input = '0x5678';
    else f.client.getBlock = async () => ({ number: 10n, hash: `0x${'cc'.repeat(32)}` });
    await assert.rejects(() => recoverCall(f.client as unknown as PublicClient, f.storage, f.call.chainId, f.call.from), /canonical/);
    assert.ok(readCall(f.storage, f.call.chainId, f.call.from));
  }
});


test('a stalled finalized head preserves the journal and asks for receipt recovery', async () => {
  const f = fixture();
  f.client.getBlock = async () => ({ number: 9n, hash: f.receipt.blockHash });
  await assert.rejects(() => recoverCall(f.client as unknown as PublicClient, f.storage, f.call.chainId, f.call.from), /finality is still pending/);
  assert.ok(readCall(f.storage, f.call.chainId, f.call.from));
});
