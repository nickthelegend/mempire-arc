import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { signalReady } from './lib/native';
import '@fontsource/lilita-one/400.css';
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
// body copy is 600 — without this it resolves upward to 700 and every string in
// the app renders at button weight, flattening the hierarchy
import '@fontsource/hanken-grotesk/600.css';
import '@fontsource/hanken-grotesk/700.css';
import '@fontsource/hanken-grotesk/800.css';
import '@fontsource/martian-mono/400.css';
import '@fontsource/martian-mono/700.css';
import './styles/tokens.css';
import App from './App.tsx';
import { PrivyGate } from './components/PrivyGate';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrivyGate>
      <App />
    </PrivyGate>
  </StrictMode>,
);

// The Android shell holds its splash over a black WebView until the game says
// it has painted. A no-op in a browser; the shell also has its own timeout, so
// this is the fast path rather than the only one.
requestAnimationFrame(() => signalReady());

// Dev-only console handle for the stores — lets a second tab be driven and
// asserted against when testing PvP on one machine. Stripped from production
// builds by the DEV guard.
/**
 * A deploy while the app is open must not brick a lazy route.
 *
 * Chunk filenames are content-hashed, so a build replaces them. A session that
 * started before a deploy still holds the old names, and the first lazy import
 * after it — the battle route, most of the time — asks for a file that no
 * longer exists. Vercel answers a missing asset with the SPA's index.html, so
 * the browser reports "expected a JavaScript module, got text/html" and the
 * route silently fails to mount. It showed up in this project's own console
 * during a live match.
 *
 * Vite fires `vite:preloadError` for exactly this. One reload picks up the new
 * manifest. Guarded so a genuine, repeating load failure cannot become a
 * refresh loop.
 */
const RELOADED = 'mempire_chunk_reload';
window.addEventListener('vite:preloadError', (e) => {
  if (sessionStorage.getItem(RELOADED)) return; // already tried; let it surface
  sessionStorage.setItem(RELOADED, '1');
  e.preventDefault();
  window.location.reload();
});
window.addEventListener('load', () => {
  // A clean load means the manifest is current again.
  setTimeout(() => sessionStorage.removeItem(RELOADED), 5000);
});

if (import.meta.env.DEV) {
  void Promise.all([
    import('./state/match'), import('./state/wallet'), import('./state/deck'),
    import('./state/collection'),
    import('./state/chain'), import('./state/playLog'),
  ]).then(([m, w, d, c, ch, er]) => {
    (window as unknown as Record<string, unknown>).__mempire = {
      match: m.useMatch, wallet: w.useWallet, deck: d.useDeck,
      collection: c.useCollection,
      chain: ch.useChain, playLog: er.usePlayLog,
    };
  });
}
