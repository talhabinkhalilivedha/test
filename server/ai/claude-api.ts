// Claude through the API (ANTHROPIC_API_KEY), billed per token. Our own loop, so cost is kept down by:
// - prompt caching on the growing conversation (each turn re-reads the earlier turns at 1/10 of the price),
// - low effort for carrying out steps,
// - stopping as soon as the agent's report is saved.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { setting } from '../config.js';
import { connectBrowser, describeCall, FINISH_TOOLS, limits, wrapUpNote, type AgentOutcome, type AgentTask } from './agent.js';
import { costOf } from './pricing.js';

export async function runClaudeApiAgent(task: AgentTask, configFile: string): Promise<AgentOutcome> {
  const transcript = (entry: unknown) => appendFileSync(join(task.dir, 'transcript.jsonl'), JSON.stringify(entry) + '\n');
  const client = new Anthropic({ apiKey: setting.anthropicKey() });
  let costUsd = 0;
  let turns = 0;
  const browser = await connectBrowser(configFile, transcript).catch((e: Error) => e);
  if (browser instanceof Error) return { ok: false, error: `Could not start the browser: ${browser.message}`, state: null, costUsd, turns };

  try {
    const tools: Anthropic.Tool[] = browser.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task.prompt }];
    transcript({ type: 'start', model: task.model, prompt: task.prompt });

    while (turns < limits(task.mode).turns) {
      if (task.signal.aborted) return { ok: false, error: 'Stopped', state: null, costUsd, turns };
      turns++;
      const response = await client.messages.create({
        model: task.model,
        max_tokens: 16000,
        system: task.system,
        tools,
        messages,
        cache_control: { type: 'ephemeral' },
        output_config: { effort: task.mode === 'plan' ? 'medium' : 'low' },
      }, { signal: task.signal });
      const u = response.usage;
      costUsd += costOf(task.model, {
        input: u.input_tokens, output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0,
      });
      transcript({ type: 'response', content: response.content, usage: u, stop: response.stop_reason });

      if (response.stop_reason === 'refusal') return { ok: false, error: 'The model declined this task', state: null, costUsd, turns };
      messages.push({ role: 'assistant', content: response.content });
      const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (!calls.length) {
        if (response.stop_reason === 'max_tokens' || response.stop_reason === 'pause_turn') {
          messages.push({ role: 'user', content: 'Continue.' });
          continue;
        }
        return { ok: true, state: null, costUsd, turns };
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      let finished = false;
      for (const call of calls) {
        const input = (call.input ?? {}) as Record<string, unknown>;
        task.log(describeCall(call.name, input));
        const r = await browser.call(call.name, input);
        if (FINISH_TOOLS.includes(call.name) && !r.isError) finished = true;
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          is_error: r.isError,
          content: r.content.map((c) => (c.type === 'image' && c.data
            ? { type: 'image' as const, source: { type: 'base64' as const, media_type: (c.mimeType ?? 'image/jpeg') as 'image/jpeg', data: c.data } }
            : { type: 'text' as const, text: c.text || '(no output)' })),
        });
      }
      if (finished) {
        messages.push({ role: 'user', content: results });
        return { ok: true, state: null, costUsd, turns };
      }
      const note = wrapUpNote(task.mode, turns);
      messages.push({ role: 'user', content: note ? [...results, { type: 'text', text: note }] : results });
    }
    return { ok: false, error: `Stopped after ${limits(task.mode).turns} turns without finishing`, state: null, costUsd, turns };
  } catch (e) {
    if (task.signal.aborted) return { ok: false, error: 'Stopped', state: null, costUsd, turns };
    const fatal = e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError
      || e instanceof Anthropic.NotFoundError || (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message));
    transcript({ type: 'error', message: String(e) });
    return { ok: false, fatal, error: `Claude API error: ${e instanceof Error ? e.message : String(e)}`, state: null, costUsd, turns };
  } finally {
    await browser.close();
  }
}
