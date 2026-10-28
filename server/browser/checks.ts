// Checks that need no AI (and so cost nothing): console errors, failed requests, broken links and images,
// accessibility, mobile layout and load time. The same visit collects the page's links (for discovering
// extra pages) and a fingerprint of its controls (to know whether a cached AI plan is still valid).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';
import { setting } from '../config.js';
import type { Bug, ResultStatus } from '../types.js';
import { BrowserSession, gotoWithRetry, waitForSettled, type SessionConfig } from './session.js';

export interface CheckResult {
  check: string;
  title: string;
  status: ResultStatus;
  actual: string;
  expected: string;
  bug: Bug | null;
  steps: string[];
}

export interface PageVisit {
  checks: CheckResult[];
  links: string[];
  fingerprint: string;
  screenshot?: string;
}

// Run with evaluate rather than added as a <script> tag, which a strict Content-Security-Policy blocks.
const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const SLOW_MS = 5_000;
const INTERACTIVE = /^\s*- (button|link|textbox|searchbox|combobox|checkbox|radio|switch|tab|menuitem|slider|spinbutton|option)\b/;

/** "2 issues:\n[serious] Images need alt text" → name the first issue, not just the count. */
function bugTitle(failed: string): string {
  const [first, second] = failed.split('\n');
  const text = first.endsWith(':') && second ? `${second}${failed.split('\n').length > 2 ? ` (+${failed.split('\n').length - 2} more)` : ''}` : first;
  return text.slice(0, 140);
}

export async function visitPage(url: string, run: string[], config: SessionConfig): Promise<PageVisit> {
  const session = new BrowserSession({ ...config, startUrl: url });
  const checks: CheckResult[] = [];
  const add = (check: string, title: string, failed: string | null, expected: string, severity: Bug['severity'] = 'minor') => {
    checks.push({
      check, title, expected, status: failed ? 'failed' : 'passed', actual: failed ?? expected,
      bug: failed ? { title: `${title}: ${bugTitle(failed)}`, severity, stepsToReproduce: [`Open ${url}`], expected, actual: failed } : null,
      steps: [`Open ${url}`, `Check: ${expected}`],
    });
  };
  try {
    await session.start();
    const page = session.page;
    const started = Date.now();
    const response = await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded', timeout: setting.pageLoadMs() }).catch((e: Error) => e);
    const loadMs = Date.now() - started;
    if (response instanceof Error || (response && response.status() >= 400)) {
      const why = response instanceof Error ? response.message.split('\n')[0] : `HTTP ${response!.status()}`;
      add('load', 'Page opens', `The page did not open: ${why}`, 'The page opens without an error', 'critical');
      return { checks, links: [], fingerprint: '' };
    }
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    // The links, controls and checks below are only right once the app has finished drawing the page.
    await waitForSettled(page, config.loginPath);

    const want = (id: string) => run.includes(id);
    if (want('performance')) {
      add('performance', 'Load time', loadMs > SLOW_MS ? `The page took ${(loadMs / 1000).toFixed(1)} s to load` : null,
        `The page loads within ${SLOW_MS / 1000} seconds (took ${(loadMs / 1000).toFixed(1)} s)`);
    }
    if (want('console')) {
      // Resources that fail to load are the "Failed requests" check's job (and are often third-party noise).
      const errors = [...new Set(session.consoleErrors)].filter((e) => !e.startsWith('Failed to load resource'));
      add('console', 'Console errors', errors.length ? `${errors.length} JavaScript error(s):\n${errors.slice(0, 10).join('\n')}` : null,
        'No JavaScript errors in the console', errors.some((e) => e.startsWith('Uncaught')) ? 'major' : 'minor');
    }
    if (want('network')) {
      const failed = [...new Set(session.failedRequests)];
      add('network', 'Failed requests', failed.length ? `${failed.length} request(s) failed:\n${failed.slice(0, 10).join('\n')}` : null,
        'No requests answered with an error', failed.some((f) => f.startsWith('5')) ? 'major' : 'minor');
    }
    if (want('images')) {
      const broken = await page.evaluate(() => [...document.images]
        .filter((i) => i.complete && i.naturalWidth === 0 && i.src && !i.src.startsWith('data:')).map((i) => i.src).slice(0, 20));
      add('images', 'Broken images', broken.length ? `${broken.length} image(s) did not load:\n${broken.join('\n')}` : null, 'All images load');
    }
    const links = await sameSiteLinks(page, config.allowedOrigins);
    if (want('links')) {
      const broken = await brokenLinks(page, links.slice(0, 40));
      add('links', 'Broken links', broken.length ? `${broken.length} link(s) are broken:\n${broken.join('\n')}` : null,
        `Links on the page work (${Math.min(links.length, 40)} checked)`, 'major');
    }
    if (want('a11y')) {
      // A check that cannot run on this page is reported as blocked, so the other checks and the AI tests still run.
      const violations = await accessibility(page).catch((e: Error) => e);
      if (violations instanceof Error) {
        const expected = 'No serious or critical accessibility issues (axe-core)';
        checks.push({ check: 'a11y', title: 'Accessibility', expected, status: 'blocked', bug: null, steps: [`Open ${url}`, `Check: ${expected}`],
          actual: `The accessibility check could not run on this page: ${violations.message.split('\n')[0]}` });
      } else {
        add('a11y', 'Accessibility', violations.length ? `${violations.length} serious or critical issue(s):\n${violations.join('\n')}` : null,
          'No serious or critical accessibility issues (axe-core)');
      }
    }
    const fingerprint = await pageFingerprint(page);
    if (want('responsive')) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(800);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const shot = overflow > 8 ? await session.screenshot(`mobile-${Date.now()}`).catch(() => undefined) : undefined;
      add('responsive', 'Mobile layout', overflow > 8 ? `At 390 px wide the page is ${overflow} px too wide and scrolls sideways` : null,
        'The page fits a 390 px wide phone screen without sideways scrolling');
      if (shot) checks[checks.length - 1].steps.push(`Screenshot: ${shot}`);
      return { checks, links, fingerprint, screenshot: shot };
    }
    return { checks, links, fingerprint };
  } finally {
    await session.close();
  }
}

