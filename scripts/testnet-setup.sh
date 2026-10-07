#!/bin/sh
# One-time testnet setup: make the relay's keys (relayer + agent owner) in server/.env.local
# (gitignored; never printed) and show what to fund.
#   sh scripts/testnet-setup.sh
set -e
cd "$(dirname "$0")/.."
F=server/.env.local
touch "$F"; chmod 600 "$F"
gen() { node -e "const {generatePrivateKey,privateKeyToAccount}=require('./server/node_modules/viem/accounts');const k=generatePrivateKey();console.log(k+' '+privateKeyToAccount(k).address)"; }
if ! grep -q '^RELAYER_PRIVATE_KEY=' "$F"; then
  set -- $(gen); printf 'RELAYER_PRIVATE_KEY=%s\nRELAYER_ADDRESS=%s\n' "$1" "$2" >> "$F"
fi
if ! grep -q '^AGENT_OWNER_PRIVATE_KEY=' "$F"; then
  set -- $(gen); printf 'AGENT_OWNER_PRIVATE_KEY=%s\nAGENT_OWNER_ADDRESS=%s\n' "$1" "$2" >> "$F"
fi
grep -q '^CHAIN_ID=' "$F" || printf 'CHAIN_ID=5042002\nRPC_URL=https://rpc.testnet.arc.io\nMETA_KEEPER=1\n' >> "$F"
echo "relayer      $(grep '^RELAYER_ADDRESS=' "$F" | cut -d= -f2)  — fund with ~10 USDC on Arc testnet (onboarding drips, mints, meta, feed mirror)"
echo "agent owner  $(grep '^AGENT_OWNER_ADDRESS=' "$F" | cut -d= -f2)  — fund with ~0.1 USDC (one ERC-8004 register tx)"
echo "deployer     0x0648aDF1967692A0c991d7715b0b588452321FBd  — fund with ~2 USDC (see MAINNET.md for measured gas)"
echo "faucet: https://faucet.circle.com (Arc testnet)"
