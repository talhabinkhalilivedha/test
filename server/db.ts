// SQLite storage (Node's built-in node:sqlite). Screenshots, logs and recordings of runs live on disk
// under data/projects/<id>/runs/<id>/; everything else is here.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import { decrypt, encrypt } from './lib/crypto.js';
import {
  defaultRunOptions, type PageConfig, type Project, type RecordedStep, type Run, type RunOptions, type RunSummary,
  type TestCase, type TestResult, type User,
} from './types.js';

export const db = new DatabaseSync(join(DATA_DIR, 'app.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, environment TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '', login TEXT, defaults TEXT NOT NULL,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    url TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '', checklist TEXT NOT NULL DEFAULT '[]',
    only_my_tests INTEGER NOT NULL DEFAULT 0, discovered INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
    plan_key TEXT, fingerprint TEXT
  );
  CREATE TABLE IF NOT EXISTS test_cases (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE, source TEXT NOT NULL, ref TEXT NOT NULL,
    title TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'medium',
    preconditions TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL DEFAULT '', expected TEXT NOT NULL DEFAULT '',
    test_data TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, recording TEXT, recorded_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL, phase TEXT NOT NULL, options TEXT NOT NULL, summary TEXT, cost_usd REAL NOT NULL DEFAULT 0,
    error TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, test_case_id TEXT,
    page_id TEXT NOT NULL, ref TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, mode TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]', expected TEXT NOT NULL DEFAULT '',
    actual TEXT NOT NULL DEFAULT '', bug TEXT, classification TEXT, screenshot TEXT, cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS results_run ON results(run_id);
  CREATE INDEX IF NOT EXISTS cases_page ON test_cases(page_id);
`);
// Added later: a copy of the test case as it ran, so it can be re-run after the page was planned again.
if (!(db.prepare('PRAGMA table_info(results)').all() as Row[]).some((c) => c.name === 'test_case')) db.exec('ALTER TABLE results ADD COLUMN test_case TEXT');

const now = () => new Date().toISOString();
export const newId = () => randomUUID().replace(/-/g, '').slice(0, 16);
const json = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};
type Row = Record<string, any>;

// ── User ─────────────────────────────────────────────────────────────────────────────────────

/** There are no accounts: projects and runs are recorded under this one built-in user. */
export const LOCAL_USER: User = { id: 'local', email: '', name: 'QA team' };
db.prepare('INSERT OR IGNORE INTO users VALUES (?, ?, ?, ?, ?)').run(LOCAL_USER.id, 'local', LOCAL_USER.name, '', now());

// ── Projects ─────────────────────────────────────────────────────────────────────────────────

function toProject(r: Row, withSecrets = false): Project {
  const login = json<Project['login']>(r.login, null);
  if (login) {
    login.hasPassword = !!login.password;
    login.password = withSecrets && login.password ? decrypt(login.password) : undefined;
  }
  return {
    id: r.id, name: r.name, baseUrl: r.base_url, environment: r.environment, instructions: r.instructions, login,
    defaults: { ...defaultRunOptions(), ...json<Partial<RunOptions>>(r.defaults, {}) },
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export type ProjectInput = Pick<Project, 'name' | 'baseUrl' | 'environment' | 'instructions' | 'defaults'> & { login: Project['login'] };

export const projects = {
  list: () => (db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Row[]).map((r) => toProject(r)),
  get: (id: string, withSecrets = false) => {
    const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? toProject(r, withSecrets) : undefined;
  },
  create(input: ProjectInput, userId: string): Project {
    const id = newId();
    db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, input.name, input.baseUrl, input.environment, input.instructions, loginJson(input.login, null),
      JSON.stringify(input.defaults), userId, now(), now());
    return projects.get(id)!;
  },
  update(id: string, input: ProjectInput): Project {
    const old = db.prepare('SELECT login FROM projects WHERE id = ?').get(id) as Row;
    db.prepare(`UPDATE projects SET name = ?, base_url = ?, environment = ?, instructions = ?, login = ?, defaults = ?,
      updated_at = ? WHERE id = ?`).run(input.name, input.baseUrl, input.environment, input.instructions,
      loginJson(input.login, json(old?.login, null)), JSON.stringify(input.defaults), now(), id);
    return projects.get(id)!;
  },
  touch: (id: string) => db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), id),
  delete: (id: string) => db.prepare('DELETE FROM projects WHERE id = ?').run(id),
};

/** Keeps the saved (encrypted) password when the form sends no new one. */
function loginJson(login: Project['login'], old: Project['login']): string | null {
  if (!login || !login.username) return null;
  const password = login.password ? encrypt(login.password) : old?.password;
  return JSON.stringify({ loginUrl: login.loginUrl, username: login.username, password, rememberMe: login.rememberMe ?? 'auto', selectors: login.selectors ?? {} });
}

// ── Pages ────────────────────────────────────────────────────────────────────────────────────

const toPage = (r: Row): PageConfig => ({
  id: r.id, projectId: r.project_id, url: r.url, name: r.name, instructions: r.instructions,
  checklist: json(r.checklist, []), onlyMyTests: !!r.only_my_tests, discovered: !!r.discovered, position: r.position,
});

export type PageInput = Pick<PageConfig, 'url' | 'name' | 'instructions' | 'checklist' | 'onlyMyTests'>;

export const pages = {
  list: (projectId: string) =>
    (db.prepare('SELECT * FROM pages WHERE project_id = ? ORDER BY discovered, position').all(projectId) as Row[]).map(toPage),
  get: (id: string) => {
    const r = db.prepare('SELECT * FROM pages WHERE id = ?').get(id) as Row | undefined;
    return r ? toPage(r) : undefined;
  },
  create(projectId: string, input: PageInput, discovered = false): PageConfig {
    const id = newId();
    const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM pages WHERE project_id = ?').get(projectId) as Row).p;
    db.prepare(`INSERT INTO pages (id, project_id, url, name, instructions, checklist, only_my_tests, discovered, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, projectId, input.url, input.name, input.instructions,
      JSON.stringify(input.checklist), input.onlyMyTests ? 1 : 0, discovered ? 1 : 0, position);
    return pages.get(id)!;
  },
  update(id: string, input: PageInput): PageConfig {
    db.prepare('UPDATE pages SET url = ?, name = ?, instructions = ?, checklist = ?, only_my_tests = ?, discovered = 0 WHERE id = ?')
      .run(input.url, input.name, input.instructions, JSON.stringify(input.checklist), input.onlyMyTests ? 1 : 0, id);
    return pages.get(id)!;
  },
  delete: (id: string) => db.prepare('DELETE FROM pages WHERE id = ?').run(id),
  /** What the cached AI test cases were planned from (see runs/plan.ts). */
  planCache: (id: string) => db.prepare('SELECT plan_key AS planKey, fingerprint FROM pages WHERE id = ?').get(id) as
    { planKey: string | null; fingerprint: string | null } | undefined,
  setPlanCache: (id: string, planKey: string, fingerprint: string) =>
    db.prepare('UPDATE pages SET plan_key = ?, fingerprint = ? WHERE id = ?').run(planKey, fingerprint, id),
};

