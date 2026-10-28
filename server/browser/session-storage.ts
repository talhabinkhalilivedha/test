// Some sites keep their login in sessionStorage, which Playwright's saved session leaves out. It is saved
// in a file next to the session file and put back in every new browser before the site's own scripts run.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { BrowserContext, Page } from 'playwright';

interface SavedSessionStorage {
  origin: string;
  items: Record<string, string>;
}

// Set once a tab has its sessionStorage back, so a logout in that tab is not undone by the next page load.
const RESTORED = '__qa_session_restored';

const fileFor = (statePath: string) => statePath.replace(/\.json$/, '') + '.session-storage.json';

/** Saves the sessionStorage of the page's site. Returns how many entries it had. */
export async function saveSessionStorage(page: Page, statePath: string): Promise<number> {
  const items: Record<string, string> = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage))).catch(() => ({}));
  writeFileSync(fileFor(statePath), JSON.stringify({ origin: new URL(page.url()).origin, items } satisfies SavedSessionStorage));
  return Object.keys(items).length;
}

/** Puts the saved sessionStorage back in every tab of the context that opens the same site. */
export async function restoreSessionStorage(context: BrowserContext, statePath: string): Promise<void> {
  const file = fileFor(statePath);
  if (!existsSync(file)) return;
  const saved: SavedSessionStorage = JSON.parse(readFileSync(file, 'utf8'));
  if (!Object.keys(saved.items).length) return;
  await context.addInitScript(({ origin, items, marker }) => {
    if (location.origin !== origin) return;
    try {
      if (sessionStorage.getItem(marker)) return;
      for (const [key, value] of Object.entries(items)) sessionStorage.setItem(key, value);
      sessionStorage.setItem(marker, '1');
    } catch { /* storage blocked: nothing to restore */ }
  }, { ...saved, marker: RESTORED });
}
