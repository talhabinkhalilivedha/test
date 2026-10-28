// Logs in with a username and password and saves the browser session to a file, which every agent and
// replay of the run then reuses. The credentials never reach the AI agents.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';
import { setting } from '../config.js';
import { gotoWithRetry } from './session.js';
import { restoreSessionStorage, saveSessionStorage } from './session-storage.js';

export interface LoginOptions {
  loginUrl: string;
  /** The site under test: after logging in it must open without being sent back to the login form. */
  targetUrl: string;
  username: string;
  password: string;
  /**
   * CSS selectors, only needed when auto-detection picks the wrong elements. `open` is the button
   * that shows the login form when it is a modal instead of a page; `remember` the "Remember me" checkbox.
   */
  selectors?: { open?: string; username?: string; password?: string; submit?: string; remember?: string };
  /** `auto` (the default) ticks a "Remember me" checkbox when the form has one; `off` leaves it alone. */
  rememberMe?: 'auto' | 'off';
  headed?: boolean;
  /** Where to save the logged-in session. */
  statePath: string;
  /** Where to save a screenshot when the login fails. */
  screenshotFile: string;
  log: (line: string) => void;
}

// Fields that clearly ask for a username or email (a search box is not one of them).
const USERNAME_STRICT = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[name*="user" i]', 'input[id*="user" i]',
  'input[name*="email" i]', 'input[id*="email" i]',
  'input[name*="login" i]', 'input[id*="login" i]',
].join(', ');
const USERNAME_GUESS = `${USERNAME_STRICT}, input[type="text"]`;
// Exact names only, so "Continue with Google/Microsoft" (SSO) buttons are never clicked.
const SUBMIT_NAME = /^\s*(log ?in|sign ?in|continue|next|submit)\s*$/i;
// Buttons or links that open a login modal (or lead to a login page): "Log in", "Member login",
// "Sign in / Register", "Sign up or log in", ...
const OPEN_NAME = /^\s*(((member|customer|user)\s+)?(log ?in|sign ?in)(\s*(\/|\||&|or)\s*(sign ?up|register|join))?|(sign ?up|register|join)\s*(\/|\||&|or)\s*(log ?in|sign ?in))\s*$/i;
// An account button or icon, which opens the login modal or a menu with the login entry in it.
const ACCOUNT_NAME = /^\s*(my\s+)?(account|profile|user)\s*$/i;
// Cookie and consent banners can cover the page, including the button that opens the login modal.
const CONSENT_NAME = /^\s*(accept|allow|agree|i agree|got it|ok|okay)(\s+(all|cookies|all cookies|and close|& close))?\s*$/i;
// "Remember me" and the like: many sites keep the login only for the browser tab unless it is ticked.
const REMEMBER_NAME = /remember|keep me (signed|logged) in|stay (signed|logged) in|trust this (device|browser|computer)/i;
const DIALOG = '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]';
const MESSAGES = '[role="alert"], [aria-live], .error, .alert, .toast, [class*="error" i], [class*="invalid" i], [class*="danger" i], [class*="text-red" i]';

const shown = (scope: Page | Locator, selector: string) => scope.locator(selector).filter({ visible: true }).first();

export type LoginSelectors = NonNullable<LoginOptions['selectors']>;

/**
 * Why a login failed. Only `form` (the form, its fields or buttons were not found or did not work)
 * can be fixed by setting the selectors; the others are not fixed by better selectors.
 */
export class LoginError extends Error {
  constructor(message: string, readonly kind: 'form' | 'credentials' | 'session' | 'network') {
    super(message);
  }
}

