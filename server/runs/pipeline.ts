// One test run: login → automatic checks (+ page discovery) → plan → [review] → execute → cleanup → report.
// A re-run (options.caseIds) only logs in and executes the chosen test cases, often with the browser shown.
//
// Where the cost goes, and how it is kept down:
// - Automatic checks (console, links, images, accessibility, layout, load time) use no AI at all.
// - A page's AI test plan is cached and reused while the page's controls and its settings are unchanged.
// - A test that passed once is recorded; later runs replay it with Playwright for free. Only when the replay
//   breaks (the site changed) does an AI agent take over, and its new recording replaces the old one.
// - Steps are carried out by the fast (cheap) model. The strong model only plans, takes over when the fast
//   model gets stuck, and re-checks failures before they are reported as bugs.
// - A cost cap stops new AI work once a run has spent its budget.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runDir } from '../config.js';
import { pages as pagesDb, projects, results, runs, testCases } from '../db.js';
import { readState, resolveProvider, runAgent, type AgentOutcome } from '../ai/agent.js';
import { CLEANUP_SYSTEM, cleanupPrompt, EXECUTE_SYSTEM, executePrompt, PLAN_SYSTEM, planPrompt } from '../ai/prompts.js';
import { visitPage, pickExtraPages } from '../browser/checks.js';
import { login, LoginError } from '../browser/login.js';
import { replay } from '../browser/replay.js';
import type { SessionConfig } from '../browser/session.js';
import {
  CHECKLIST, DEFAULT_MODELS, type PageConfig, type PerformedStep, type Project, type Run, type RunOptions, type RunSummary,
  type TestCase, type TestResult,
} from '../types.js';
import { events } from './events.js';

class FatalError extends Error {}

