// OpenAI models through the Responses API (OPENAI_API_KEY). The conversation is kept on OpenAI's side
// (previous_response_id), which also caches it, and the loop stops as soon as the agent's report is saved.
// Requests go to the Flex tier (half price, slower); if Flex has no capacity the agent switches to the
// standard tier for the rest of its work.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import type { FunctionTool, ResponseInputItem } from 'openai/resources/responses/responses';
import { setting } from '../config.js';
import { connectBrowser, describeCall, FINISH_TOOLS, limits, wrapUpNote, type AgentOutcome, type AgentTask } from './agent.js';
import { costOf } from './pricing.js';

export async function runOpenAIAgent(task: AgentTask, configFile: string): Promise<AgentOutcome> {
  if (!setting.openaiKey()) return { ok: false, fatal: true, error: 'OPENAI_API_KEY is not set', state: null, costUsd: 0, turns: 0 };
  const transcript = (entry: unknown) => appendFileSync(join(task.dir, 'transcript.jsonl'), JSON.stringify(entry) + '\n');
  const openai = new OpenAI({ apiKey: setting.openaiKey() });
  let costUsd = 0;
  let turns = 0;
  let tier: 'flex' | 'default' = 'flex';
  const browser = await connectBrowser(configFile, transcript).catch((e: Error) => e);
  if (browser instanceof Error) return { ok: false, error: `Could not start the browser: ${browser.message}`, state: null, costUsd, turns };

  try {
    const tools: FunctionTool[] = browser.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description ?? '',
      parameters: { properties: {}, ...t.inputSchema, type: 'object' },
      strict: false,
    }));
    let input: ResponseInputItem[] = [{ role: 'user', content: task.prompt }];
    let previous: string | undefined;
    transcript({ type: 'start', model: task.model, prompt: task.prompt });

    while (turns < limits(task.mode).turns) {
      if (task.signal.aborted) return { ok: false, error: 'Stopped', state: null, costUsd, turns };
      turns++;
      const request = () => openai.responses.create({
        model: task.model,
        instructions: task.system,
        input,
        tools,
        parallel_tool_calls: false,
        previous_response_id: previous,
        reasoning: { effort: task.mode === 'plan' ? 'medium' : 'low' },
        truncation: 'auto',
        service_tier: tier,
      }, { signal: task.signal, timeout: 15 * 60_000 });
      const response = await request().catch((e) => {
        if (tier !== 'flex' || !flexUnavailable(e)) throw e;
        tier = 'default';
        transcript({ type: 'tier', tier, reason: String(e) });
        return request();
      });
      previous = response.id;
      const u = response.usage;
      const cached = u?.input_tokens_details?.cached_tokens ?? 0;
      costUsd += costOf(task.model, { input: (u?.input_tokens ?? 0) - cached, cacheRead: cached, cacheWrite: 0, output: u?.output_tokens ?? 0 }, response.service_tier);
      transcript({ type: 'response', output: response.output, usage: u });

      const calls = response.output.filter((item) => item.type === 'function_call');
      if (!calls.length) return { ok: true, state: null, costUsd, turns };

      input = [];
      let finished = false;
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch { /* the tool reports the missing arguments */ }
        task.log(describeCall(call.name, args));
        const r = await browser.call(call.name, args);
        if (FINISH_TOOLS.includes(call.name) && !r.isError) finished = true;
        const output = r.content.map((c) => (c.type === 'image' && c.data
          ? { type: 'input_image' as const, image_url: `data:${c.mimeType ?? 'image/jpeg'};base64,${c.data}`, detail: 'low' as const }
          : { type: 'input_text' as const, text: `${r.isError ? 'Tool error: ' : ''}${c.text || '(no output)'}` }));
        input.push({ type: 'function_call_output', call_id: call.call_id, output });
      }
      if (finished) return { ok: true, state: null, costUsd, turns };
      const note = wrapUpNote(task.mode, turns);
      if (note) input.push({ role: 'user', content: note });
    }
    return { ok: false, error: `Stopped after ${limits(task.mode).turns} turns without finishing`, state: null, costUsd, turns };
  } catch (e) {
    if (task.signal.aborted) return { ok: false, error: 'Stopped', state: null, costUsd, turns };
    const fatal = e instanceof OpenAI.APIError && ([401, 403, 404].includes(e.status ?? 0) || (e.status === 429 && e.code === 'insufficient_quota'));
    transcript({ type: 'error', message: String(e) });
    return { ok: false, fatal, error: `OpenAI error: ${e instanceof Error ? e.message : String(e)}`, state: null, costUsd, turns };
  } finally {
    await browser.close();
  }
}

/** Flex has no capacity right now (429 resource unavailable) or timed out: worth retrying on the standard tier. */
function flexUnavailable(e: unknown): boolean {
  if (e instanceof OpenAI.APIConnectionTimeoutError) return true;
  return e instanceof OpenAI.APIError && (e.status === 408 || (e.status === 429 && e.code !== 'insufficient_quota'));
}
