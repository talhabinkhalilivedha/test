// Types shared by the server and the web UI.

export type Provider = 'claude-cli' | 'claude-api' | 'openai';
export type Depth = 'smoke' | 'standard' | 'deep';
/** What the AI may do with the site's data. `full` also allows editing and deleting `pw-test-` records. */
export type DataMode = 'read-only' | 'create' | 'full';

export interface ChecklistItem {
  id: string;
  label: string;
  hint: string;
  /** `ai`: an AI agent tests it in the browser. `auto`: plain Playwright code checks it, at no AI cost. */
  kind: 'ai' | 'auto';
}

export const CHECKLIST: ChecklistItem[] = [
  { id: 'functional', label: 'Functional flows', hint: 'Buttons, forms, dialogs, create/edit flows', kind: 'ai' },
  { id: 'validation', label: 'Form validation', hint: 'Required fields, formats, min/max lengths', kind: 'ai' },
  { id: 'negative', label: 'Negative & error handling', hint: 'Invalid input, empty states, error messages', kind: 'ai' },
  { id: 'search', label: 'Search, filter, sort, paging', hint: 'Lists and tables behave correctly', kind: 'ai' },
  { id: 'navigation', label: 'Navigation & menus', hint: 'Menus, tabs, breadcrumbs, back/forward', kind: 'ai' },
  { id: 'uploads', label: 'File uploads', hint: 'Valid, wrong-type and oversized files', kind: 'ai' },
  { id: 'content', label: 'UI text & labels', hint: 'Typos, missing labels, placeholder text', kind: 'ai' },
  { id: 'console', label: 'Console errors', hint: 'JavaScript errors while the page loads', kind: 'auto' },
  { id: 'network', label: 'Failed requests', hint: 'Requests answered with 4xx/5xx', kind: 'auto' },
  { id: 'links', label: 'Broken links', hint: 'Same-site links that return errors', kind: 'auto' },
  { id: 'images', label: 'Broken images', hint: 'Images that fail to load', kind: 'auto' },
  { id: 'a11y', label: 'Accessibility', hint: 'Serious and critical axe-core violations', kind: 'auto' },
  { id: 'responsive', label: 'Mobile layout', hint: 'No horizontal scrolling at phone width', kind: 'auto' },
  { id: 'performance', label: 'Load time', hint: 'Page loads within 5 seconds', kind: 'auto' },
];

export interface RunOptions {
  depth: Depth;
  dataMode: DataMode;
  /** After the tests, delete the `pw-test-` records the run created (needs dataMode `full`). */
  cleanup: boolean;
  /** Also test same-site pages linked from the listed pages. */
  discoverPages: boolean;
  maxExtraPages: number;
  /** Stop after planning so a QA can review the test cases before they run. */
  review: boolean;
  /** 0 = no limit. */
  maxTestsPerPage: number;
  /** Stop starting new AI work once the run has cost this much (USD). 0 = no limit. */
  costCapUsd: number;
  concurrency: number;
  provider: Provider;
  /** Plans the tests, re-checks failures and takes over when the fast model gets stuck. */
  strongModel: string;
  /** Carries out the test steps. */
  fastModel: string;
  /** Ignore cached plans and recordings: explore, plan and execute everything with AI again. */
  fresh: boolean;
  headed: boolean;
  /** Only these page ids (empty = all pages). */
  pageIds: string[];
  /** Re-run only these test cases, as they are: no checks, discovery or planning (empty = a normal run). */
  caseIds: string[];
  /** The run whose results are being re-checked, when this is a re-run. */
  rerunOf: string;
}

/** An "Extract URLs" job of a project (see runs/extract.ts). */
export interface ExtractJob {
  status: 'running' | 'done' | 'failed';
  /** What it is doing now, or how it ended. */
  message: string;
  added: number;
  startedAt: string;
}

export interface LoginConfig {
  loginUrl: string;
  username: string;
  /** Never sent to the browser UI: only `hasPassword` is. */
  password?: string;
  hasPassword?: boolean;
  /** `auto`: tick a "Remember me" checkbox when the login form has one, so the login outlasts the browser tab. */
  rememberMe?: 'auto' | 'off';
  selectors: { open?: string; username?: string; password?: string; submit?: string; remember?: string };
}

