import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseEther} from 'viem';
import {fundingStatus} from './onboard-funding.js';
test('second default drip refuses before spending and exposes required relay balance',()=>{
 const first=fundingStatus('relay',parseEther('2.58'),parseEther('2'));
 assert.equal(first.needsTopUp,false);
 const second=fundingStatus('relay',parseEther('0.57'),parseEther('2'));
 assert.equal(second.code,'RELAY_NEEDS_TOP_UP');assert.equal(second.balance,'0.57');assert.equal(second.required,'2.05');assert.match(second.error,/Relay needs a top-up/);
 assert.equal(fundingStatus('relay',parseEther('0.57'),0n).needsTopUp,false);
});
