// MCP server (stdio) that gives an AI agent one browser and records what it does.
// Started by the agent runners (server/ai/*) with: tsx mcp-server.ts <config.json>
// It keeps <outDir>/state.json up to date with the steps performed, the recording and the agent's report.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BrowserSession, ToolError } from './session.js';
import { PlanSchema, ResultSchema, type AgentState, type McpConfig } from './schemas.js';
import { fixtureList } from './fixtures.js';

const config: McpConfig = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const session = new BrowserSession(config);
const stateFile = join(config.outDir, 'state.json');
const state: Partial<AgentState> = {};
const save = () => writeFileSync(stateFile, JSON.stringify({
  ...state, performed: session.performed, recording: session.recording, replayable: session.replayable,
  consoleErrors: session.consoleErrors.slice(-20),
} satisfies AgentState, null, 1));

let started: Promise<void> | null = null;
const ready = () => (started ??= session.start().then(() => session.navigate(config.startUrl)).then(() => undefined));

const server = new McpServer({ name: 'qa-browser', version: '1.0.0' });
type Content = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; isError?: boolean };

function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (a: z.infer<z.ZodObject<S>>) => Promise<string | Content>) {
  server.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>): Promise<Content> => {
    try {
      await ready();
      const out = await run(args);
      return typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out;
    } catch (e) {
      const message = e instanceof ToolError ? e.message : `Error: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`;
      return { content: [{ type: 'text', text: message }], isError: true };
    } finally {
      save();
    }
  }) as any);
}

const ref = z.string().describe('Element ref from the latest snapshot, e.g. e12');
const element = z.string().describe('Short human description of the element, e.g. "Sign in button"');

tool('snapshot', 'Accessibility snapshot of the page with element refs. After the first one, only changed lines are returned unless full=true.',
  { full: z.boolean().optional(), ref: z.string().optional().describe('Only this part of the page') },
  (a) => session.snapshot(a));
tool('navigate', 'Open a URL of the site under test.', { url: z.string() }, (a) => session.navigate(a.url));
tool('click', 'Click an element.', { ref, element, double: z.boolean().optional() }, (a) => session.click(a.ref, a.element, a.double));
tool('fill', 'Clear a text field and type into it. Use {{uid}} in text for a value unique to this run.',
  { ref, element, text: z.string(), submit: z.boolean().optional().describe('Press Enter afterwards') },
  (a) => session.fill(a.ref, a.element, a.text, a.submit));
tool('select_option', 'Choose option(s) in a <select>.', { ref, element, values: z.array(z.string()) }, (a) => session.select(a.ref, a.element, a.values));
tool('set_checked', 'Tick or untick a checkbox, radio button or switch.', { ref, element, checked: z.boolean() },
  (a) => session.setChecked(a.ref, a.element, a.checked));
tool('press_key', 'Press a key, e.g. Enter, Escape, Tab, ArrowDown.', { key: z.string() }, (a) => session.press(a.key));
tool('hover', 'Move the mouse over an element.', { ref, element }, (a) => session.hover(a.ref, a.element));
tool('upload_file', `Upload a test file with a file input or upload button. Files: ${fixtureList()}.`,
  { ref, element, file: z.string() }, (a) => session.upload(a.ref, a.element, a.file));
tool('wait_for', 'Wait for text to appear or disappear, or for a number of seconds (max 10).',
  { text: z.string().optional(), textGone: z.string().optional(), seconds: z.number().optional() }, (a) => session.waitFor(a));
tool('go_back', 'Browser back button.', {}, () => session.back());
tool('screenshot', 'Look at the page as an image. Costly: only when layout or visuals matter.', {}, async () => ({
  content: [{ type: 'image', data: await session.screenshotBase64(), mimeType: 'image/jpeg' }],
}));
tool('console_errors', 'JavaScript errors and failed requests seen so far.', {}, async () => session.consoleReport());

if (config.mode !== 'plan') {
  tool('verify', 'Check an expected result. Every expected result of the test must be checked with this tool.',
    {
      kind: z.enum(['text_visible', 'text_not_visible', 'element_visible', 'element_hidden', 'value', 'checked', 'unchecked', 'url_contains', 'title_contains', 'enabled', 'disabled']),
      ref: ref.optional().describe('Needed for element_*, value, checked, unchecked, enabled, disabled'),
      element: element.optional(),
      expected: z.string().optional().describe('Text for text_*, value, url_contains, title_contains'),
    },
    (a) => session.verify(a.kind, a));
  tool('report_result', 'Finish the test with your verdict. Call exactly once, at the end.', ResultSchema.shape, async (a) => {
    if (a.status === 'failed' && !a.bug) throw new ToolError('A failed test needs a bug: title, severity, expected and actual.');
    state.result = a;
    if (a.status !== 'passed') state.screenshot = await session.screenshot('failure').catch(() => undefined);
    return 'Result saved. You are done: stop now.';
  });
} else {
  tool('report_plan', 'Finish with the page features you found and the test cases to run. Call exactly once, at the end.', PlanSchema.shape, async (a) => {
    state.plan = a;
    return `Plan saved with ${a.testCases.length} test cases. You are done: stop now.`;
  });
}

save();
await server.connect(new StdioServerTransport());
const shutdown = async () => {
  save();
  await session.close();
  process.exit(0);
};
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
