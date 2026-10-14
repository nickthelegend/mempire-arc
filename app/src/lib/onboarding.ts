/** Reconcile an ambiguous POST with its durable claim; never resend a drip on a timeout. */
export async function finishOnboarding(
  post: () => Promise<Response | null>,
  status: () => Promise<Response | null>,
  refresh: () => Promise<void>,
  pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  const response = await post();
  const body = await response?.json().catch(() => null);
  if (response?.ok) { await refresh(); return body; }
  if (response && response.status !== 409) {
    await refresh(); // Partial success can already include the deck.
    throw new Error(body?.error ?? (Object.values(body?.errors ?? {}).join('; ') || 'Onboarding failed'));
  }
  // The HTTP deadline is not a transaction deadline. Read the claim until the
  // relay finishes; a retry button is safe only after this bounded reconciliation.
  for (let i = 0; i < 30; i++) {
    const r = await status();
    const state = r?.ok ? await r.json() : null;
    if (state?.claim?.complete) {
      await refresh();
      return { usdc: state.claim.steps.usdc };
    }
    if (state?.claim && state.claim.running === false) {
      await refresh();
      throw new Error(Object.values(state.claim.errors ?? {}).join('; ') || 'Onboarding did not complete. Try again.');
    }
    await pause(1500);
  }
  await refresh();
  throw new Error('Relay confirmation is still pending. Try again to check your starter kit.');
}