// Some sites ship a huge script bundle over a slow link (one took 80 seconds), and the page only counts as
// loaded once it has run. So the server only has to answer within two minutes, and the page gets PAGE_LOAD_TIMEOUT
// (5 minutes by default) to load.
async function openPage(page: Page, url: string, log: (m: string) => void) {
  const started = Date.now();
  await gotoWithRetry(page, url, { waitUntil: 'commit', timeout: 120_000 });
  await page.waitForLoadState('domcontentloaded', { timeout: setting.pageLoadMs() });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (seconds > 30) log(`${url} took ${seconds} seconds to load: tests on this site will be slow`);
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

export async function login(o: LoginOptions): Promise<void> {
  const browser = await chromium.launch({ headless: !o.headed });
  try {
    const page = await browser.newPage();
    o.log(`Logging in at ${o.loginUrl}${o.selectors && Object.values(o.selectors).some(Boolean) ? ` with selectors ${JSON.stringify(o.selectors)}` : ''}`);
    await openPage(page, o.loginUrl, o.log).catch((e) => {
      throw new LoginError(`Login failed: could not open ${o.loginUrl}: ${String(e.message).split('\n')[0]}`, 'network');
    });

    const passwordSelector = o.selectors?.password ?? 'input[type="password"]';
    // A message on the page (e.g. "Wrong password") means the form worked and the credentials were refused.
    const fail = async (reason: string) => {
      await page.screenshot({ path: o.screenshotFile, fullPage: true }).catch(() => {});
      const texts = (await page.locator(MESSAGES).filter({ visible: true }).allInnerTexts().catch(() => []))
        .map((t) => t.trim()).filter(Boolean);
      const message = texts.length ? ` The page says: "${[...new Set(texts)].join(' / ').slice(0, 300)}".` : '';
      return new LoginError(`Login failed: ${reason}.${message} Screenshot: ${o.screenshotFile}`, texts.length ? 'credentials' : 'form');
    };
    let modal = false;
    let loginPath = '';
    let ownLoginPage = false;
    // Any other Playwright error here (a click or fill that times out) also means the form was not handled right.
    try {
      await acceptConsent(page, o.log);
      // Login modal: no form on the page until a "Log in" / "Sign in" button opens it.
      const openButton = (o.selectors?.open ? page.locator(o.selectors.open) : loginTriggers(page)).filter({ visible: true }).first();
      const formShown = async () => (await shown(page, passwordSelector).isVisible())
        || (await shown(page, o.selectors?.username ?? USERNAME_STRICT).isVisible());
      if (!(await formShown())) {
        const before = page.url();
        await openLoginForm(page, o, openButton, formShown, fail);
        // A button that leads to a login page is not a modal: that page then works like any other login page.
        modal = page.url() === before;
      }
      loginPath = new URL(page.url()).pathname;

      // Look for the fields inside a modal when there is a proper one, so a search box behind it is never used.
      const fields = page.locator(`${passwordSelector}, ${o.selectors?.username ?? USERNAME_STRICT}`);
      const dialog = page.locator(DIALOG).filter({ visible: true }).filter({ has: fields }).last();
      const scope: Page | Locator = (await dialog.count()) ? dialog : page;
      if (scope !== page) modal = true;
      const passwordField = shown(scope, passwordSelector);
      // Next to a password field, the username is the matching field of the same form.
      const usernameField = o.selectors?.username
        ? shown(page, o.selectors.username)
        : await (async () => {
          const near = (await passwordField.isVisible()) ? await formAround(page, passwordField) : scope;
          const strict = shown(near, USERNAME_STRICT);
          return (await strict.isVisible()) ? strict : shown(near, USERNAME_GUESS);
        })();
      // The submit button is looked up inside the form around the field: a "Sign in" button elsewhere,
      // such as the one in the header that opened the modal, is never the one that gets clicked.
      const submit = async (field: Locator) => submitButton(await formAround(page, field), page, o.selectors?.submit);

      // Two-step logins (email, "Next", then password) show the password field only after the first submit.
      await usernameField.fill(o.username, { timeout: 15_000 });
      if (!(await passwordField.isVisible())) {
        await tickRememberMe(page, await formAround(page, usernameField), o);
        await (await submit(usernameField)).click({ timeout: 15_000 });
        await passwordField.waitFor({ timeout: 15_000 }).catch(() => {});
        if (!(await passwordField.isVisible())) throw await fail('no password field appeared after entering the username');
      }
      await passwordField.fill(o.password, { timeout: 15_000 });
      await tickRememberMe(page, await formAround(page, passwordField), o);
      await (await submit(passwordField)).click({ timeout: 15_000 });

      // Logged in once the login form is gone for good (a loading state alone can hide it briefly):
      // - login page: the browser has also left that page
      // - login modal: the "Log in" button that opened it is gone too
      ownLoginPage = !modal && loginPath !== new URL(o.targetUrl).pathname;
      const loginShown = shown(page, passwordSelector);
      const loggedIn = async () => !(await loginShown.isVisible())
        && (!ownLoginPage || new URL(page.url()).pathname !== loginPath)
        && (!modal || !(await openButton.isVisible()));
      const deadline = Date.now() + 30_000;
      let stable = 0;
      while (Date.now() < deadline && stable < 3) {
        await page.waitForTimeout(1_000);
        stable = (await loggedIn()) ? stable + 1 : 0;
      }
      if (stable < 3) {
        throw await fail(modal && !(await loginShown.isVisible())
          ? `the login modal closed but the "Log in" button is still shown (at ${page.url()}). Check the username and password`
          : `still on the login form after 30 seconds (at ${page.url()}). Check the username and password, or set the login form selectors`);
      }
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    } catch (e) {
      if (e instanceof LoginError) throw e;
      throw await fail(String((e as Error).message).split('\n')[0]);
    }

    mkdirSync(dirname(o.statePath), { recursive: true });
    await page.context().storageState({ path: o.statePath });
    const sessionItems = await saveSessionStorage(page, o.statePath);
    o.log(`Logged in${modal ? ' through the login modal' : ''}, now at ${page.url()}`
      + (sessionItems ? ` (also saved ${sessionItems} sessionStorage entries)` : ''));

    // The agents and tests start fresh browsers with only the saved session: make sure that is enough.
    const checkContext = await browser.newContext({ storageState: o.statePath });
    await restoreSessionStorage(checkContext, o.statePath);
    const check = await checkContext.newPage();
    await openPage(check, o.targetUrl, o.log);
    const checkOpen = o.selectors?.open ? check.locator(o.selectors.open) : loginTriggers(check);
    const loggedOut = async () => (await shown(check, passwordSelector).isVisible())
      || (ownLoginPage && new URL(check.url()).pathname === loginPath)
      || (modal && (await checkOpen.filter({ visible: true }).count()) > 0);
    // Many apps first show the login page (often with only a spinner) while they check the saved session, and
    // move on once it is confirmed: only a page that stays logged out for 30 seconds means the session is lost.
    const checkDeadline = Date.now() + 30_000;
    let stableIn = 0;
    while (Date.now() < checkDeadline && stableIn < 3) {
      await check.waitForTimeout(1_000);
      stableIn = (await loggedOut()) ? 0 : stableIn + 1;
    }
    if (stableIn < 3) {
      await check.screenshot({ path: o.screenshotFile, fullPage: true }).catch(() => {});
      throw new LoginError(`Login worked, but a new browser with the saved session (cookies, localStorage and sessionStorage) `
        + `is logged out again (${check.url()}). The site may tie the login to the browser tab or keep it only in memory`
        + `${o.rememberMe === 'off' ? '; try turning "Remember me" back on in the project settings' : ''}. Screenshot: ${o.screenshotFile}`, 'session');
    }
    o.log(`Session saved and verified: ${o.targetUrl} opens logged in (${check.url()})`);
  } finally {
    await browser.close();
  }
}

/**
 * Ticks the "Remember me" checkbox of the login form, if it has one, so the site keeps the login in cookies or
 * localStorage (which outlast the browser) rather than sessionStorage.
 */
async function tickRememberMe(page: Page, form: Locator, o: LoginOptions) {
  if (o.rememberMe === 'off') return;
  const box = (o.selectors?.remember ? page.locator(o.selectors.remember)
    : form.getByRole('checkbox', { name: REMEMBER_NAME }).or(form.getByRole('switch', { name: REMEMBER_NAME }))).first();
  if (!(await box.count())) {
    if (o.selectors?.remember) o.log(`The "Remember me" checkbox (${o.selectors.remember}) was not found: logging in without it`);
    return;
  }
  if (await box.isChecked().catch(() => false)) return;
  // Styled checkboxes hide the real input: then clicking its label ticks it.
  const ticked = await box.check({ timeout: 5_000 }).then(() => true, async () => {
    await form.locator('label').filter({ hasText: REMEMBER_NAME }).first().click({ timeout: 5_000 }).catch(() => {});
    return box.isChecked().catch(() => false);
  });
  o.log(ticked ? 'Ticked "Remember me" so the login is kept' : 'Found a "Remember me" checkbox but could not tick it');
}

/** Elements that open a login form: buttons, links and menu entries, or any clickable text such as a <div>. */
function loginTriggers(page: Page): Locator {
  return page.getByRole('button', { name: OPEN_NAME }).or(page.getByRole('link', { name: OPEN_NAME }))
    .or(page.getByRole('menuitem', { name: OPEN_NAME })).or(page.getByText(OPEN_NAME));
}

/** Accepts a cookie or consent banner, so it does not cover the page. Accepted consent is saved with the session. */
async function acceptConsent(page: Page, log: (m: string) => void) {
  const accept = page.getByRole('button', { name: CONSENT_NAME }).or(page.getByRole('link', { name: CONSENT_NAME })).filter({ visible: true });
  for (let i = 0; i < 2 && (await accept.count().catch(() => 0)); i++) {
    const name = (await accept.first().innerText().catch(() => '')).trim();
    if (!(await accept.first().click({ timeout: 5_000 }).then(() => true, () => false))) return;
    log(`Clicked "${name}" on a cookie or consent banner`);
    await page.waitForTimeout(500);
  }
}

/**
 * Shows the login form when the page has none: it may still pop up by itself, or open with a "Log in"
 * button, or sit in the menu of an account button or icon.
 */
async function openLoginForm(page: Page, o: LoginOptions, openButton: Locator, formShown: () => Promise<boolean>, fail: (reason: string) => Promise<LoginError>) {
  const waitForForm = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (!(await formShown()) && Date.now() < deadline) await page.waitForTimeout(500);
    return formShown();
  };
  const click = async (target: Locator) => {
    o.log(`No login form on the page: clicking "${(await target.getAttribute('aria-label').catch(() => null)) || (await target.innerText().catch(() => '')).trim() || 'login'}" to open it`);
    // Something covering the button (a banner, a popup) makes the click time out: clear it and try once more.
    await target.click({ timeout: 5_000 }).catch(async () => {
      if (await formShown()) return;
      await acceptConsent(page, o.log);
      await target.click({ timeout: 10_000 });
    });
  };
  if (await waitForForm(2_000)) return;
  if (await openButton.isVisible()) {
    await click(openButton);
    if (await waitForForm(15_000)) return;
    throw await fail('clicking the login button did not show a login form');
  }
  const account = page.getByRole('button', { name: ACCOUNT_NAME }).or(page.getByRole('link', { name: ACCOUNT_NAME }))
    .filter({ visible: true }).first();
  if (!o.selectors?.open && (await account.isVisible())) {
    await click(account);
    if (await waitForForm(1_500)) return;
    // The account button opened a menu: the login entry is in it.
    if (await openButton.isVisible()) {
      await click(openButton);
      if (await waitForForm(15_000)) return;
    }
    throw await fail('the account button showed no login form and no "Log in" / "Sign in" entry. Set the login form selectors');
  }
  throw await fail('found no login form and no "Log in" / "Sign in" or account button to open one. Set the login form selectors');
}

/**
 * The form a field belongs to: its <form>, or else the nearest element around it that also holds a
 * button with a label (an icon-only "show password" button does not count).
 */
async function formAround(page: Page, field: Locator): Promise<Locator> {
  const found = await field.evaluate((el) => {
    document.querySelectorAll('[data-qa-login-form]').forEach((n) => n.removeAttribute('data-qa-login-form'));
    let node: Element | null = el.closest('form');
    for (let up = el.parentElement; !node && up && up !== document.body; up = up.parentElement) {
      const labelled = [...up.querySelectorAll('button, input[type="submit"], [role="button"]')]
        .some((b) => (b.textContent ?? '').trim() || (b as HTMLInputElement).value);
      if (labelled) node = up;
    }
    node?.setAttribute('data-qa-login-form', '');
    return !!node;
  }).catch(() => false);
  return found ? page.locator('[data-qa-login-form]') : page.locator('body');
}

function submitButton(scope: Page | Locator, page: Page, selector?: string): Locator {
  if (selector) return page.locator(selector).filter({ visible: true }).first();
  return scope.locator('button[type="submit"], input[type="submit"]')
    .or(scope.getByRole('button', { name: SUBMIT_NAME }))
    .filter({ visible: true })
    .first();
}