export async function sameSiteLinks(page: Page, origins: string[]): Promise<string[]> {
  const hosts = origins.map((o) => new URL(o).host);
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => (a as HTMLAnchorElement).href));
  const out = new Set<string>();
  for (const href of hrefs) {
    try {
      const u = new URL(href);
      if (!hosts.includes(u.host) || !u.protocol.startsWith('http')) continue;
      u.hash = '';
      out.add(u.toString());
    } catch { /* not a URL */ }
  }
  return [...out];
}

async function brokenLinks(page: Page, links: string[]): Promise<string[]> {
  const broken: string[] = [];
  await Promise.all(links.map(async (link) => {
    if (/log-?out|sign-?out|delete|remove/i.test(link)) return;
    let status = await page.request.head(link, { timeout: 15_000, maxRedirects: 5 }).then((r) => r.status()).catch(() => 0);
    // Some servers do not answer HEAD: try GET before calling the link broken.
    if (status === 0 || status === 405 || status === 404) {
      status = await page.request.get(link, { timeout: 20_000, maxRedirects: 5 }).then((r) => r.status()).catch(() => 0);
    }
    // 401/403: the page exists but needs a login or permission, which is not a broken link.
    if (status === 0 || (status >= 400 && status !== 401 && status !== 403)) broken.push(`${status || 'no answer'} ${link}`);
  }));
  return broken;
}

async function accessibility(page: Page): Promise<string[]> {
  await page.evaluate(AXE_SOURCE);
  const violations = await page.evaluate(async () => {
    const r = await (window as any).axe.run(document, { resultTypes: ['violations'] });
    return r.violations
      .filter((v: any) => v.impact === 'serious' || v.impact === 'critical')
      .map((v: any) => `[${v.impact}] ${v.help} (${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'})`);
  }) as string[];
  return violations;
}

/**
 * The page's controls (role + name), ignoring numbers and other content. If it is unchanged, the page
 * still offers the same features and the cached plan is reused.
 */
export async function pageFingerprint(page: Page): Promise<string> {
  const snapshot = await page.ariaSnapshot({ mode: 'ai' }).catch(() => '');
  const controls = [...new Set(snapshot.split('\n').filter((l) => INTERACTIVE.test(l))
    .map((l) => l.replace(/\[ref=[^\]]+\]|\[cursor=[^\]]+\]|\[active\]/g, '').replace(/\d+/g, '#').trim()))].sort();
  return createHash('sha256').update(controls.join('\n')).digest('hex').slice(0, 16);
}

/** Pages worth testing among the links found: same site, one per URL pattern, no log-out or delete links. */
export function pickExtraPages(links: string[], known: string[], max: number): string[] {
  const pattern = (u: string) => {
    const url = new URL(u);
    return url.host + url.pathname.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/[0-9a-f-]{16,}(?=\/|$)/gi, '/:id').replace(/\/$/, '');
  };
  const seen = new Set(known.map(pattern));
  const out: string[] = [];
  for (const link of links) {
    if (out.length >= max) break;
    if (/log-?out|sign-?out|delete|remove|\.(pdf|zip|png|jpe?g|svg|csv|xlsx?)$/i.test(link)) continue;
    const p = pattern(link);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(link);
  }
  return out;
}