export async function executeRun(runId: string, stopSignal: AbortSignal, waitForReview: () => Promise<void>): Promise<void> {
  // A fatal error (e.g. the AI provider is not logged in) stops all parallel work, like the Stop button.
  const internal = new AbortController();
  const signal = AbortSignal.any([stopSignal, internal.signal]);
  let fatal: string | null = null;
  const run = runs.get(runId)!;
  const project = projects.get(run.projectId, true)!;
  const dir = runDir(project.id, run.id);
  const log = (line: string) => events.log(run, line);
  const setRun = (fields: Parameters<typeof runs.update>[1]) => {
    runs.update(run.id, fields);
    events.publish(run.id, { type: 'run', run: runs.get(run.id)! });
  };
  const progress = (phase: Run['phase'], done: number, total: number, active: string[] = []) =>
    events.publish(run.id, { type: 'progress', progress: { phase, done, total, active } });

  const o = { ...run.options };
  const provider = resolveProvider(o.provider);
  if (provider !== o.provider) {
    log(`No API key for ${o.provider}: using the claude CLI (your Claude subscription) instead`);
    o.strongModel = DEFAULT_MODELS[provider].strong;
    o.fastModel = DEFAULT_MODELS[provider].fast;
  }
  let costUsd = 0;
  const spend = (usd: number) => {
    costUsd += usd;
    setRun({ costUsd });
  };
  const overBudget = () => o.costCapUsd > 0 && costUsd >= o.costCapUsd;
  let budgetWarned = false;
  const budgetLeft = () => {
    if (!overBudget()) return true;
    if (!budgetWarned) log(`Cost cap of $${o.costCapUsd.toFixed(2)} reached: no more AI work in this run (replays and checks continue)`);
    budgetWarned = true;
    return false;
  };

  let base: Omit<SessionConfig, 'startUrl' | 'outDir'> = { allowedOrigins: [project.baseUrl], headless: !o.headed, dataMode: o.dataMode };
  const rerun = o.caseIds.length > 0;
  const caseById = new Map<string, TestCase>();
  setRun({ status: 'running', phase: 'login', startedAt: new Date().toISOString() });
  if (rerun) log(`Re-running ${o.caseIds.length} test case(s)${o.rerunOf ? ` from run ${o.rerunOf}` : ''}${o.headed ? ' with the browser shown' : ''}`);
  log(`Run started for ${project.baseUrl} · ${provider} · plan: ${o.strongModel} · steps: ${o.fastModel} · ${o.depth} · ${o.dataMode}`);

  try {
    let pageList = pagesDb.list(project.id).filter((p) => (o.pageIds.length ? o.pageIds.includes(p.id) : !p.discovered || o.discoverPages));
    const foundPages = pagesDb.list(project.id).filter((p) => p.discovered);
    if (!pageList.length && !o.pageIds.length && foundPages.length > 1) {
      // No pages given, but the site's pages were found before (with "Extract URLs" or by exploring): test those.
      pageList = foundPages;
      log(`No pages listed: testing the ${foundPages.length} pages found on the site`);
    } else if (!pageList.length) {
      // No pages given: start from the website address and explore the site from there.
      pageList = pagesDb.list(project.id).filter((p) => p.url.replace(/\/$/, '') === project.baseUrl.replace(/\/$/, ''));
      if (!pageList.length) pageList = [pagesDb.create(project.id, { url: project.baseUrl, name: 'Home', instructions: '', checklist: [], onlyMyTests: false }, true)];
      o.discoverPages = true;
      log('No pages listed: exploring the whole site, starting from the website address');
    }
    const origins = [...new Set([project.baseUrl, ...pageList.map((p) => p.url)].map((u) => new URL(u).origin))];
    const loginPath = project.login?.loginUrl ? new URL(project.login.loginUrl).pathname : undefined;
    base = { allowedOrigins: origins, headless: !o.headed, dataMode: o.dataMode, loginPath };

    // ── 1. Login ──
    if (project.login?.username && project.login.password) {
      const statePath = join(dir, 'auth.json');
      try {
        await login({
          loginUrl: project.login.loginUrl || project.baseUrl, targetUrl: pageList[0].url, username: project.login.username,
          password: project.login.password, rememberMe: project.login.rememberMe, selectors: project.login.selectors, headed: o.headed, statePath,
          screenshotFile: join(dir, 'login-failed.png'), log,
        });
      } catch (e) {
        const hint = e instanceof LoginError && e.kind === 'form' ? ' Set the login form selectors in the project settings.' : '';
        fatal = `${e instanceof Error ? e.message : String(e)}${hint}`;
        throw new FatalError(fatal);
      }
      base.storageState = statePath;
    }
    check(signal);

    // ── 2. Automatic checks, and discovering extra pages ──
    if (!rerun) setRun({ phase: 'checks' });
    const fingerprints = new Map<string, string>();
    const runChecks = async (page: PageConfig) => {
      const autoIds = autoChecksFor(page);
      log(`Checking ${page.name || page.url} (no AI): ${autoIds.length ? autoIds.join(', ') : 'opening it'}`);
      const started = Date.now();
      const visit = await visitPage(page.url, autoIds, { ...base, startUrl: page.url, outDir: join(dir, 'checks') });
      fingerprints.set(page.id, visit.fingerprint);
      for (const c of visit.checks) {
        addResult({
          testCaseId: null, pageId: page.id, ref: `CHK-${c.check}`, title: c.title, category: 'automatic', status: c.status, mode: 'check',
          steps: c.steps.map((text) => ({ text, ok: true })), expected: c.expected, actual: c.actual, bug: c.bug, classification: null,
          screenshot: visit.screenshot && c.check === 'responsive' ? rel(visit.screenshot) : null,
          costUsd: 0, durationMs: Math.round((Date.now() - started) / Math.max(1, visit.checks.length)), model: '',
        });
      }
      return visit.links;
    };
    const allLinks: string[] = [];
    for (const [i, page] of (rerun ? [] : pageList).entries()) {
      check(signal);
      progress('checks', i, pageList.length, [page.name || page.url]);
      allLinks.push(...await runChecks(page));
    }
    // Follow links level by level: pages found on discovered pages are discovered too, up to maxExtraPages.
    let links = allLinks;
    let found = 0;
    while (o.discoverPages && found < o.maxExtraPages && links.length) {
      const known = [...pagesDb.list(project.id), ...pageList].map((p) => p.url);
      const extra = pickExtraPages(links, known, o.maxExtraPages - found);
      if (!extra.length) break;
      log(`Discovered ${extra.length} more page(s): ${extra.join(', ')}`);
      links = [];
      for (const url of extra) {
        check(signal);
        const page = pagesDb.create(project.id, { url, name: new URL(url).pathname, instructions: '', checklist: [], onlyMyTests: false }, true);
        pageList.push(page);
        found++;
        links.push(...await runChecks(page));
      }
    }
    if (o.discoverPages && !found) log('No further pages discovered');

    // ── 3. Plan ──
    if (!rerun) setRun({ phase: 'plan' });
    let planned = 0;
    await pool(rerun ? [] : pageList, Math.min(o.concurrency, 3), async (page) => {
      check(signal);
      const name = page.name || page.url;
      if (page.onlyMyTests) return log(`${name}: only your own test cases are run (no AI planning)`);
      const key = planKey(project, page, o, fingerprints.get(page.id) ?? '');
      const cache = pagesDb.planCache(page.id);
      const existing = testCases.byPage(page.id).filter((t) => t.source === 'ai');
      if (!o.fresh && cache?.planKey === key && existing.length) {
        return log(`${name}: page unchanged, reusing ${existing.length} planned test case(s) (no AI cost)`);
      }
      if (!budgetLeft()) return;
      log(`${name}: exploring the page and planning tests with ${o.strongModel}`);
      progress('plan', planned, pageList.length, [name]);
      const mine = testCases.byPage(page.id).filter((t) => t.source !== 'ai');
      const out = await agent({
        model: o.strongModel, mode: 'plan', system: PLAN_SYSTEM, startUrl: page.url, name: `plan-${slug(name)}`,
        prompt: planPrompt({ page, projectInstructions: project.instructions, depth: o.depth, dataMode: o.dataMode, maxTests: o.maxTestsPerPage, existing: mine }),
      }, `plan ${name}`);
      const plan = out.state?.plan;
      if (!plan) {
        log(`${name}: planning failed (${out.error ?? 'no plan reported'}); only existing test cases will run`);
        return;
      }
      testCases.deleteAiForPage(page.id);
      const prefix = `AI-${pageList.indexOf(page) + 1}`;
      plan.testCases.slice(0, o.maxTestsPerPage || undefined).forEach((t, i) => testCases.create(project.id, page.id, {
        source: 'ai', ref: `${prefix}-${String(i + 1).padStart(2, '0')}`, title: t.title, category: t.category, priority: t.priority,
        preconditions: t.preconditions, steps: t.steps, expected: t.expected, testData: t.testData,
      }));
      pagesDb.setPlanCache(page.id, key, fingerprints.get(page.id) ?? '');
      planned++;
      log(`${name}: found ${plan.features.length} feature(s), planned ${Math.min(plan.testCases.length, o.maxTestsPerPage || Infinity)} test case(s) ($${out.costUsd.toFixed(3)})`);
    });

    // ── 4. Review ──
    if (o.review) {
      setRun({ status: 'review', phase: 'review' });
      log('Waiting for a QA to review the test cases');
      await waitForReview();
      check(signal);
      setRun({ status: 'running' });
      log('Test cases approved');
    }

    // ── 5. Execute ──
    setRun({ phase: 'execute' });
    const todo = rerun
      ? o.caseIds.map((id) => rerunCase(o.rerunOf, id)).filter((t) => t !== null)
        .flatMap((test) => pageList.filter((p) => p.id === test.pageId).map((page) => ({ page, test })))
      : pageList.flatMap((page) => testCases.byPage(page.id)
        .filter((t) => t.enabled && !(page.onlyMyTests && t.source === 'ai'))
        .map((t) => ({ page, test: t })));
    for (const { test } of todo) caseById.set(test.id, test);
    const replayable = todo.filter((t) => t.test.recording && !o.fresh).length;
    log(`Running ${todo.length} test case(s): ${replayable} can be replayed without AI, ${todo.length - replayable} need an AI agent`);
    let done = 0;
    const active = new Set<string>();
    await pool(todo, o.concurrency, async ({ page, test }) => {
      check(signal);
      active.add(test.title);
      progress('execute', done, todo.length, [...active]);
      await executeCase(page, test);
      active.delete(test.title);
      progress('execute', ++done, todo.length, [...active]);
    });

    // ── 6. Cleanup ──
    if (o.cleanup && o.dataMode !== 'read-only') {
      setRun({ phase: 'cleanup' });
      const created = new Set(results.byRun(run.id).filter((r) => r.mode !== 'check' && r.steps.some((s) => s.text.includes('pw-test-'))).map((r) => r.pageId));
      for (const page of pageList.filter((p) => created.has(p.id))) {
        check(signal);
        if (!budgetLeft()) break;
        log(`${page.name || page.url}: deleting pw-test- records`);
        const out = await agent({ model: o.fastModel, mode: 'cleanup', system: CLEANUP_SYSTEM, prompt: cleanupPrompt(page.url), startUrl: page.url, name: `cleanup-${slug(page.name || page.url)}` }, 'cleanup');
        log(`  ${out.state?.result?.actual ?? out.error ?? 'cleanup finished'}`);
      }
    }

    // ── 7. Report ──
    setRun({ phase: 'report' });
    const summary = summarize(run, results.byRun(run.id), costUsd);
    setRun({ status: 'done', phase: 'done', summary, finishedAt: new Date().toISOString() });
    log(`Done: ${summary.passed} passed, ${summary.failed} failed, ${summary.blocked} blocked, ${summary.skipped} skipped · ` +
      `${summary.replayedTests} replayed free, ${summary.aiTests} by AI · $${costUsd.toFixed(3)}`);
    projects.touch(project.id);
  } catch (e) {
    const stopped = stopSignal.aborted;
    const message = fatal ?? (e instanceof Error ? e.message : String(e));
    if (!stopped) log(`Run failed: ${message}`);
    else log('Run stopped');
    setRun({
      status: stopped ? 'stopped' : 'error', phase: 'done', error: stopped ? null : message,
      summary: summarize(run, results.byRun(run.id), costUsd), finishedAt: new Date().toISOString(),
    });
  }

  // ── helpers that need the run's context ──

  function addResult(r: Omit<TestResult, 'id' | 'createdAt' | 'runId'>) {
    const saved = results.add({ ...r, runId: run.id }, r.testCaseId ? caseById.get(r.testCaseId) : undefined);
    events.publish(run.id, { type: 'result', result: saved });
  }

  function rel(file: string) {
    return relative(dir, file);
  }

  async function agent(a: { model: string; mode: 'plan' | 'execute' | 'cleanup'; system: string; prompt: string; startUrl: string; name: string }, label: string): Promise<AgentOutcome> {
    const agentDir = join(dir, 'agents', `${a.name}-${Date.now().toString(36)}`);
    const out = await runAgent({
      provider, model: a.model, mode: a.mode, system: a.system, prompt: a.prompt, dir: agentDir, signal,
      session: { ...base, startUrl: a.startUrl, outDir: agentDir },
      log: (line) => log(`  · ${label}: ${line}`),
    });
    spend(out.costUsd);
    if (out.fatal) {
      fatal = out.error ?? 'The AI provider cannot be used';
      internal.abort();
      throw new FatalError(fatal);
    }
    out.state ??= readState(agentDir);
    return out;
  }

  async function executeCase(page: PageConfig, test: TestCase) {
    const started = Date.now();
    const session = { ...base, startUrl: page.url, outDir: join(dir, 'replays', test.id) };
    let note = '';

    // Free path: replay the recording from an earlier run.
    if (test.recording?.length && !o.fresh) {
      const r = await replay(test.recording, session);
      if (r.ok) {
        log(`✓ ${test.ref} ${test.title} (replayed, no AI)`);
        return addResult(baseResult(page, test, {
          status: 'passed', mode: 'replay', steps: r.performed, actual: 'All recorded steps and checks passed', durationMs: Date.now() - started,
        }));
      }
      note = `Replaying the steps recorded in an earlier run failed at: ${r.error}`;
      log(`↻ ${test.ref} ${test.title}: replay failed (${r.error}); an AI agent takes over`);
    }

    if (!budgetLeft()) {
      return addResult(baseResult(page, test, {
        status: 'skipped', mode: 'ai', actual: note ? `${note}. Not re-run: the run's cost cap was reached.` : "Not run: the run's cost cap was reached.",
        durationMs: Date.now() - started,
      }));
    }

    const attempt = (model: string, previousAttempt?: string) => agent({
      model, mode: 'execute', system: EXECUTE_SYSTEM, startUrl: page.url, name: `${test.ref}-${model}`.replace(/[^\w.-]/g, '_'),
      prompt: executePrompt({ test, pageUrl: page.url, dataMode: o.dataMode, previousAttempt }),
    }, test.ref);

    let cost = 0;
    let out = await attempt(o.fastModel, note || undefined);
    cost += out.costUsd;
    let model = o.fastModel;
    let verdict = out.state?.result;
    let classification: TestResult['classification'] = null;
    const strongAvailable = o.strongModel !== o.fastModel;

    // The fast model got stuck: the strong model tries once.
    if ((!verdict || verdict.status === 'blocked') && strongAvailable && budgetLeft()) {
      log(`  ${test.ref}: ${verdict ? `blocked (${verdict.actual})` : `no verdict (${out.error ?? 'unknown'})`}; retrying with ${o.strongModel}`);
      out = await attempt(o.strongModel, verdict ? `blocked: ${verdict.actual}` : undefined);
      cost += out.costUsd;
      model = o.strongModel;
      verdict = out.state?.result ?? verdict;
    }
    // A failure is re-checked (by the strong model when there is one) before it is reported as a bug.
    if (verdict?.status === 'failed' && budgetLeft()) {
      const recheckModel = strongAvailable ? o.strongModel : o.fastModel;
      log(`  ${test.ref}: failed (${verdict.actual}); re-checking with ${recheckModel}`);
      const second = await attempt(recheckModel, `failed: ${verdict.actual}`);
      cost += second.costUsd;
      const v2 = second.state?.result;
      if (v2?.status === 'passed') {
        classification = 'flaky';
        verdict = { ...v2, notes: `The first attempt failed (${verdict.actual}); the re-check passed.` };
        out = second;
        model = recheckModel;
      } else if (v2?.status === 'failed') {
        classification = 'app-bug';
        verdict = v2.bug ? v2 : { ...v2, bug: verdict.bug };
        out = second;
        model = recheckModel;
      }
    }

    const state = out.state;
    const status = verdict?.status ?? 'blocked';
    if (status === 'passed' && state?.replayable && state.recording.length) testCases.setRecording(test.id, state.recording);
    const performed: PerformedStep[] = state?.performed ?? [];
    const icon = { passed: '✓', failed: '✗', blocked: '!' }[status];
    log(`${icon} ${test.ref} ${test.title} (${model}, $${cost.toFixed(3)})${classification === 'flaky' ? ' · flaky' : ''}`);
    addResult(baseResult(page, test, {
      status, mode: 'ai', steps: performed, model, costUsd: cost, classification, durationMs: Date.now() - started,
      actual: [verdict?.actual ?? out.error ?? 'The agent did not report a result', verdict?.notes].filter(Boolean).join(' · '),
      screenshot: state?.screenshot ? rel(state.screenshot) : null,
      bug: status === 'failed' && verdict?.bug ? {
        ...verdict.bug, stepsToReproduce: performed.filter((s) => s.ok).map((s) => s.text),
      } : null,
    }));
  }
}

