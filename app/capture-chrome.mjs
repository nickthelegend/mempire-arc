/**
 * Find a Chrome that actually launches.
 *
 * Playwright pins one browser build per package version and refuses to use any
 * other. When that pin half-downloads, the failure is not "the download is
 * incomplete" — it is a dlopen error naming a missing framework, or an
 * "Executable doesn't exist" for a path that does exist as a directory. Both
 * read as a broken machine rather than a broken install, and `playwright
 * install` reports success without repairing it (npx resolves a different
 * Playwright than node_modules, so it downloads a build the pinned package will
 * never use).
 *
 * So: honour an explicit override, otherwise pick the newest cached build whose
 * real executable is present, otherwise let Playwright do its normal thing.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHE = process.env.PLAYWRIGHT_BROWSERS_PATH
  || join(homedir(), 'Library', 'Caches', 'ms-playwright');

/** The real binary inside a cached build, per platform. */
function binaryIn(dir) {
  const candidates = [
    join(dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    join(dir, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    join(dir, 'chrome-linux', 'chrome'),
    join(dir, 'chrome-win', 'chrome.exe'),
  ];
  return candidates.find(existsSync) ?? null;
}

export function resolveChrome() {
  if (process.env.MEMPIRE_CHROME) return process.env.MEMPIRE_CHROME;
  if (!existsSync(CACHE)) return undefined;

  const builds = readdirSync(CACHE)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));

  for (const b of builds) {
    const bin = binaryIn(join(CACHE, b));
    if (bin) return bin;
  }
  // Nothing usable cached. Let Playwright raise its own error, which at least
  // tells the reader to run `playwright install`.
  return undefined;
}
