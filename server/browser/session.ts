// One browser for one agent (or one replay). Every action is:
// - carried out with Playwright,
// - written to `performed` as a plain-English step for the report,
// - and, when it worked, added to `recording` with a stable locator so it can be replayed later without AI.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { setting } from '../config.js';
import type { DataMode, PerformedStep, RecordedStep, VerifyKind } from '../types.js';
import { ensureFixtures } from './fixtures.js';
import { restoreSessionStorage } from './session-storage.js';

export interface SessionConfig {
  startUrl: string;
  /** Origins the agent may visit (the site under test). */
  allowedOrigins: string[];
  storageState?: string;
  headless: boolean;
  /** Screenshots go here. */
  outDir: string;
  dataMode: DataMode;
  viewport?: { width: number; height: number };
  /** Path of the site's login page: a page showing it is still checking the saved session (see waitForSettled). */
  loginPath?: string;
}

// Snapshots of big pages are cut off past this size; the agent can ask for one part of the page instead.
const MAX_SNAPSHOT = 24_000;
const ACTION_TIMEOUT = 10_000;
const VERIFY_TIMEOUT = 5_000;

export class ToolError extends Error {}

export class BrowserSession {
  browser!: Browser;
  context!: BrowserContext;
  page!: Page;
  readonly recording: RecordedStep[] = [];
  readonly performed: PerformedStep[] = [];
  /** False once a step could not be recorded with a stable locator: such a test cannot be replayed. */
  replayable = true;
  consoleErrors: string[] = [];
  failedRequests: string[] = [];
  private notes: string[] = [];
  private lastSnapshot: { url: string; lines: string[] } | null = null;
  private uid = Math.random().toString(36).slice(2, 8);
  private fixturesDir = ensureFixtures();

