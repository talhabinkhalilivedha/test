// Starts runs, a few at a time (MAX_PARALLEL_RUNS), and lets users stop them or approve a review.
// Each run has its own folder, browser sessions and login state, so runs never share files.
import { setting } from '../config.js';
import { runs } from '../db.js';
import { events } from './events.js';
import { executeRun } from './pipeline.js';

const waiting: string[] = [];
const active = new Map<string, { stop: AbortController; approve?: () => void }>();

export const queue = {
  enqueue(runId: string) {
    waiting.push(runId);
    next();
  },
  stop(runId: string): boolean {
    const i = waiting.indexOf(runId);
    if (i >= 0) {
      waiting.splice(i, 1);
      const run = runs.get(runId)!;
      runs.update(runId, { status: 'stopped', phase: 'done', finishedAt: new Date().toISOString() });
      events.log(run, 'Run stopped before it started');
      events.publish(runId, { type: 'run', run: runs.get(runId)! });
      return true;
    }
    const a = active.get(runId);
    if (!a) return false;
    a.stop.abort();
    a.approve?.();
    return true;
  },
  approve(runId: string): boolean {
    const a = active.get(runId);
    if (!a?.approve) return false;
    a.approve();
    a.approve = undefined;
    return true;
  },
  isActive: (runId: string) => active.has(runId) || waiting.includes(runId),
  position: (runId: string) => waiting.indexOf(runId),
};

function next() {
  while (active.size < setting.maxParallelRuns() && waiting.length) {
    const runId = waiting.shift()!;
    const entry: { stop: AbortController; approve?: () => void } = { stop: new AbortController() };
    active.set(runId, entry);
    const waitForReview = () => new Promise<void>((resolve) => { entry.approve = resolve; });
    executeRun(runId, entry.stop.signal, waitForReview)
      .catch((e) => console.error(`Run ${runId} crashed:`, e))
      .finally(() => {
        active.delete(runId);
        next();
      });
  }
}