// ── Test cases ───────────────────────────────────────────────────────────────────────────────

const toCase = (r: Row): TestCase => ({
  id: r.id, projectId: r.project_id, pageId: r.page_id, source: r.source, ref: r.ref, title: r.title,
  category: r.category, priority: r.priority, preconditions: r.preconditions, steps: r.steps, expected: r.expected,
  testData: r.test_data, enabled: !!r.enabled, recording: json<RecordedStep[] | null>(r.recording, null),
  recordedAt: r.recorded_at, createdAt: r.created_at, updatedAt: r.updated_at,
});

export type CaseInput = Pick<TestCase, 'source' | 'ref' | 'title' | 'category' | 'priority' | 'preconditions' | 'steps' | 'expected' | 'testData'>
  & { enabled?: boolean };

export const testCases = {
  byPage: (pageId: string) =>
    (db.prepare('SELECT * FROM test_cases WHERE page_id = ? ORDER BY source DESC, created_at, ref').all(pageId) as Row[]).map(toCase),
  byProject: (projectId: string) =>
    (db.prepare('SELECT * FROM test_cases WHERE project_id = ? ORDER BY page_id, created_at, ref').all(projectId) as Row[]).map(toCase),
  get: (id: string) => {
    const r = db.prepare('SELECT * FROM test_cases WHERE id = ?').get(id) as Row | undefined;
    return r ? toCase(r) : undefined;
  },
  create(projectId: string, pageId: string, c: CaseInput): TestCase {
    const id = newId();
    db.prepare(`INSERT INTO test_cases (id, project_id, page_id, source, ref, title, category, priority, preconditions,
      steps, expected, test_data, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, pageId, c.source, c.ref, c.title, c.category, c.priority, c.preconditions, c.steps, c.expected,
        c.testData, c.enabled === false ? 0 : 1, now(), now());
    return testCases.get(id)!;
  },
  /** Editing what a test does makes its recording useless, so it is dropped. */
  update(id: string, c: CaseInput): TestCase {
    const old = testCases.get(id)!;
    const changed = old.steps !== c.steps || old.expected !== c.expected || old.preconditions !== c.preconditions || old.testData !== c.testData;
    db.prepare(`UPDATE test_cases SET ref = ?, title = ?, category = ?, priority = ?, preconditions = ?, steps = ?,
      expected = ?, test_data = ?, enabled = ?, updated_at = ?${changed ? ', recording = NULL, recorded_at = NULL' : ''} WHERE id = ?`)
      .run(c.ref, c.title, c.category, c.priority, c.preconditions, c.steps, c.expected, c.testData,
        c.enabled === false ? 0 : 1, now(), id);
    return testCases.get(id)!;
  },
  setEnabled: (id: string, enabled: boolean) => db.prepare('UPDATE test_cases SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id),
  setRecording: (id: string, recording: RecordedStep[] | null) =>
    db.prepare('UPDATE test_cases SET recording = ?, recorded_at = ? WHERE id = ?')
      .run(recording ? JSON.stringify(recording) : null, recording ? now() : null, id),
  delete: (id: string) => db.prepare('DELETE FROM test_cases WHERE id = ?').run(id),
  deleteAiForPage: (pageId: string) => db.prepare("DELETE FROM test_cases WHERE page_id = ? AND source = 'ai'").run(pageId),
  deleteUploadedForPage: (pageId: string) => db.prepare("DELETE FROM test_cases WHERE page_id = ? AND source = 'upload'").run(pageId),
};

// ── Runs and results ─────────────────────────────────────────────────────────────────────────

const toRun = (r: Row): Run => ({
  id: r.id, projectId: r.project_id, status: r.status, phase: r.phase,
  options: { ...defaultRunOptions(), ...json<Partial<RunOptions>>(r.options, {}) },
  summary: json<RunSummary | null>(r.summary, null), costUsd: r.cost_usd, error: r.error, createdBy: r.created_by,
  createdByName: r.created_by_name, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
});

const RUN_SELECT = 'SELECT r.*, u.name AS created_by_name FROM runs r LEFT JOIN users u ON u.id = r.created_by';

export const runs = {
  list: (projectId: string) => (db.prepare(`${RUN_SELECT} WHERE r.project_id = ? ORDER BY r.created_at DESC LIMIT 200`)
    .all(projectId) as Row[]).map(toRun),
  get: (id: string) => {
    const r = db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(id) as Row | undefined;
    return r ? toRun(r) : undefined;
  },
  create(projectId: string, options: RunOptions, userId: string): Run {
    const id = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${newId().slice(0, 4)}`;
    db.prepare('INSERT INTO runs (id, project_id, status, phase, options, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, projectId, 'queued', 'queued', JSON.stringify(options), userId, now());
    return runs.get(id)!;
  },
  update(id: string, fields: Partial<Pick<Run, 'status' | 'phase' | 'summary' | 'costUsd' | 'error' | 'startedAt' | 'finishedAt'>>) {
    const columns: Record<string, string> = {
      status: 'status', phase: 'phase', summary: 'summary', costUsd: 'cost_usd', error: 'error', startedAt: 'started_at', finishedAt: 'finished_at',
    };
    const entries = Object.entries(fields).filter(([k]) => k in columns);
    if (!entries.length) return;
    db.prepare(`UPDATE runs SET ${entries.map(([k]) => `${columns[k]} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([k, v]) => (k === 'summary' ? JSON.stringify(v) : (v as any) ?? null)), id);
  },
  /** The last finished full run before this one (not a re-run of a few test cases), for "new failures / fixed" comparisons. */
  previousFinished: (projectId: string, beforeCreatedAt: string) => {
    const r = db.prepare(`${RUN_SELECT} WHERE r.project_id = ? AND r.status = 'done' AND r.created_at < ?
      AND COALESCE(json_array_length(r.options, '$.caseIds'), 0) = 0 ORDER BY r.created_at DESC LIMIT 1`)
      .get(projectId, beforeCreatedAt) as Row | undefined;
    return r ? toRun(r) : undefined;
  },
  /** Runs left running by a server that stopped. */
  failInterrupted: () => db.prepare(`UPDATE runs SET status = 'error', error = 'The server stopped during this run', finished_at = ?
    WHERE status IN ('running', 'queued')`).run(now()),
};

const toResult = (r: Row): TestResult => ({
  id: r.id, runId: r.run_id, testCaseId: r.test_case_id, pageId: r.page_id, ref: r.ref, title: r.title, category: r.category,
  status: r.status, mode: r.mode, steps: json(r.steps, []), expected: r.expected, actual: r.actual, bug: json(r.bug, null),
  classification: r.classification, screenshot: r.screenshot, costUsd: r.cost_usd, durationMs: r.duration_ms, model: r.model,
  createdAt: r.created_at,
});

export const results = {
  byRun: (runId: string) => (db.prepare('SELECT * FROM results WHERE run_id = ? ORDER BY created_at').all(runId) as Row[]).map(toResult),
  add(r: Omit<TestResult, 'id' | 'createdAt'>, testCase?: TestCase): TestResult {
    const id = newId();
    db.prepare(`INSERT INTO results (id, run_id, test_case_id, page_id, ref, title, category, status, mode, steps, expected, actual, bug,
      classification, screenshot, cost_usd, duration_ms, model, created_at, test_case) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, r.runId, r.testCaseId, r.pageId, r.ref, r.title, r.category, r.status, r.mode, JSON.stringify(r.steps), r.expected,
      r.actual, r.bug ? JSON.stringify(r.bug) : null, r.classification, r.screenshot, r.costUsd, r.durationMs, r.model, now(),
      testCase ? JSON.stringify({ ...testCase, recording: null }) : null);
    return { ...r, id, createdAt: now() };
  },
  /** The test case as it was when this run tested it. */
  testCaseCopy: (runId: string, testCaseId: string) => {
    const r = db.prepare('SELECT test_case FROM results WHERE run_id = ? AND test_case_id = ? AND test_case IS NOT NULL LIMIT 1').get(runId, testCaseId) as Row | undefined;
    return json<TestCase | null>(r?.test_case, null);
  },
  /** A result of this run for this test case (for runs from before copies were kept). */
  forCase: (runId: string, testCaseId: string) => {
    const r = db.prepare('SELECT * FROM results WHERE run_id = ? AND test_case_id = ? LIMIT 1').get(runId, testCaseId) as Row | undefined;
    return r ? toResult(r) : undefined;
  },
  deleteForRun: (runId: string) => db.prepare('DELETE FROM results WHERE run_id = ?').run(runId),
};