  constructor(readonly config: SessionConfig) {
    mkdirSync(config.outDir, { recursive: true });
  }

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.config.headless });
    this.context = await this.browser.newContext({
      storageState: this.config.storageState && existsSync(this.config.storageState) ? this.config.storageState : undefined,
      viewport: this.config.viewport ?? { width: 1366, height: 900 },
      ignoreHTTPSErrors: true,
    });
    if (this.config.storageState) await restoreSessionStorage(this.context, this.config.storageState);
    this.context.setDefaultTimeout(ACTION_TIMEOUT);
    this.context.setDefaultNavigationTimeout(setting.pageLoadMs());
    this.page = await this.context.newPage();
    // New tabs: note where they went and close them, so the agent stays on one page.
    this.context.on('page', async (p) => {
      if (p === this.page) return;
      await p.waitForLoadState('domcontentloaded').catch(() => {});
      this.notes.push(`A new tab opened at ${p.url()} and was closed.`);
      await p.close().catch(() => {});
    });
    this.page.on('console', (m) => {
      if (m.type() === 'error') this.consoleErrors.push(m.text().slice(0, 300));
    });
    this.page.on('pageerror', (e) => this.consoleErrors.push(`Uncaught: ${e.message.slice(0, 300)}`));
    this.page.on('response', (r) => {
      if (r.status() >= 400 && this.isAllowed(r.url())) this.failedRequests.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 200)}`);
    });
    // Confirm dialogs ("Delete this item?") are only accepted when the run may change data.
    this.page.on('dialog', async (d) => {
      const accept = d.type() !== 'confirm' || this.config.dataMode === 'full';
      this.notes.push(`Browser ${d.type()} dialog: "${d.message().slice(0, 200)}" (${accept ? 'accepted' : 'dismissed'})`);
      await (accept ? d.accept() : d.dismiss()).catch(() => {});
    });
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
  }

  private isAllowed(url: string): boolean {
    try {
      const u = new URL(url);
      return this.config.allowedOrigins.some((o) => new URL(o).host === u.host);
    } catch {
      return false;
    }
  }

  // ── Tools ──────────────────────────────────────────────────────────────────────────────────

  async navigate(url: string): Promise<string> {
    const target = new URL(url, this.page.url().startsWith('http') ? this.page.url() : this.config.startUrl).toString();
    if (!this.isAllowed(target)) throw new ToolError(`${target} is outside the site under test: not opened`);
    return this.step(`Open ${target}`, { action: 'goto', url: target }, async () => {
      await gotoPage(this.page, target);
      await waitForSettled(this.page, this.config.loginPath);
    });
  }

  /**
   * The page as an accessibility tree with [ref=eN] markers. Unless `full`, a page already seen is
   * answered with only the lines that changed, which keeps long sessions cheap.
   */
  async snapshot(opts: { full?: boolean; ref?: string } = {}): Promise<string> {
    await settle(this.page);
    const text = opts.ref
      ? await this.page.getByRef(opts.ref).ariaSnapshot({ mode: 'ai' })
      : await this.page.ariaSnapshot({ mode: 'ai' });
    const lines = text.split('\n');
    const url = this.page.url();
    const header = `URL: ${url}\nTitle: ${await this.page.title().catch(() => '')}\n${this.takeNotes()}`;
    if (!opts.ref) {
      const last = this.lastSnapshot;
      this.lastSnapshot = { url, lines };
      if (!opts.full && last && last.url === url) {
        const old = new Set(last.lines);
        const added = lines.filter((l) => !old.has(l));
        const removed = last.lines.length - (lines.length - added.length);
        if (added.length === 0 && removed === 0) return `${header}The page has not changed since the last snapshot.`;
        if (added.length < lines.length * 0.5) {
          return `${header}Changes since the last snapshot (${removed} lines gone; new or changed lines below, ` +
            `call snapshot with full=true for the whole page):\n${clip(added.join('\n'))}`;
        }
      }
    }
    return `${header}${clip(text)}`;
  }

  async click(ref: string, element: string, double = false): Promise<string> {
    const target = await this.resolve(ref);
    return this.step(`${double ? 'Double-click' : 'Click'} "${element}"`,
      { action: double ? 'dblclick' : 'click', element, ...target.recorded }, async () => {
        await (double ? target.locator.dblclick() : target.locator.click());
        await this.leaveForeignPage();
      });
  }

  async fill(ref: string, element: string, text: string, submit = false): Promise<string> {
    const target = await this.resolve(ref);
    const value = this.expand(text);
    const res = await this.step(`Enter "${value}" in "${element}"`, { action: 'fill', element, value: text, ...target.recorded }, async () => {
      await target.locator.fill(value);
    });
    return submit ? `${res}\n${await this.press('Enter')}` : res;
  }

  async select(ref: string, element: string, values: string[]): Promise<string> {
    const target = await this.resolve(ref);
    return this.step(`Select "${values.join('", "')}" in "${element}"`, { action: 'select', element, values, ...target.recorded }, async () => {
      await target.locator.selectOption(values);
    });
  }

  async setChecked(ref: string, element: string, checked: boolean): Promise<string> {
    const target = await this.resolve(ref);
    return this.step(`${checked ? 'Tick' : 'Untick'} "${element}"`, { action: checked ? 'check' : 'uncheck', element, ...target.recorded }, async () => {
      await target.locator.setChecked(checked);
    });
  }

  async press(key: string): Promise<string> {
    return this.step(`Press ${key}`, { action: 'press', key }, async () => {
      await this.page.keyboard.press(key);
      await this.leaveForeignPage();
    });
  }

  async hover(ref: string, element: string): Promise<string> {
    const target = await this.resolve(ref);
    return this.step(`Hover over "${element}"`, { action: 'hover', element, ...target.recorded }, async () => {
      await target.locator.hover();
    });
  }

  async upload(ref: string, element: string, file: string): Promise<string> {
    const path = join(this.fixturesDir, file.replace(/[\\/]/g, ''));
    if (!existsSync(path)) throw new ToolError(`No test file named ${file}`);
    const target = await this.resolve(ref);
    return this.step(`Upload ${file} with "${element}"`, { action: 'upload', element, file, ...target.recorded }, async () => {
      // A file input takes the file directly; any other button opens a file chooser.
      const isInput = await target.locator.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file').catch(() => false);
      if (isInput) {
        await target.locator.setInputFiles(path);
      } else {
        const chooser = this.page.waitForEvent('filechooser', { timeout: ACTION_TIMEOUT });
        await target.locator.click();
        await (await chooser).setFiles(path);
      }
    });
  }

  async waitFor(opts: { text?: string; textGone?: string; seconds?: number }): Promise<string> {
    if (opts.text) {
      return this.step(`Wait for "${opts.text}" to appear`, { action: 'wait', value: opts.text }, async () => {
        await this.page.getByText(opts.text!).first().waitFor({ state: 'visible', timeout: 15_000 });
      });
    }
    if (opts.textGone) {
      return this.step(`Wait for "${opts.textGone}" to disappear`, { action: 'wait', value: `!${opts.textGone}` }, async () => {
        await this.page.getByText(opts.textGone!).first().waitFor({ state: 'hidden', timeout: 15_000 });
      });
    }
    const ms = Math.min(10, Math.max(0.5, opts.seconds ?? 1)) * 1000;
    return this.step(`Wait ${ms / 1000} seconds`, { action: 'wait', ms }, () => this.page.waitForTimeout(ms));
  }

  async back(): Promise<string> {
    return this.step('Go back', { action: 'back' }, async () => {
      await this.page.goBack({ waitUntil: 'domcontentloaded' });
    });
  }

  /** A check the test depends on. Reported as passed or failed; a failed check is not a tool error. */
  async verify(kind: VerifyKind, opts: { ref?: string; element?: string; expected?: string }): Promise<string> {
    const target = opts.ref ? await this.resolve(opts.ref) : undefined;
    const what = describeVerify(kind, opts.element ?? '', opts.expected ?? '');
    const rec: RecordedStep = { action: 'verify', element: opts.element, verify: { kind, expected: opts.expected }, ...target?.recorded };
    let ok = true;
    let error = '';
    try {
      await runVerify(this.page, kind, target?.locator, opts.expected ?? '');
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message.split('\n')[0] : String(e);
    }
    this.performed.push({ text: `Verify ${what}`, ok, error: ok ? undefined : error });
    if (ok) this.recording.push(rec);
    return ok ? `PASSED: ${what}` : `FAILED: ${what}. ${error}`;
  }

  async screenshot(name: string): Promise<string> {
    const file = join(this.config.outDir, `${name.replace(/[^\w.-]/g, '_')}.png`);
    await this.page.screenshot({ path: file, fullPage: false });
    return file;
  }

  async screenshotBase64(): Promise<string> {
    return (await this.page.screenshot({ fullPage: false, type: 'jpeg', quality: 60 })).toString('base64');
  }

  consoleReport(): string {
    const errors = this.consoleErrors.slice(-20);
    const failed = this.failedRequests.slice(-20);
    return [`Console errors (${this.consoleErrors.length}):`, ...errors, `Failed requests (${this.failedRequests.length}):`, ...failed].join('\n');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────────────────

  /** A ref from the latest snapshot, plus the stable locator to record for replay. */
  private async resolve(ref: string): Promise<{ locator: Locator; recorded: Pick<RecordedStep, 'selector' | 'code'> }> {
    const locator = this.page.getByRef(ref.replace(/^ref=/, ''));
    if ((await locator.count().catch(() => 0)) === 0) {
      throw new ToolError(`No element with ref ${ref}: refs are only valid for the latest snapshot. Take a new snapshot.`);
    }
    try {
      const normal = await locator.normalize();
      if ((await normal.count()) === 1) {
        return { locator, recorded: { selector: (normal as unknown as { _selector: string })._selector, code: normal.toString() } };
      }
    } catch { /* falls through: not replayable */ }
    this.replayable = false;
    return { locator, recorded: {} };
  }

  private async step(text: string, rec: RecordedStep, run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (e) {
      const error = e instanceof ToolError ? e.message : e instanceof Error ? e.message.split('\n')[0] : String(e);
      this.performed.push({ text, ok: false, error });
      throw new ToolError(`${text} failed: ${error}`);
    }
    this.performed.push({ text, ok: true });
    if (rec.action !== 'goto' && !rec.selector && ['click', 'dblclick', 'fill', 'select', 'check', 'uncheck', 'hover', 'upload'].includes(rec.action)) {
      this.replayable = false;
    }
    this.recording.push(rec);
    await settle(this.page);
    return `Done: ${text}. Now at ${this.page.url()}\n${this.takeNotes()}${await visibleMessages(this.page)}`.trim();
  }

  /** {{uid}} in typed text becomes a short id unique to this session, so created records do not clash. */
  private expand(text: string): string {
    return text.replaceAll('{{uid}}', this.uid);
  }

  /** A click that left the site is undone. */
  private async leaveForeignPage() {
    await this.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
    if (this.page.url().startsWith('http') && !this.isAllowed(this.page.url())) {
      this.notes.push(`That led to ${this.page.url()}, outside the site under test: went back.`);
      await this.page.goBack().catch(() => {});
    }
  }

  private takeNotes(): string {
    const notes = this.notes.splice(0);
    return notes.length ? `${notes.join('\n')}\n` : '';
  }
}

/**
 * page.goto that tries again when the connection itself fails (net::ERR_...): tunnels such as ngrok and dev
 * servers drop connections for a few seconds now and then. Timeouts and HTTP errors are not retried.
 */
export async function gotoWithRetry(page: Page, url: string, options: Parameters<Page['goto']>[1]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.goto(url, options);
    } catch (e) {
      // After a failed connection Chrome shows its own error page, which can interrupt the next load too.
      if (attempt >= 3 || !/net::ERR_|chrome-error:/.test(String((e as Error).message))) throw e;
      await page.waitForTimeout(attempt * 5_000);
    }
  }
}

export async function gotoPage(page: Page, url: string) {
  await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded', timeout: setting.pageLoadMs() });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
}

/**
 * Waits until a single-page app has finished drawing: many show their login page while they check the saved
 * session, and draw menus and lists a while after loading. Done once the address and the number of links and
 * controls have stayed the same for 3 seconds, and are not the login page (at most 30 seconds).
 */
export async function waitForSettled(page: Page, loginPath?: string) {
  const started = Date.now();
  const onLoginPage = () => !!loginPath && new URL(page.url()).pathname === loginPath;
  let stable = 0;
  let last = '';
  while (Date.now() - started < 30_000) {
    await page.waitForTimeout(1_000);
    const controls = await page.locator('a[href], button, input, select, textarea, [role="button"], [role="link"]').count().catch(() => 0);
    const now = `${page.url()} ${controls}`;
    stable = !onLoginPage() && now === last ? stable + 1 : 0;
    last = now;
    // A page with no controls at all may still be drawing: give it 10 seconds before accepting that.
    if (stable >= 3 && (controls > 0 || Date.now() - started > 10_000)) return;
  }
}

/** Gives the page a moment to react (requests, rendering) without waiting for a full network idle. */
async function settle(page: Page) {
  await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), page.waitForTimeout(1_500)]);
}

/** Alerts, toasts and status messages currently shown, which often carry the result of an action. */
async function visibleMessages(page: Page): Promise<string> {
  const texts = await page.locator('[role="alert"], [role="status"], [aria-live="assertive"], .toast, [class*="toast" i], [class*="snackbar" i]')
    .filter({ visible: true }).allInnerTexts().catch(() => [] as string[]);
  const unique = [...new Set(texts.map((t) => t.trim()).filter(Boolean))].slice(0, 5);
  return unique.length ? `Messages on the page: ${unique.map((t) => `"${t.slice(0, 200)}"`).join(', ')}` : '';
}

const clip = (s: string) => (s.length > MAX_SNAPSHOT
  ? `${s.slice(0, MAX_SNAPSHOT)}\n… (cut off: ${s.length - MAX_SNAPSHOT} more characters. Take a snapshot of one part with ref=<container ref>.)`
  : s);

export function describeVerify(kind: VerifyKind, element: string, expected: string): string {
  switch (kind) {
    case 'text_visible': return `text "${expected}" is shown`;
    case 'text_not_visible': return `text "${expected}" is not shown`;
    case 'element_visible': return `"${element}" is visible`;
    case 'element_hidden': return `"${element}" is not visible`;
    case 'value': return `"${element}" contains "${expected}"`;
    case 'checked': return `"${element}" is ticked`;
    case 'unchecked': return `"${element}" is not ticked`;
    case 'url_contains': return `the address contains "${expected}"`;
    case 'title_contains': return `the page title contains "${expected}"`;
    case 'enabled': return `"${element}" is enabled`;
    case 'disabled': return `"${element}" is disabled`;
  }
}

/** Throws when the check fails. Shared by the agent's verify tool and replay. */
export async function runVerify(page: Page, kind: VerifyKind, locator: Locator | undefined, expected: string): Promise<void> {
  const need = () => {
    if (!locator) throw new Error('This check needs an element ref');
    return locator;
  };
  const poll = async (check: () => Promise<boolean>, message: () => Promise<string>) => {
    const deadline = Date.now() + VERIFY_TIMEOUT;
    while (!(await check().catch(() => false))) {
      if (Date.now() > deadline) throw new Error(await message().catch(() => 'check failed'));
      await page.waitForTimeout(250);
    }
  };
  switch (kind) {
    case 'text_visible':
      return void await page.getByText(expected).first().waitFor({ state: 'visible', timeout: VERIFY_TIMEOUT })
        .catch(() => { throw new Error(`"${expected}" is not shown on the page`); });
    case 'text_not_visible':
      return poll(async () => !(await page.getByText(expected).filter({ visible: true }).count()), async () => `"${expected}" is still shown`);
    case 'element_visible':
      return void await need().waitFor({ state: 'visible', timeout: VERIFY_TIMEOUT }).catch(() => { throw new Error('the element is not visible'); });
    case 'element_hidden':
      return void await need().waitFor({ state: 'hidden', timeout: VERIFY_TIMEOUT }).catch(() => { throw new Error('the element is still visible'); });
    case 'value':
      return poll(async () => (await need().inputValue()).includes(expected), async () => `the value is "${await need().inputValue()}"`);
    case 'checked':
      return poll(() => need().isChecked(), async () => 'it is not ticked');
    case 'unchecked':
      return poll(async () => !(await need().isChecked()), async () => 'it is ticked');
    case 'url_contains':
      return poll(async () => page.url().includes(expected), async () => `the address is ${page.url()}`);
    case 'title_contains':
      return poll(async () => (await page.title()).includes(expected), async () => `the title is "${await page.title()}"`);
    case 'enabled':
      return poll(() => need().isEnabled(), async () => 'it is disabled');
    case 'disabled':
      return poll(async () => !(await need().isEnabled()), async () => 'it is enabled');
  }
}