/**
 * A test case to re-run: as it is now, or else as it was when the earlier run tested it (the page may have been planned
 * again since, which replaces its AI test cases). Runs from before results kept a copy fall back to that run's plan files.
 */
export function rerunCase(rerunOf: string, caseId: string): TestCase | null {
  const current = testCases.get(caseId);
  if (current || !rerunOf) return current ?? null;
  const copy = results.testCaseCopy(rerunOf, caseId);
  if (copy) return copy;
  const result = results.forCase(rerunOf, caseId);
  const earlier = runs.get(rerunOf);
  if (!result || !earlier) return null;
  const agentsDir = join(runDir(earlier.projectId, earlier.id), 'agents');
  if (!existsSync(agentsDir)) return null;
  const page = pagesDb.get(result.pageId);
  const pageDir = page ? `plan-${slug(page.name || page.url)}-` : '';
  // The plan of this result's page first, in case two pages have a test with the same title.
  const dirs = readdirSync(agentsDir).filter((d) => d.startsWith('plan-')).sort((a, b) => Number(b.startsWith(pageDir)) - Number(a.startsWith(pageDir)));
  for (const d of dirs) {
    const planned = readState(join(agentsDir, d))?.plan?.testCases.find((t) => t.title === result.title);
    if (!planned) continue;
    return {
      ...planned, id: caseId, projectId: earlier.projectId, pageId: result.pageId, source: 'ai', ref: result.ref,
      enabled: true, recording: null, recordedAt: null, createdAt: result.createdAt, updatedAt: result.createdAt,
    };
  }
  return null;
}

