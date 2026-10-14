import { formatEther, parseEther } from 'viem';
import { IS_TEST_CHAIN, publicClient } from './chain.js';
import { relayerAddress } from './relayer.js';

export function onboardDrip() {
  if (!IS_TEST_CHAIN) return 0n;
  try { return parseEther(process.env.ONBOARD_USDC_DRIP ?? '2'); }
  catch { return parseEther('2'); }
}

export function fundingStatus(address, balance, drip) {
  const required = parseEther('0.05') + drip;
  const needsTopUp = balance < required;
  return { address, balance: formatEther(balance), required: formatEther(required),
    drip: formatEther(drip), needsTopUp,
    ...(needsTopUp ? { code: 'RELAY_NEEDS_TOP_UP',
      error: `Relay needs a top-up: ${formatEther(balance)} USDC available; ${formatEther(required)} USDC needed for the starter kit and gas. Ask the operator to fund the relay and try again.` } : {}),
  };
}

export async function relayFunding() {
  const address = relayerAddress();
  if (!address) return null;
  return fundingStatus(address, await publicClient().getBalance({ address }), onboardDrip());
}
