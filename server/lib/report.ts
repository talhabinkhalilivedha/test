// A run's results as one self-contained HTML file: the app's own styles, screenshots embedded as data URIs and
// a few lines of script for the Problems / Everything switch, so anyone can open it in a browser without the app.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../config.js';
import type { PageConfig, Project, Run, TestResult } from '../types.js';

const STYLES = resolve(ROOT, 'web/src/styles.css');

// Extra rules for markup that is a React component in the app: rows open with <details> instead of state.
const EXTRA_CSS = `
.result { border-bottom: 1px solid var(--border); }
.result:last-child { border-bottom: 0; }
.result > summary { list-style: none; display: grid; grid-template-columns: 96px minmax(0, 1fr) 150px 30px; gap: 14px; padding: 10px 14px; cursor: pointer; }
.result > summary::-webkit-details-marker { display: none; }
.result > summary:hover { background: var(--surface-2); }
.result[open] > summary .chev { transform: rotate(90deg); }
.chev { display: flex; }
.only-problems .result.passed, .only-problems .group.clean { display: none; }
.problems-empty { display: none; }
.only-problems .problems-empty.show { display: block; }
.shot.zoom { position: fixed; inset: 0; margin: auto; max-width: 96vw; max-height: 96vh; z-index: 10; cursor: zoom-out; box-shadow: 0 0 0 100vmax rgb(0 0 0 / 0.75); }
.result-detail ol.steps li.bad { color: var(--fail); }
@media (max-width: 720px) {
  .result-detail { grid-template-columns: 1fr; }
  .result > summary { grid-template-columns: 80px minmax(0, 1fr) 24px; }
  .result > summary .how { display: none; }
}`;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// Same wording and formatting as the app (web/src/ui.tsx).
const money = (usd: number) => (usd === 0 ? '$0' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
const seconds = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const RESULT: Record<TestResult['status'], [string, string]> = {
  passed: ['pass', 'Passed'], failed: ['fail', 'Failed'], blocked: ['warn', 'Blocked'], skipped: ['skip', 'Skipped'],
};
const RUN: Record<Run['status'], [string, string]> = {
  queued: ['skip', 'Queued'], running: ['accent', 'Running'], review: ['warn', 'Needs review'], done: ['pass', 'Finished'],
  error: ['fail', 'Error'], stopped: ['skip', 'Stopped'],
};
const HOW = { ai: 'Tested by AI', replay: 'Repeated for free', check: 'Automatic check' };
const order = (r: TestResult) => ({ failed: 0, blocked: 1, skipped: 2, passed: 3 }[r.status] * 10 + (r.mode === 'check' ? 1 : 0));
const svg = (d: string) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = { page: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>'), chevron: svg('<path d="M9 6l6 6-6 6"/>') };

/** A screenshot inside the run folder as a data URI, or null when it is missing or outside the folder. */
function embed(dir: string, file: string): string | null {
  const path = resolve(dir, file);
  if (!path.startsWith(dir + '/') || !/\.(png|jpe?g)$/i.test(path) || !existsSync(path)) return null;
  return `data:${path.endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${readFileSync(path).toString('base64')}`;
}

function resultHtml(r: TestResult, dir: string): string {
  const shot = r.screenshot ? embed(dir, r.screenshot) : null;
  // As in the app: a passed test hides the steps the agent had to retry.
  const steps = r.status !== 'passed' ? r.steps : r.steps.filter((s) => s.ok);
  const bug = r.bug && r.status === 'failed' ? `
        <div class="bug stack tight">
          <div class="row between"><b>Bug: ${esc(r.bug.title)}</b><span class="badge ${r.bug.severity === 'critical' || r.bug.severity === 'major' ? 'fail' : 'warn'}">${esc(r.bug.severity)}</span></div>
          ${r.bug.stepsToReproduce.length ? `<div class="small"><div class="section-title">How to reproduce</div><ol class="steps">${r.bug.stepsToReproduce.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>` : ''}
        </div>` : '';
  return `
  <details class="result ${r.status}">
    <summary>
      <span><span class="badge ${RESULT[r.status][0]}">${RESULT[r.status][1]}</span></span>
      <span>
        <span style="font-weight:550">${esc(r.title)}</span>
        ${r.classification === 'flaky' ? '<span class="badge warn" style="margin-left:6px" title="Failed once, then passed when checked again">unstable</span>' : ''}
        ${r.status !== 'passed' ? `<div class="small muted">${esc(r.bug?.title ?? r.actual)}</div>` : ''}
      </span>
      <span class="small faint nowrap how">${HOW[r.mode]}</span>
      <span class="faint chev">${ICON.chevron}</span>
    </summary>
    <div class="result-detail">
      <div class="stack">
        <span class="section-title">What was done</span>
        ${steps.length
          ? `<ol class="steps">${steps.map((s) => `<li class="${s.ok ? '' : 'bad'}">${esc(s.text)}${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}</li>`).join('')}</ol>`
          : '<span class="small faint">No steps recorded.</span>'}
        <span class="small faint">${esc(r.ref)} · ${seconds(r.durationMs)}${r.mode === 'ai' ? ` · ${money(r.costUsd)} · ${esc(r.model)}` : ''}</span>
      </div>
      <div class="stack">
        <div><div class="section-title">Expected</div><div style="white-space:pre-wrap">${esc(r.expected || '—')}</div></div>
        <div><div class="section-title">What happened</div><div style="white-space:pre-wrap">${esc(r.actual || '—')}</div></div>
        ${bug}
        ${shot ? `<img class="shot" src="${shot}" alt="Screenshot of ${esc(r.title)}" loading="lazy">` : ''}
      </div>
    </div>
  </details>`;
}

export function runReportHtml(o: { run: Run & { createdByName?: string }; project: Project; pages: PageConfig[]; results: TestResult[]; log: string[]; dir: string }): string {
  const { run, project, pages, results } = o;
  const count = (...st: TestResult['status'][]) => results.filter((r) => st.includes(r.status)).length;
  const ai = results.filter((r) => r.mode === 'ai' && r.status !== 'skipped').length;
  const replayed = results.filter((r) => r.mode === 'replay').length;
  const checks = results.filter((r) => r.mode === 'check').length;
  const problems = results.filter((r) => r.status !== 'passed').length;
  const started = new Date(run.startedAt ?? run.createdAt);
  const took = run.startedAt && run.finishedAt ? seconds(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) : '';
  const c = run.summary?.comparison;

  const pageOrder = pages.map((p) => p.id);
  const groups = new Map<string, TestResult[]>();
  for (const r of results) groups.set(r.pageId, [...(groups.get(r.pageId) ?? []), r]);
  const groupHtml = [...groups.entries()].sort((a, b) => pageOrder.indexOf(a[0]) - pageOrder.indexOf(b[0])).map(([pageId, list]) => {
    const page = pages.find((p) => p.id === pageId);
    const clean = list.every((r) => r.status === 'passed');
    return `
  <div class="group${clean ? ' clean' : ''}">
    <div class="row" style="padding:9px 20px;background:var(--surface-2);border-bottom:1px solid var(--border)">
      <span class="faint">${ICON.page}</span><b>${esc(page?.name || page?.url || 'Page')}</b>
      ${page?.url && page.name !== page.url ? `<span class="small faint ellipsis">${esc(page.url)}</span>` : ''}
    </div>
    ${[...list].sort((a, b) => order(a) - order(b)).map((r) => resultHtml(r, o.dir)).join('')}
  </div>`;
  }).join('');

  const logClass = (l: string) => (/ ✓ |Done:|approved/.test(l) ? 'ok' : / ✗ |failed|Error|error/.test(l) ? 'bad' : / ! |↻|skipped|Cost cap|blocked/.test(l) ? 'warn' : l.includes('] ·') || l.includes(']   ·') ? 'dim' : '');
  const title = `${project.name} · Test run · ${started.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${existsSync(STYLES) ? readFileSync(STYLES, 'utf8') : ''}${EXTRA_CSS}</style>
</head>
<body>
<main class="page">
<div class="stack loose${problems ? ' only-problems' : ''}" id="report">
  <div class="row between wrap top">
    <div class="stack tight">
      <div class="crumbs small"><span>${esc(project.name)}</span><span>/</span><span class="ellipsis">${esc(project.baseUrl)}</span></div>
      <div class="row wrap"><h1>Test run · ${esc(started.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}</h1><span class="badge ${RUN[run.status][0]}">${RUN[run.status][1]}</span></div>
      <span class="small muted">Started by ${esc(run.createdByName ?? run.createdBy)}${took ? ` · took ${took}` : ''} · ${esc(run.options.provider)} · plan: ${esc(run.options.strongModel)} · steps: ${esc(run.options.fastModel)}</span>
    </div>
  </div>
  ${run.error ? `<div class="error-box"><b>The run could not finish.</b> ${esc(run.error)}</div>` : ''}
  <div class="stack">
    <div class="stats">
      <div class="card stat pass"><div class="num">${count('passed')}</div><div class="label">Passed</div></div>
      <div class="card stat fail"><div class="num">${count('failed')}</div><div class="label">Failed</div></div>
      <div class="card stat warn"><div class="num">${count('blocked', 'skipped')}</div><div class="label">Could not test</div></div>
      <div class="card stat"><div class="num">${money(run.costUsd)}</div><div class="label">AI cost</div></div>
    </div>
    <span class="small muted">${ai} tested by the AI · ${replayed} repeated for free from earlier runs · ${checks} automatic checks</span>
    ${c && (c.newFailures.length || c.fixed.length) ? `
    <div class="card card-pad stack tight">
      <b>Since the previous run</b>
      ${c.newFailures.length ? `<div class="small"><span class="badge fail">Newly broken</span> ${esc(c.newFailures.join(' · '))}</div>` : ''}
      ${c.fixed.length ? `<div class="small"><span class="badge pass">Fixed</span> ${esc(c.fixed.join(' · '))}</div>` : ''}
    </div>` : ''}
  </div>
  <div class="card">
    <div class="card-head wrap">
      <h2 id="results-title">${problems ? 'Problems found' : 'All results'}</h2>
      <div class="seg">
        <button type="button" data-view="problems" class="${problems ? 'on' : ''}">Problems (${problems})</button>
        <button type="button" data-view="all" class="${problems ? '' : 'on'}">Everything (${results.length})</button>
      </div>
    </div>
    ${results.length ? '' : '<div class="empty">No results.</div>'}
    <div class="empty problems-empty${problems ? '' : ' show'}">No problems found. Everything passed.</div>
    ${groupHtml}
  </div>
  ${o.log.length ? `
  <details class="card">
    <summary class="card-head" style="cursor:pointer;border-bottom:0"><span class="small muted">Technical log (every action the AI took)</span></summary>
    <div class="log">${o.log.map((l) => `<div class="${logClass(l)}">${esc(l)}</div>`).join('')}</div>
  </details>` : ''}
  <span class="small faint">Exported ${esc(new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))} from AI QA Engineer.</span>
</div>
</main>
<script>
  const report = document.getElementById('report');
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    const problems = b.dataset.view === 'problems';
    report.classList.toggle('only-problems', problems);
    document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x === b));
    document.getElementById('results-title').textContent = problems ? 'Problems found' : 'All results';
  }));
  document.addEventListener('click', (e) => {
    if (e.target.classList && e.target.classList.contains('shot')) e.target.classList.toggle('zoom');
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.shot.zoom').forEach((s) => s.classList.remove('zoom')); });
</script>
</body>
</html>`;
}
