import { chromium } from 'playwright';
import { projects } from '../server/db.ts';

const project = projects.get('0be87f2801444f2c', true);
const { username, password, loginUrl } = project.login;
console.log('user', username, 'loginUrl', loginUrl);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(loginUrl || project.baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForSelector('input[type=password]', { timeout: 60_000 });

const boxes = await page.locator('input[type=checkbox]').evaluateAll((els) => els.map((e) => ({
  id: e.id,
  name: e.name,
  checked: e.checked,
  label: (e.labels?.[0]?.innerText || e.getAttribute('aria-label') || e.parentElement?.innerText || '').slice(0, 100),
})));
console.log('checkboxes', JSON.stringify(boxes));

const user = page.locator('input[type=email], input[autocomplete=username], input[name*=user i], input[id*=user i], input[type=text]').first();
await user.fill(username);
await page.locator('input[type=password]').fill(password);

for (const box of await page.locator('input[type=checkbox]').all()) {
  const text = (await box.evaluate((e) => e.labels?.[0]?.innerText || e.parentElement?.innerText || '')).toLowerCase();
  if (/remember/.test(text) && !(await box.isChecked())) {
    await box.check({ force: true });
    console.log('checked remember');
  }
}

await page.getByRole('button', { name: /^\s*log ?in\s*$/i }).click();
await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 60_000 }).catch(() => {});
await page.waitForTimeout(3000);
console.log('after login url', page.url());

const dump = await page.evaluate(() => ({
  url: location.href,
  documentCookie: document.cookie,
  localStorageKeys: Object.keys(localStorage),
  sessionStorageKeys: Object.keys(sessionStorage),
  sessionStorage: Object.fromEntries(Object.entries({ ...sessionStorage }).map(([k, v]) => [k, String(v).slice(0, 120)])),
  localStorageSample: Object.fromEntries(Object.entries({ ...localStorage }).map(([k, v]) => [k, String(v).slice(0, 80)])),
}));
console.log(JSON.stringify(dump, null, 2));
console.log('pw cookies', JSON.stringify((await page.context().cookies()).map((c) => ({ name: c.name, domain: c.domain, httpOnly: c.httpOnly }))));

await browser.close();
