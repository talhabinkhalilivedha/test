// Web server: JSON API under /api, live run updates over SSE, and the built web UI (dist/).
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { ROOT, runDir, setting } from './config.js';
import { LOCAL_USER, pages, projects, results, runs, testCases } from './db.js';
import { runReportHtml } from './lib/report.js';
import { exportResults, parseCases, sampleFile } from './lib/sheets.js';
import { events } from './runs/events.js';
import { extractJob, startExtract } from './runs/extract.js';
import { rerunCase } from './runs/pipeline.js';
import { queue } from './runs/queue.js';
import { CHECKLIST, DEFAULT_MODELS, defaultRunOptions, type Provider } from './types.js';

const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ') });
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) console.error(err);
  reply.code(status).send({ error: (err as Error).message });
});

const fail = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });
type IdParams = { Params: { id: string } };

// ── Meta ─────────────────────────────────────────────────────────────────────────────────────

const claudeCliInstalled = (() => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

app.get('/api/meta', async () => ({
  checklist: CHECKLIST,
  models: DEFAULT_MODELS,
  providers: {
    'claude-cli': { available: claudeCliInstalled, label: 'Claude (subscription)', note: claudeCliInstalled ? 'Uses the claude CLI logged in on the server' : 'claude CLI not installed on the server' },
    'claude-api': { available: !!setting.anthropicKey(), label: 'Claude API', note: setting.anthropicKey() ? 'ANTHROPIC_API_KEY is set' : 'Set ANTHROPIC_API_KEY in .env' },
    openai: { available: !!setting.openaiKey(), label: 'OpenAI', note: setting.openaiKey() ? 'OPENAI_API_KEY is set' : 'Set OPENAI_API_KEY in .env' },
  } satisfies Record<Provider, unknown>,
  defaults: defaultRunOptions(setting.anthropicKey() ? 'claude-api' : 'claude-cli'),
}));

// ── Projects ─────────────────────────────────────────────────────────────────────────────────

const httpUrl = z.string().trim().url().refine((u) => /^https?:\/\//.test(u), 'must start with http:// or https://');

const RunOptionsSchema = z.object({
  depth: z.enum(['smoke', 'standard', 'deep']),
  dataMode: z.enum(['read-only', 'create', 'full']),
  cleanup: z.boolean(),
  discoverPages: z.boolean(),
  maxExtraPages: z.number().int().min(0).max(50),
  review: z.boolean(),
  maxTestsPerPage: z.number().int().min(0).max(200),
  costCapUsd: z.number().min(0).max(1000),
  concurrency: z.number().int().min(1).max(8),
  provider: z.enum(['claude-cli', 'claude-api', 'openai']),
  strongModel: z.string().regex(/^[\w.:/-]{1,80}$/, 'invalid model name'),
  fastModel: z.string().regex(/^[\w.:/-]{1,80}$/, 'invalid model name'),
  fresh: z.boolean(),
  headed: z.boolean(),
  pageIds: z.array(z.string()),
  caseIds: z.array(z.string()).max(500),
  rerunOf: z.string(),
});

const ProjectSchema = z.object({
  name: z.string().trim().min(1),
  baseUrl: httpUrl,
  environment: z.string().trim().default(''),
  instructions: z.string().default(''),
  login: z.object({
    loginUrl: z.union([httpUrl, z.literal('')]).default(''),
    username: z.string().default(''),
    password: z.string().optional(),
    rememberMe: z.enum(['auto', 'off']).default('auto'),
    selectors: z.object({ open: z.string().optional(), username: z.string().optional(), password: z.string().optional(), submit: z.string().optional(), remember: z.string().optional() }).default({}),
  }).nullable().default(null),
  defaults: RunOptionsSchema.partial().default({}),
});

function projectSummary(id: string) {
  const list = runs.list(id);
  return { pageCount: pages.list(id).filter((p) => !p.discovered).length, lastRun: list[0] ?? null };
}

app.get('/api/projects', async () => projects.list().map((p) => ({ ...p, ...projectSummary(p.id) })));

app.post('/api/projects', async (req) => {
  const body = ProjectSchema.parse(req.body);
  const project = projects.create({ ...body, defaults: { ...defaultRunOptions(), ...body.defaults } }, LOCAL_USER.id);
  return project;
});

app.get<IdParams>('/api/projects/:id', async (req, reply) => {
  const project = projects.get(req.params.id);
  if (!project) return fail(reply, 404, 'Project not found');
  const list = pages.list(project.id).map((p) => {
    const cases = testCases.byPage(p.id);
    return { ...p, caseCount: cases.length, aiCaseCount: cases.filter((c) => c.source === 'ai').length, recordedCount: cases.filter((c) => c.recording).length };
  });
  return { project, pages: list, runs: runs.list(project.id).slice(0, 50) };
});

app.put<IdParams>('/api/projects/:id', async (req, reply) => {
  const old = projects.get(req.params.id);
  if (!old) return fail(reply, 404, 'Project not found');
  const body = ProjectSchema.parse(req.body);
  return projects.update(old.id, { ...body, defaults: { ...old.defaults, ...body.defaults } });
});

app.delete<IdParams>('/api/projects/:id', async (req) => {
  for (const r of runs.list(req.params.id)) queue.stop(r.id);
  projects.delete(req.params.id);
  return { ok: true };
});

// ── Pages and test cases ─────────────────────────────────────────────────────────────────────

const PageSchema = z.object({
  url: httpUrl,
  name: z.string().trim().default(''),
  instructions: z.string().default(''),
  checklist: z.array(z.enum(CHECKLIST.map((c) => c.id) as [string, ...string[]])).default([]),
  onlyMyTests: z.boolean().default(false),
});

app.post<IdParams>('/api/projects/:id/pages', async (req, reply) => {
  if (!projects.get(req.params.id)) return fail(reply, 404, 'Project not found');
  const page = pages.create(req.params.id, PageSchema.parse(req.body));
  projects.touch(req.params.id);
  return page;
});

/** Extract URLs: finds the site's pages by following its links (no AI) and adds them as found pages. */
app.post<IdParams>('/api/projects/:id/extract', async (req, reply) => {
  if (!projects.get(req.params.id)) return fail(reply, 404, 'Project not found');
  return startExtract(req.params.id);
});

app.get<IdParams>('/api/projects/:id/extract', async (req) => ({ job: extractJob(req.params.id) }));

app.put<IdParams>('/api/pages/:id', async (req, reply) => {
  if (!pages.get(req.params.id)) return fail(reply, 404, 'Page not found');
  return pages.update(req.params.id, PageSchema.parse(req.body));
});

app.delete<IdParams>('/api/pages/:id', async (req) => {
  pages.delete(req.params.id);
  return { ok: true };
});

app.get<IdParams>('/api/pages/:id/cases', async (req) => testCases.byPage(req.params.id));

/** Forget the AI's plan for this page: the next run explores and plans it again. */
app.post<IdParams>('/api/pages/:id/replan', async (req) => {
  testCases.deleteAiForPage(req.params.id);
  pages.setPlanCache(req.params.id, '', '');
  return { ok: true };
});

const CaseSchema = z.object({
  ref: z.string().trim().default(''),
  title: z.string().trim().min(1),
  category: z.string().trim().default('functional'),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  preconditions: z.string().default(''),
  steps: z.string().default(''),
  expected: z.string().default(''),
  testData: z.string().default(''),
  enabled: z.boolean().default(true),
});

app.post<IdParams>('/api/pages/:id/cases', async (req, reply) => {
  const page = pages.get(req.params.id);
  if (!page) return fail(reply, 404, 'Page not found');
  const body = CaseSchema.parse(req.body);
  const n = testCases.byPage(page.id).filter((c) => c.source === 'manual').length + 1;
  return testCases.create(page.projectId, page.id, { ...body, source: 'manual', ref: body.ref || `M-${String(n).padStart(3, '0')}` });
});

app.post<IdParams>('/api/pages/:id/upload', async (req, reply) => {
  const page = pages.get(req.params.id);
  if (!page) return fail(reply, 404, 'Page not found');
  const file = await req.file();
  if (!file) return fail(reply, 400, 'No file uploaded');
  if (!/\.(csv|xlsx)$/i.test(file.filename)) return fail(reply, 400, 'Upload a .csv or .xlsx file');
  const parsed = await parseCases(file.filename, await file.toBuffer());
  if (!parsed.cases.length) return fail(reply, 400, parsed.warnings.join(' ') || 'No test cases found in the file');
  const replace = (req.query as { replace?: string }).replace !== 'false';
  if (replace) testCases.deleteUploadedForPage(page.id);
  for (const c of parsed.cases) testCases.create(page.projectId, page.id, c);
  return { imported: parsed.cases.length, replaced: replace, warnings: parsed.warnings };
});

app.put<IdParams>('/api/cases/:id', async (req, reply) => {
  const old = testCases.get(req.params.id);
  if (!old) return fail(reply, 404, 'Test case not found');
  const body = CaseSchema.parse(req.body);
  return testCases.update(old.id, { ...body, source: old.source, ref: body.ref || old.ref });
});

app.post<IdParams>('/api/cases/:id/enabled', async (req) => {
  testCases.setEnabled(req.params.id, z.object({ enabled: z.boolean() }).parse(req.body).enabled);
  return { ok: true };
});

app.delete<IdParams>('/api/cases/:id', async (req) => {
  testCases.delete(req.params.id);
  return { ok: true };
});

app.get<{ Params: { format: string } }>('/api/sample/:format', async (req, reply) => {
  const format = req.params.format === 'csv' ? 'csv' : 'xlsx';
  reply.header('content-disposition', `attachment; filename="test-cases-sample.${format}"`);
  reply.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return sampleFile(format);
});

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────

app.post<IdParams>('/api/projects/:id/runs', async (req, reply) => {
  const project = projects.get(req.params.id);
  if (!project) return fail(reply, 404, 'Project not found');
  const options = { ...project.defaults, ...RunOptionsSchema.partial().parse((req.body as { options?: unknown })?.options ?? {}) };
  if (options.provider === 'openai' && !setting.openaiKey()) return fail(reply, 400, 'OpenAI needs OPENAI_API_KEY in .env');
  if (options.cleanup && options.dataMode === 'read-only') options.cleanup = false;
  if (options.caseIds.length) {
    // A re-run of chosen test cases: only those that still exist, on their own pages.
    const cases = options.caseIds.map((id) => rerunCase(options.rerunOf, id)).filter((c) => c?.projectId === project.id && pages.get(c.pageId));
    if (!cases.length) return fail(reply, 400, 'These test cases could not be found any more');
    Object.assign(options, { caseIds: cases.map((c) => c!.id), pageIds: [...new Set(cases.map((c) => c!.pageId))], review: false, discoverPages: false, cleanup: false });
  }
  const run = runs.create(project.id, options, LOCAL_USER.id);
  // The options chosen become the project's defaults for next time (except the one-off choices; a re-run changes nothing).
  if (!options.caseIds.length) {
    projects.update(project.id, { ...project, login: project.login && { ...project.login, password: undefined }, defaults: { ...options, pageIds: [], fresh: false, caseIds: [], rerunOf: '' } });
  }
  queue.enqueue(run.id);
  return run;
});

app.get<IdParams>('/api/projects/:id/runs', async (req) => runs.list(req.params.id));

app.get<IdParams>('/api/runs/:id', async (req, reply) => {
  const run = runs.get(req.params.id);
  if (!run) return fail(reply, 404, 'Run not found');
  const pageList = pages.list(run.projectId);
  return {
    run,
    project: projects.get(run.projectId),
    pages: pageList,
    results: results.byRun(run.id),
    log: events.readLog(run).slice(-2000),
    progress: queue.isActive(run.id) ? events.progress(run.id) : null,
    queuePosition: queue.position(run.id),
    // For the review step: the test cases that will run.
    cases: run.status === 'review'
      ? pageList.filter((p) => (run.options.pageIds.length ? run.options.pageIds.includes(p.id) : !p.discovered || run.options.discoverPages)).flatMap((p) => testCases.byPage(p.id))
      : [],
    hasLoginScreenshot: existsSync(join(runDir(run.projectId, run.id), 'login-failed.png')),
  };
});

app.get<IdParams>('/api/runs/:id/events', async (req: FastifyRequest<IdParams>, reply) => {
  const run = runs.get(req.params.id);
  if (!run) return fail(reply, 404, 'Run not found');
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
  send({ type: 'run', run });
  const unsubscribe = events.subscribe(run.id, send);
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
  req.raw.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

app.post<IdParams>('/api/runs/:id/stop', async (req, reply) => (queue.stop(req.params.id) ? { ok: true } : fail(reply, 409, 'The run is not running')));
app.post<IdParams>('/api/runs/:id/approve', async (req, reply) => (queue.approve(req.params.id) ? { ok: true } : fail(reply, 409, 'The run is not waiting for a review')));

app.get<{ Params: { id: string; format: string } }>('/api/runs/:id/export/:format', async (req, reply) => {
  const run = runs.get(req.params.id);
  if (!run) return fail(reply, 404, 'Run not found');
  if (req.params.format === 'html') {
    const project = projects.get(run.projectId)!;
    const html = runReportHtml({
      run, project, pages: pages.list(run.projectId), results: results.byRun(run.id), log: events.readLog(run), dir: runDir(run.projectId, run.id),
    });
    reply.header('content-disposition', `attachment; filename="${project.name.replace(/[^\w-]+/g, '-')}-${run.id}.html"`);
    return reply.type('text/html; charset=utf-8').send(html);
  }
  const format = req.params.format === 'csv' ? 'csv' : 'xlsx';
  const project = projects.get(run.projectId)!;
  const name = `${project.name.replace(/[^\w-]+/g, '-')}-${run.id}.${format}`;
  reply.header('content-disposition', `attachment; filename="${name}"`);
  reply.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return exportResults(format, results.byRun(run.id), pages.list(run.projectId));
});

/** Screenshots and other files of a run. */
app.get<{ Params: { id: string; '*': string } }>('/api/runs/:id/files/*', async (req, reply) => {
  const run = runs.get(req.params.id);
  if (!run) return fail(reply, 404, 'Run not found');
  const base = runDir(run.projectId, run.id);
  const file = resolve(base, req.params['*']);
  if (!file.startsWith(base + '/') || !/\.(png|jpe?g)$/i.test(file) || !existsSync(file)) return fail(reply, 404, 'File not found');
  reply.type(file.endsWith('.png') ? 'image/png' : 'image/jpeg');
  return readFileSync(file);
});

// ── Web UI ───────────────────────────────────────────────────────────────────────────────────

const dist = join(ROOT, 'dist');
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? fail(reply, 404, 'Not found') : reply.sendFile('index.html')));
}

runs.failInterrupted();
const port = setting.port();
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
console.log(`AI QA Engineer: http://localhost:${port}${existsSync(dist) ? '' : ' (API only: run `npm run dev` for the UI, or `npm run build`)'}`);
