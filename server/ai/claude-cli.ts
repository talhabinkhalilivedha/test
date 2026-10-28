// Claude through the logged-in `claude` CLI: uses the Claude subscription, no API key.
// Claude Code's own system prompt and built-in tools are replaced, so each call only carries our prompt
// and the browser tools.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeCall, mcpCommand, type AgentOutcome, type AgentTask } from './agent.js';

export function runClaudeCliAgent(task: AgentTask, configFile: string): Promise<AgentOutcome> {
  const transcriptFile = join(task.dir, 'transcript.jsonl');
  const args = [
    '-p', task.prompt,
    '--model', task.model,
    '--system-prompt', task.system,
    '--tools', '',
    '--mcp-config', JSON.stringify({ mcpServers: { qa: mcpCommand(configFile) } }),
    '--strict-mcp-config',
    '--allowedTools', 'mcp__qa',
    '--permission-mode', 'dontAsk',
    '--disable-slash-commands',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Use the subscription login, not a pay-per-use key that may be set in the shell.
  delete env.ANTHROPIC_API_KEY;

  return new Promise((resolve) => {
    const child = spawn('claude', args, { env, cwd: task.dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch { /* already gone */ }
    };
    task.signal.addEventListener('abort', kill, { once: true });
    let outcome: AgentOutcome = { ok: false, error: 'The claude CLI exited without a result', state: null, costUsd: 0, turns: 0 };
    let stderr = '';
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        appendFileSync(transcriptFile, line + '\n');
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === 'assistant') {
          for (const c of msg.message?.content ?? []) {
            if (c.type === 'tool_use') task.log(describeCall(String(c.name).replace('mcp__qa__', ''), c.input));
          }
        } else if (msg.type === 'result') {
          outcome = {
            ok: !msg.is_error,
            error: msg.is_error ? String(msg.result ?? msg.subtype ?? 'error') : undefined,
            state: null,
            costUsd: Number(msg.total_cost_usd ?? 0),
            turns: Number(msg.num_turns ?? 0),
          };
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      appendFileSync(transcriptFile, JSON.stringify({ type: 'stderr', text: chunk.toString() }) + '\n');
    });
    child.on('error', (e) => resolve({ ok: false, fatal: true, error: `Could not start the claude CLI: ${e.message}. Install Claude Code and log in, or set an API key.`, state: null, costUsd: 0, turns: 0 }));
    child.on('close', () => {
      task.signal.removeEventListener('abort', kill);
      if (!outcome.ok && /not logged in|login|authenticat|invalid api key/i.test(stderr + (outcome.error ?? ''))) {
        outcome.fatal = true;
        outcome.error = `The claude CLI is not logged in. Run \`claude\` and /login on the server, or set ANTHROPIC_API_KEY. (${(outcome.error ?? stderr).slice(0, 200)})`;
      }
      resolve(outcome);
    });
  });
}
