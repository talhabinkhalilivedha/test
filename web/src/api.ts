// Thin client for the server's JSON API.
import type {
  ChecklistItem, DEFAULT_MODELS, PageConfig, Project, Provider, Run, RunOptions, TestCase, TestResult,
} from '../../server/types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(path, {
    method,
    headers: body && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status);
  }
  return data as T;
}

export const get = <T>(path: string) => request<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
export const put = <T>(path: string, body: unknown) => request<T>('PUT', path, body);
export const del = <T>(path: string) => request<T>('DELETE', path);

export interface Meta {
  checklist: ChecklistItem[];
  models: typeof DEFAULT_MODELS;
  providers: Record<Provider, { available: boolean; label: string; note: string }>;
  defaults: RunOptions;
}

export type PageRow = PageConfig & { caseCount: number; aiCaseCount: number; recordedCount: number };
export type ProjectRow = Project & { pageCount: number; lastRun: Run | null };

export interface ProjectDetail { project: Project; pages: PageRow[]; runs: Run[] }

export interface Progress { phase: Run['phase']; done: number; total: number; active: string[] }

export interface RunDetail {
  run: Run;
  project: Project;
  pages: PageConfig[];
  results: TestResult[];
  log: string[];
  progress: Progress | null;
  queuePosition: number;
  cases: TestCase[];
  hasLoginScreenshot: boolean;
}

export type RunEvent =
  | { type: 'log'; line: string }
  | { type: 'run'; run: Run }
  | { type: 'result'; result: TestResult }
  | { type: 'progress'; progress: Progress };
