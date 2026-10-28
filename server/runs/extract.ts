// "Extract URLs": logs in, follows the site's links from the website address (and the pages already listed),
// and adds every new page it finds to "Pages found automatically", so the QA sees them before running any test.
// No AI is used, so it costs nothing.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir } from '../config.js';
import { pages as pagesDb, projects } from '../db.js';
import { pickExtraPages, sameSiteLinks } from '../browser/checks.js';
import { login, LoginError } from '../browser/login.js';
import { BrowserSession, gotoPage, waitForSettled } from '../browser/session.js';
import type { ExtractJob } from '../types.js';

// Enough to cover a typical app's menus without the job running for many minutes on a big site.
const MAX_ADDED = 40;
const MAX_VISITS = 60;
const TIME_LIMIT_MS = 6 * 60_000;

const jobs = new Map<string, ExtractJob>();

export const extractJob = (projectId: string) => jobs.get(projectId) ?? null;

/** Starts extracting the project's URLs in the background, unless it is already running. */
export function startExtract(projectId: string): ExtractJob {
  const running = jobs.get(projectId);
  if (running?.status === 'running') return running;
  const job: ExtractJob = { status: 'running', message: 'Starting', added: 0, startedAt: new Date().toISOString() };
  jobs.set(projectId, job);
  extract(projectId, job).then(
    () => { job.status = 'done'; },
    (e: unknown) => { job.status = 'failed'; job.message = e instanceof Error ? e.message : String(e); },
  );
  return job;
}

async function extract(projectId: string, job: ExtractJob) {
  const project = projects.get(projectId, true);
  if (!project) throw new Error('Project not found');
  const dir = join(projectDir(projectId), 'extract');
  rmSync(dir, { recursive: true, force: true });
  const log = (line: string) => { job.message = line; };

  let storageState: string | undefined;
  if (project.login?.username && project.login.password) {
    storageState = join(dir, 'auth.json');
    try {
      await login({
        loginUrl: project.login.loginUrl || project.baseUrl, targetUrl: project.baseUrl, username: project.login.username,
        password: project.login.password, rememberMe: project.login.rememberMe, selectors: project.login.selectors,
        statePath: storageState, screenshotFile: join(dir, 'login-failed.png'), log,
      });
    } catch (e) {
      const hint = e instanceof LoginError && e.kind === 'form' ? ' Set the login form selectors in the project settings.' : '';
      throw new Error(`${e instanceof Error ? e.message : String(e)}${hint}`);
    }
  }

  const listed = pagesDb.list(projectId);
  const loginPath = project.login?.loginUrl ? new URL(project.login.loginUrl).pathname : null;
  const origins = [...new Set([project.baseUrl, ...listed.map((p) => p.url)].map((u) => new URL(u).origin))];
  const session = new BrowserSession({
    startUrl: project.baseUrl, allowedOrigins: origins, storageState, headless: true, outDir: dir, dataMode: 'read-only',
    loginPath: loginPath ?? undefined,
  });
  // The login page is never a page to test (and is where a lost session sends every link).
  const known = [...listed.map((p) => p.url), ...(project.login?.loginUrl ? [project.login.loginUrl] : [])];
  const add = (url: string, name: string) => {
    pagesDb.create(projectId, { url, name, instructions: '', checklist: [], onlyMyTests: false }, true);
    known.push(url);
    job.added++;
  };
  // The website address itself is a page to test too, as when a run explores the site.
  if (pickExtraPages([project.baseUrl], known, 1).length) add(project.baseUrl, 'Home');

  const queue = [project.baseUrl, ...listed.map((p) => p.url)];
  const visited = new Set<string>();
  const deadline = Date.now() + TIME_LIMIT_MS;
  // Pages that could not be read, so "nothing found" is never reported when the extraction did not work.
  const problems: string[] = [];
  let linksSeen = 0;
  try {
    await session.start();
    const page = session.page;
    const onLoginPage = () => loginPath !== null && new URL(page.url()).pathname === loginPath;
    while (queue.length && visited.size < MAX_VISITS && job.added < MAX_ADDED && Date.now() < deadline) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      log(`Looking for links on ${url} (${job.added} page${job.added === 1 ? '' : 's'} added so far)`);
      const error = await gotoPage(page, url).then(() => null, (e: Error) => e.message.split('\n')[0]);
      if (error) {
        problems.push(`${url} did not open (${error})`);
        continue;
      }
      await waitForSettled(page, loginPath ?? undefined);
      const links = await sameSiteLinks(page, origins).catch(() => []);
      if (onLoginPage()) {
        problems.push(`${url} went to the login page (the login did not hold)`);
        continue;
      }
      linksSeen += links.length;
      // Where the link led (e.g. "/" → "/services") is a page too.
      for (const found of pickExtraPages([page.url(), ...links], known, MAX_ADDED - job.added)) {
        add(found, new URL(found).pathname);
        queue.push(found);
      }
    }
  } finally {
    await session.close();
  }
  projects.touch(projectId);
  if (!job.added && !linksSeen && problems.length) throw new Error(`No links could be read: ${problems.slice(0, 3).join('; ')}`);
  job.message = job.added
    ? `Added ${job.added} page${job.added === 1 ? '' : 's'}${job.added >= MAX_ADDED ? ` (the limit is ${MAX_ADDED} at a time: extract again for more)` : ''}`
    : linksSeen
      ? `No new pages found: the ${linksSeen} links found lead to pages already in the list`
      : 'No links found on the site. Its menus may not be links (buttons that open pages): add the pages by hand, or let a run explore the site';
}
