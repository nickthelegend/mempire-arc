# Five-minute Arc mainnet film

Run `node scripts/e2e-browser-video-mempire-5min.mjs` from this repository. The audit is read-only: successful receipts, exact gas fees and blocks, hosted landing page, and explorer logs. It does not recreate the paid flow.

Artifacts in the shared Arc workspace: `../video/out/mempire-5min.mp4`, `../video/out/mempire-5min.json`, `../video/out/mempire-5min-script.json`, `../video/out/mempire-5min-REVIEW.md`. Video binaries and raw recordings remain outside the repository.

Final render: 2026-10-14T19:00:55.159Z. Post-render RPC check: 133/133 successful, exact fees, at 2026-10-14T19:02:06.052Z.

- Live: two independently controlled browser wallets, $1 stakes, full three-minute normal-speed match #4, $1.80 winner payout / $0.20 rake.
- Both seats agreed winner 1 and final hash 0x6f170904; 31 confirmed on-chain plays. Two inputs remained unlogged after recording RPC errors.
- 78 successful arena receipts appear in the proof table; 55 additional successful setup/recovery/cleanup receipts are in JSON (133 total).
- Two agent-operated browser contexts used normal controls; neither seat was the built-in bot. The edit selects excerpts from the full recorded match.
- Local relay and temporary storage were used against the same mainnet contracts. Public continuous relay availability remains weak.
- Interrupted match #3 was refunded by timeout; an earlier open match was cancelled. These are supporting receipts, not successful-match footage.
- Reverted claim 0x25c4b2642d9d6823b4f7d74c99bf5812f3d2661680dcff9c80763093cc293ea3 cost 0.001999500115271175 USDC; excluded from successful proof, included in spending.
- Player balances swept; each retains 0.000425 USDC gas dust. Missing pre-restart session key leaves 0.10 USDC unrecovered and counted against cap.
- Median browser play confirmation: 8.243 seconds across 31 confirmed plays; not consensus finality. No claim that every input was on chain.
- Weak: RPC recovery, adversarial settlement testing, and durable relay operations. No live cross-chain transfer was demonstrated.

300 seconds, 1080p30, captions and instrumental bed. No voice or paid API calls in this job. Timed narration is reserved for a separate local Chatterbox pass.
