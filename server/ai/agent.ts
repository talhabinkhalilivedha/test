// Runs one AI agent against one browser. Whatever the provider, the agent's tools come from our own MCP
// server (server/browser/mcp-server.ts), which records the steps and the agent's report in state.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, setting } from '../config.js';
import type { AgentMode, AgentState, McpConfig } from '../browser/schemas.js';
import type { SessionConfig } from '../browser/session.js';
import type { Provider } from '../types.js';
import { runClaudeApiAgent } from './claude-api.js';
import { runClaudeCliAgent } from './claude-cli.js';
import { runOpenAIAgent } from './openai.js';

export interface AgentTask {
  provider: Provider;
  model: string;
  mode: AgentMode;
  system: string;
  prompt: string;
  session: SessionConfig;
  /** state.json, config.json and transcript.jsonl go here. */
  dir: string;
  signal: AbortSignal;
  log: (line: string) => void;
}

export interface AgentOutcome {
  ok: boolean;
  error?: string;
  /** The provider cannot work at all (no login, bad key, no credit): the run should stop. */
  fatal?: boolean;
  state: AgentState | null;
  costUsd: number;
  turns: number;
}

const LIMITS: Record<AgentMode, { turns: number; minutes: number }> = {
  plan: { turns: 60, minutes: 15 },
  execute: { turns: 40, minutes: 10 },
  cleanup: { turns: 40, minutes: 10 },
};
export const limits = (mode: AgentMode) => LIMITS[mode];

/** Turns before the limit at which the agent is told to finish, so long work still ends in a report. */
const WRAP_UP_TURNS = 8;
export function wrapUpNote(mode: AgentMode, turn: number): string | null {
  if (LIMITS[mode].turns - turn !== WRAP_UP_TURNS) return null;
  return mode === 'plan'
    ? `Only ${WRAP_UP_TURNS} turns are left. Stop exploring and call report_plan now with the features and test cases you have.`
    : `Only ${WRAP_UP_TURNS} turns are left. Finish now and call report_result with what you have found (blocked if you could not complete the steps).`;
}

/** The tools that end an agent's work: once one of them succeeds there is nothing left to do. */
export const FINISH_TOOLS = ['report_result', 'report_plan'];

export function mcpCommand(configFile: string): { command: string; args: string[] } {
  return { command: resolve(ROOT, 'node_modules/.bin/tsx'), args: [resolve(ROOT, 'server/browser/mcp-server.ts'), configFile] };
}

export function readState(dir: string): AgentState | null {
  const file = join(dir, 'state.json');
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

/** Which provider to use: the requested one, unless it needs an API key that is not set. */
export function resolveProvider(requested: Provider): Provider {
  if (requested === 'claude-api' && !setting.anthropicKey()) return 'claude-cli';
  return requested;
}

export async function runAgent(task: AgentTask): Promise<AgentOutcome> {
  mkdirSync(task.dir, { recursive: true });
  const configFile = join(task.dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...task.session, outDir: task.dir, mode: task.mode } satisfies McpConfig, null, 1));
  const timeout = AbortSignal.timeout(LIMITS[task.mode].minutes * 60_000);
  const signal = AbortSignal.any([task.signal, timeout]);
  const run = task.provider === 'openai' ? runOpenAIAgent : task.provider === 'claude-api' ? runClaudeApiAgent : runClaudeCliAgent;
  const outcome = await run({ ...task, signal }, configFile);
  if (timeout.aborted && !task.signal.aborted) {
    outcome.ok = false;
    outcome.error = `Stopped after ${LIMITS[task.mode].minutes} minutes`;
  }
  outcome.state = readState(task.dir);
  return outcome;
}

export interface ToolCallResult {
  isError: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

/** MCP client connected to a fresh browser server, for the API providers that run the loop themselves. */
export async function connectBrowser(configFile: string, transcript: (entry: unknown) => void) {
  const client = new Client({ name: 'ai-qa', version: '1.0.0' });
  const transport = new StdioClientTransport({ ...mcpCommand(configFile), cwd: ROOT, stderr: 'pipe' });
  transport.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    if (!text.includes('ExperimentalWarning')) transcript({ type: 'mcp-stderr', text });
  });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  return {
    tools,
    async call(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
      try {
        const r = await client.callTool({ name, arguments: args }, undefined, { timeout: setting.pageLoadMs() + 2 * 60_000 });
        return { isError: !!r.isError, content: (r.content ?? []) as ToolCallResult['content'] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] };
      }
    },
    close: () => client.close().catch(() => {}),
  };
}

/** The interesting argument of a tool call, for the live progress log. */
export function describeCall(name: string, input: Record<string, unknown> = {}): string {
  const v = input.element ?? input.url ?? input.expected ?? input.text ?? input.key ?? input.status ?? '';
  return `${name}${v ? ` ${String(v).slice(0, 80)}` : ''}`;
}
