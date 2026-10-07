/*
THESIS: a royal court for degen bags — the throne room where meme coins fight
for real pots; refuses the generic dark-dashboard crypto template.
OWN-WORLD: near-black violet void, one centered 430px column; violet→teal
gradient owns interaction, royal gold appears only when money moves; blackletter
display over geometric sans; gilded card frames, crowns for tiers.
STORY: connect → see your bags as an army → stake power → BATTLE → pot settles
onchain; every fee stated where it applies.
FIRST VIEWPORT: crown + wordmark over tier crowns, one glowing BATTLE pill on a
throne of money rows, live settlements pulsing teal, deck strip at the thumb.
FORM: portrait arcade-cabinet column (user-pinned layout law + the royal-court
world, chosen in interview); battle runs full-column 3D under the same HUD grammar.
*/
import { lazy, Suspense } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Loading } from './components/Loading';
import { Shell } from './components/Shell';
import { Arena } from './screens/Arena';
import { Cards } from './screens/Cards';
import { Clan } from './screens/Clan';
import { Deck } from './screens/Deck';
import { Empire } from './screens/Empire';

const Battle = lazy(() => import('./screens/Battle').then((m) => ({ default: m.Battle })));

export default function App() {
  return (
    <ErrorBoundary>
      <HashRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<Arena />} />
            <Route path="/cards" element={<Cards />} />
            <Route path="/deck" element={<Deck />} />
            <Route path="/clan" element={<Clan />} />
            <Route path="/empire" element={<Empire />} />
            <Route
              path="/battle"
              element={(
                <Suspense fallback={<Loading />}>
                  <Battle />
                </Suspense>
              )}
            />
          </Routes>
        </Shell>
      </HashRouter>
    </ErrorBoundary>
  );
}