function baseResult(page: PageConfig, test: TestCase, r: Partial<TestResult> & Pick<TestResult, 'status' | 'mode' | 'actual' | 'durationMs'>): Omit<TestResult, 'id' | 'createdAt' | 'runId'> {
  return {
    testCaseId: test.id, pageId: page.id, ref: test.ref, title: test.title, category: test.category, expected: test.expected,
    steps: [], bug: null, classification: null, screenshot: null, costUsd: 0, model: '', ...r,
  };
}

/** Automatic checks cost nothing, so every page gets all of them. */
function autoChecksFor(_page: PageConfig): string[] {
  return CHECKLIST.filter((c) => c.kind === 'auto').map((c) => c.id);
}

/** Everything a page's AI plan depends on. When none of it changed, the cached plan is reused. */
function planKey(project: Project, page: PageConfig, o: RunOptions, fingerprint: string): string {
  return createHash('sha256').update(JSON.stringify([
    fingerprint, project.instructions, page.url, page.instructions, [...page.checklist].sort(), o.depth, o.dataMode, o.maxTestsPerPage,
  ])).digest('hex').slice(0, 16);
}

function summarize(run: Run, all: TestResult[], costUsd: number): RunSummary {
  const count = (s: TestResult['status']) => all.filter((r) => r.status === s).length;
  const key = (r: TestResult) => r.testCaseId ?? `${r.pageId}:${r.ref}`;
  const previous = run.options.rerunOf ? runs.get(run.options.rerunOf) : runs.previousFinished(run.projectId, run.createdAt);
  let comparison: RunSummary['comparison'] = null;
  if (previous) {
    const before = new Map(results.byRun(previous.id).map((r) => [key(r), r.status]));
    const label = (r: TestResult) => `${r.ref} ${r.title}`;
    comparison = {
      previousRunId: previous.id,
      newFailures: all.filter((r) => r.status === 'failed' && before.get(key(r)) !== 'failed').map(label),
      fixed: all.filter((r) => r.status === 'passed' && before.get(key(r)) === 'failed').map(label),
      stillFailing: all.filter((r) => r.status === 'failed' && before.get(key(r)) === 'failed').map(label),
    };
  }
  return {
    total: all.length, passed: count('passed'), failed: count('failed'), blocked: count('blocked'), skipped: count('skipped'),
    flaky: all.filter((r) => r.classification === 'flaky').length,
    aiTests: all.filter((r) => r.mode === 'ai' && r.status !== 'skipped').length,
    replayedTests: all.filter((r) => r.mode === 'replay').length,
    checks: all.filter((r) => r.mode === 'check').length,
    costUsd, comparison,
  };
}

function check(signal: AbortSignal) {
  if (signal.aborted) throw new Error('Stopped');
}

const slug = (s: string) => s.toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').slice(0, 40);

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, queue.length)) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}
