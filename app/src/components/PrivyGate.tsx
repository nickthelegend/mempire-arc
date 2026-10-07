import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import type { Address, Hex } from 'viem';
import { CHAIN } from '../chain/provider';
import { PRIVY_APP_ID, registerBridge } from '../lib/privy';

/*
 * The real Privy SDK, only when the build has an app id.
 *
 * `@privy-io/react-auth` is large, and a build without `VITE_PRIVY_APP_ID`
 * never needs it, so it is imported lazily and the gate renders its children
 * untouched otherwise. Inside the provider a headless bridge hands Privy's
 * hooks to `lib/privy.ts`, which is what the zustand wallet store calls — the
 * rest of the app never imports Privy.
 *
 * Config: email and Google sign-in, an embedded Ethereum wallet created on
 * login, wallet UIs hidden (sponsored sends and the session signer make them
 * pointless), and Monad as the only chain.
 */

const Provider = lazy(async () => {
  const sdk = await import('@privy-io/react-auth');

  function Bridge() {
    const { login, logout, getAccessToken, ready, authenticated } = sdk.usePrivy();
    const { wallets } = sdk.useWallets();
    const { sendTransaction } = sdk.useSendTransaction();
    const { signMessage } = sdk.useSignMessage();
    const { signTypedData } = sdk.useSignTypedData();
    const { addSigners, removeSigners } = sdk.useSigners();
    const embedded = wallets.find((w) => w.walletClientType === 'privy');

    useEffect(() => {
      if (!ready) return;
      registerBridge({
        login: async () => { if (!authenticated) login(); },
        logout: async () => { await logout(); },
        address: () => (embedded?.address as Address | undefined) ?? null,
        accessToken: () => getAccessToken(),
        signMessage: async (message) => (await signMessage({ message }, { address: embedded?.address })).signature as Hex,
        signTypedData: async (td) => (await signTypedData(td as never, { address: embedded?.address })).signature as Hex,
        // `sponsor: true` — Privy's native gas sponsorship pays for it.
        sendSponsored: async (tx) => (await sendTransaction(
          { to: tx.to, data: tx.data, value: tx.value, chainId: CHAIN.id },
          { sponsor: true, address: embedded?.address },
        )).hash,
        addSigners: async (address, signerId, policyIds) => { await addSigners({ address, signers: [{ signerId, policyIds }] }); },
        removeSigners: async (address) => { await removeSigners({ address }); },
      });
      return () => registerBridge(null);
    }, [ready, authenticated, embedded?.address, login, logout, getAccessToken, signMessage, signTypedData, sendTransaction, addSigners, removeSigners]);
    return null;
  }

  function PrivyRoot({ children }: { children: ReactNode }) {
    return (
      <sdk.PrivyProvider
        appId={PRIVY_APP_ID!}
        config={{
          loginMethods: ['email', 'google'],
          embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' }, showWalletUIs: false },
          defaultChain: CHAIN,
          supportedChains: [CHAIN],
          appearance: { theme: 'dark', accentColor: '#ffd766' },
        }}
      >
        <Bridge />
        {children}
      </sdk.PrivyProvider>
    );
  }
  return { default: PrivyRoot };
});

export function PrivyGate({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) return <>{children}</>;
  return (
    <Suspense fallback={children}>
      <Provider>{children}</Provider>
    </Suspense>
  );
}