export interface Project {
  id: string;
  name: string;
  baseUrl: string;
  environment: string;
  instructions: string;
  login: LoginConfig | null;
  defaults: RunOptions;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PageConfig {
  id: string;
  projectId: string;
  url: string;
  name: string;
  instructions: string;
  checklist: string[];
  /** Run only the uploaded/manual test cases: the AI adds none of its own. */
  onlyMyTests: boolean;
  /** Found by the "discover extra pages" option rather than added by a user. */
  discovered: boolean;
  position: number;
}

/** One replayable browser step, recorded while an AI agent carried out a test. */
export interface RecordedStep {
  action: 'goto' | 'click' | 'dblclick' | 'fill' | 'select' | 'check' | 'uncheck' | 'press' | 'hover' | 'upload' | 'wait' | 'back' | 'verify';
  /** Playwright selector (replay) and the matching locator code (reports). */
  selector?: string;
  code?: string;
  /** Human description of the element, e.g. "Sign in button". */
  element?: string;
  /** Text typed; may contain {{uid}}, replaced with a fresh id on each replay. */
  value?: string;
  values?: string[];
  key?: string;
  file?: string;
  url?: string;
  verify?: { kind: VerifyKind; expected?: string };
  ms?: number;
}

export type VerifyKind = 'text_visible' | 'text_not_visible' | 'element_visible' | 'element_hidden' | 'value' | 'checked' | 'unchecked' | 'url_contains' | 'title_contains' | 'enabled' | 'disabled';

export interface TestCase {
  id: string;
  projectId: string;
  pageId: string;
  source: 'upload' | 'ai' | 'manual';
  /** The QA's own test id (from an uploaded file), or one the AI assigned. */
  ref: string;
  title: string;
  category: string;
  priority: 'high' | 'medium' | 'low';
  preconditions: string;
  steps: string;
  expected: string;
  testData: string;
  enabled: boolean;
  recording: RecordedStep[] | null;
  recordedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PerformedStep {
  text: string;
  ok: boolean;
  error?: string;
}

export interface Bug {
  title: string;
  severity: 'critical' | 'major' | 'minor' | 'trivial';
  stepsToReproduce: string[];
  expected: string;
  actual: string;
}

export type ResultStatus = 'passed' | 'failed' | 'blocked' | 'skipped';

export interface TestResult {
  id: string;
  runId: string;
  testCaseId: string | null;
  pageId: string;
  ref: string;
  title: string;
  category: string;
  status: ResultStatus;
  /** `ai`: carried out by an AI agent. `replay`: recorded steps replayed by Playwright. `check`: automatic check. */
  mode: 'ai' | 'replay' | 'check';
  steps: PerformedStep[];
  expected: string;
  actual: string;
  bug: Bug | null;
  /** `app-bug`: failed twice. `flaky`: failed once, then passed. `blocked`: the agent could not carry it out. */
  classification: 'app-bug' | 'flaky' | null;
  screenshot: string | null;
  costUsd: number;
  durationMs: number;
  model: string;
  createdAt: string;
}

export type RunStatus = 'queued' | 'running' | 'review' | 'done' | 'error' | 'stopped';
export type RunPhase = 'queued' | 'login' | 'discover' | 'checks' | 'plan' | 'review' | 'execute' | 'cleanup' | 'report' | 'done';

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  flaky: number;
  aiTests: number;
  replayedTests: number;
  checks: number;
  costUsd: number;
  /** Compared with the previous finished run of the same project. */
  comparison: { previousRunId: string; newFailures: string[]; fixed: string[]; stillFailing: string[] } | null;
}

export interface Run {
  id: string;
  projectId: string;
  status: RunStatus;
  phase: RunPhase;
  options: RunOptions;
  summary: RunSummary | null;
  costUsd: number;
  error: string | null;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface User {
  id: string;
  email: string;
  name: string;
}

export const DEFAULT_MODELS: Record<Provider, { strong: string; fast: string; choices: string[] }> = {
  'claude-cli': { strong: 'sonnet', fast: 'haiku', choices: ['opus', 'sonnet', 'haiku'] },
  'claude-api': { strong: 'claude-sonnet-5-5', fast: 'claude-haiku-5-5', choices: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  openai: { strong: 'gpt-5', fast: 'gpt-5-mini', choices: ['gpt-5', 'gpt-5-mini'] },
};

export function defaultRunOptions(provider: Provider = 'claude-cli'): RunOptions {
  return {
    depth: 'standard',
    dataMode: 'read-only',
    cleanup: false,
    discoverPages: false,
    maxExtraPages: 5,
    review: false,
    maxTestsPerPage: 15,
    costCapUsd: 10,
    concurrency: 3,
    provider,
    strongModel: DEFAULT_MODELS[provider].strong,
    fastModel: DEFAULT_MODELS[provider].fast,
    fresh: false,
    headed: false,
    pageIds: [],
    caseIds: [],
    rerunOf: '',
  };
}
