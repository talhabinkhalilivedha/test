// Live updates of runs for the web UI (server-sent events). Log lines are also appended to the run's
// output.log, so a finished run's log can be read later.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDir } from '../config.js';
import type { Run, TestResult } from '../types.js';

export interface Progress {
  phase: Run['phase'];
  done: number;
  total: number;
  /** What is being worked on right now, e.g. test titles. */
  active: string[];
}

export type RunEvent =
  | { type: 'log'; line: string }
  | { type: 'run'; run: Run }
  | { type: 'result'; result: TestResult }
  | { type: 'progress'; progress: Progress };

type Listener = (e: RunEvent) => void;
const listeners = new Map<string, Set<Listener>>();
const progress = new Map<string, Progress>();

export const events = {
  subscribe(runId: string, fn: Listener): () => void {
    if (!listeners.has(runId)) listeners.set(runId, new Set());
    listeners.get(runId)!.add(fn);
    return () => listeners.get(runId)?.delete(fn);
  },
  publish(runId: string, e: RunEvent) {
    if (e.type === 'progress') progress.set(runId, e.progress);
    for (const fn of listeners.get(runId) ?? []) fn(e);
  },
  log(run: Pick<Run, 'id' | 'projectId'>, line: string) {
    const dir = runDir(run.projectId, run.id);
    mkdirSync(dir, { recursive: true });
    const stamped = `[${new Date().toTimeString().slice(0, 8)}] ${line}`;
    appendFileSync(join(dir, 'output.log'), stamped + '\n');
    events.publish(run.id, { type: 'log', line: stamped });
  },
  progress: (runId: string) => progress.get(runId) ?? null,
  readLog(run: Pick<Run, 'id' | 'projectId'>): string[] {
    const file = join(runDir(run.projectId, run.id), 'output.log');
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  },
};
