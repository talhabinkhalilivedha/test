// App-wide settings. Values come from the environment or .env, read when used so a key added
// to .env later works without a restart.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The project folder, wherever the process was started from: the MCP browser server runs with an
// agent's folder as its working directory.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = resolve(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

function env(name: string): string | undefined {
  const file = join(ROOT, '.env');
  if (existsSync(file)) {
    const line = readFileSync(file, 'utf8').split('\n').find((l) => l.trim().startsWith(`${name}=`));
    const value = line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (value) return value;
  }
  return process.env[name] || undefined;
}

export const setting = {
  port: () => Number(env('PORT') ?? 4400),
  maxParallelRuns: () => Math.max(1, Number(env('MAX_PARALLEL_RUNS') ?? 2)),
  anthropicKey: () => env('ANTHROPIC_API_KEY'),
  openaiKey: () => env('OPENAI_API_KEY'),
  /** How long a page may take to load, in ms. Dev servers behind a tunnel can take minutes on first load. */
  pageLoadMs: () => Math.max(30, Number(env('PAGE_LOAD_TIMEOUT') ?? 300)) * 1000,
};

/** Secret used to encrypt saved site passwords. Created on first start and kept in data/. */
export const APP_SECRET: Buffer = (() => {
  const file = join(DATA_DIR, 'secret.key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
})();

export const projectDir = (projectId: string) => join(DATA_DIR, 'projects', projectId);
export const runDir = (projectId: string, runId: string) => join(projectDir(projectId), 'runs', runId);
