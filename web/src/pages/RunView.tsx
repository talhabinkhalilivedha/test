import { useEffect, useMemo, useRef, useState } from 'react';
import type { PageConfig, Run, TestResult } from '../../../server/types';
import { get, post, type RunDetail, type RunEvent } from '../api';
import { go } from '../App';
import { CasesSection } from './ProjectView';
import { Check, Icon, Modal, ResultBadge, RunBadge, duration, money, seconds, useAction, useLoad, when } from '../ui';

/** What the run is doing, in words. */
const DOING: Record<Run['phase'], string> = {
  queued: 'Waiting for a free slot…',
  login: 'Logging in to the site…',
  discover: 'Looking for pages…',
  checks: 'Running the automatic checks…',
  plan: 'Looking at the pages and writing test cases…',
  review: 'Waiting for you to check the test cases',
  execute: 'Testing…',
  cleanup: 'Deleting the test data it created…',
  report: 'Writing the report…',
  done: 'Finished',
};

/** Merge one live event into the page. Each call must see the previous event's result, or a cost update is lost behind the log line that follows it. */
function applyRunEvent(current: RunDetail | null, e: RunEvent): RunDetail | null {
  if (!current) return current;
  if (e.type === 'log') return { ...current, log: [...current.log, e.line] };
  if (e.type === 'result') return { ...current, results: [...current.results.filter((r) => r.id !== e.result.id), e.result] };
  if (e.type === 'progress') return { ...current, progress: e.progress };
  return { ...current, run: e.run };
}

export function RunPage({ id }: { id: string }) {
  const { data, error, reload, setData } = useLoad(() => get<RunDetail>(`/api/runs/${id}`), [id]);
  const dataRef = useRef(data);
  dataRef.current = data;

  const active = data && ['queued', 'running', 'review'].includes(data.run.status);
  useEffect(() => {
    if (!active) return;
    const source = new EventSource(`/api/runs/${id}/events`);
    source.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as RunEvent;
      if (e.type === 'run' && dataRef.current && e.run.status !== dataRef.current.run.status) reload();
      setData((current) => applyRunEvent(current, e));
    };
    return () => source.close();
  }, [id, active, reload, setData]);

  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);

  if (error) return <div className="error-box">{error}</div>;
  if (!data) return null;
  const { run, project, pages, results } = data;

  return (
    <div className="stack loose">
      <div className="row between wrap top">
        <div className="stack tight">
          <div className="crumbs small"><a href="#/">Projects</a><span>/</span><a href={`#/projects/${project.id}/runs`}>{project.name}</a><span>/</span></div>
          <div className="row wrap"><h1>Test run · {when(run.createdAt)}</h1><RunBadge status={run.status} /></div>
          <span className="small muted">
            Started by {run.createdByName} · took {duration(run.startedAt, run.finishedAt) || '…'}
            {run.options.rerunOf && <> · re-run of <a href={`#/runs/${run.options.rerunOf}`}>an earlier run</a></>}
          </span>
        </div>
        <div className="row wrap">
          {active && <StopButton id={run.id} />}
          {results.length > 0 && !active && <>
            <a className="btn" href={`/api/runs/${run.id}/export/xlsx`}>{Icon.download} Download Excel</a>
            <a className="btn ghost" href={`/api/runs/${run.id}/export/html`} title="One file with screenshots that opens in any browser">HTML report</a>
            <a className="btn ghost" href={`/api/runs/${run.id}/export/csv`}>CSV</a>
          </>}
        </div>
      </div>

      {active && run.status !== 'review' && <Doing data={data} />}
      {run.error && (
        <div className="error-box">
          <b>The run could not finish.</b> {run.error}
          {data.hasLoginScreenshot && <><br /><a href={`/api/runs/${run.id}/files/login-failed.png`} target="_blank" rel="noreferrer">See what the login page looked like</a></>}
        </div>
      )}
      {run.status === 'review' && <ReviewPanel data={data} onApproved={reload} />}
      {results.length > 0 && <Summary run={run} results={results} />}
      {results.length > 0 && <Results run={run} results={results} pages={pages} canRerun={!active} />}
      <LogPanel lines={data.log} />
    </div>
  );
}

function StopButton({ id }: { id: string }) {
  const { busy, run } = useAction();
  return <button className="btn danger" disabled={busy} onClick={() => confirm('Stop this run? What was tested so far is kept.') && run(() => post(`/api/runs/${id}/stop`))}>{Icon.stop} Stop</button>;
}

function Doing({ data }: { data: RunDetail }) {
  const { run, progress } = data;
  const current = progress && progress.phase === run.phase ? progress : null;
  const pct = current?.total ? Math.round((current.done / current.total) * 100) : null;
  return (
    <div className="card card-pad stack">
      <div className="row between wrap">
        <b className="row"><span className="dot pulse" style={{ color: 'var(--accent)' }} />{DOING[run.phase]}</b>
        {current && current.total > 0 && <span className="small muted">{current.done} of {current.total}</span>}
      </div>
      {pct !== null && <div className="bar"><div style={{ width: `${pct}%` }} /></div>}
      {current && current.active.length > 0 && <span className="small muted ellipsis">Now: {current.active.slice(0, 3).join(' · ')}{current.active.length > 3 ? ` +${current.active.length - 3} more` : ''}</span>}
      {run.status === 'queued' && <span className="small muted">Other runs are using the browsers{data.queuePosition >= 0 ? `; this one is number ${data.queuePosition + 1} in line` : ''}.</span>}
    </div>
  );
}

function ReviewPanel({ data, onApproved }: { data: RunDetail; onApproved: () => void }) {
  const { busy, error, run } = useAction();
  const ids = data.run.options.pageIds;
  const pages = data.pages.filter((p) => (ids.length ? ids.includes(p.id) : !p.discovered || data.cases.some((c) => c.pageId === p.id)));
  return (
    <div className="card">
      <div className="card-head wrap">
        <div className="stack tight">
          <h2>Check the test cases</h2>
          <span className="small muted">Untick a test case to skip it, or click the pencil to change it. Then start testing.</span>
        </div>
        <button className="btn primary lg" disabled={busy} onClick={() => run(async () => { await post(`/api/runs/${data.run.id}/approve`); onApproved(); })}>{Icon.play} Start testing</button>
      </div>
      <div className="card-pad stack loose">
        {error && <div className="error-box">{error}</div>}
        {pages.map((p) => (
          <div key={p.id} className="stack tight">
            <div className="row"><span className="faint">{Icon.page}</span><b>{p.name || p.url}</b></div>
            <CasesSection page={p} review />
          </div>
        ))}
      </div>
    </div>
  );
}

function Summary({ run, results }: { run: Run; results: TestResult[] }) {
  const count = (...st: TestResult['status'][]) => results.filter((r) => st.includes(r.status)).length;
  const ai = results.filter((r) => r.mode === 'ai' && r.status !== 'skipped').length;
  const replayed = results.filter((r) => r.mode === 'replay').length;
  const checks = results.filter((r) => r.mode === 'check').length;
  const c = run.summary?.comparison;
  const changes = c && (c.newFailures.length || c.fixed.length);
  return (
    <div className="stack">
      <div className="stats">
        <div className="card stat pass"><div className="num">{count('passed')}</div><div className="label">Passed</div></div>
        <div className="card stat fail"><div className="num">{count('failed')}</div><div className="label">Failed</div></div>
        <div className="card stat warn"><div className="num">{count('blocked', 'skipped')}</div><div className="label">Could not test</div></div>
        <div className="card stat"><div className="num">{money(run.costUsd)}</div><div className="label">AI cost</div></div>
      </div>
      <span className="small muted">
        {ai} tested by the AI · {replayed} repeated for free from earlier runs · {checks} automatic checks
      </span>
      {changes ? (
        <div className="card card-pad stack tight">
          <b>Since the <a href={`#/runs/${c.previousRunId}`}>previous run</a></b>
          {c.newFailures.length > 0 && <div className="small"><span className="badge fail">Newly broken</span> {c.newFailures.join(' · ')}</div>}
          {c.fixed.length > 0 && <div className="small"><span className="badge pass">Fixed</span> {c.fixed.join(' · ')}</div>}
        </div>
      ) : null}
    </div>
  );
}

function Results({ run, results, pages, canRerun }: { run: Run; results: TestResult[]; pages: PageConfig[]; canRerun: boolean }) {
  const problems = results.filter((r) => r.status !== 'passed');
  const [onlyProblems, setOnlyProblems] = useState(problems.length > 0);
  const [open, setOpen] = useState<string | null>(null);
  const [rerun, setRerun] = useState<TestResult[] | null>(null);
  // Results ticked to be run again (by result id). Automatic checks have no test case, so they cannot be picked.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const rerunnable = problems.filter((r) => r.testCaseId);
  const selected = results.filter((r) => picked.has(r.id));
  const pick = (list: TestResult[], on: boolean) => setPicked((now) => {
    const next = new Set(now);
    for (const r of list) if (on) next.add(r.id); else next.delete(r.id);
    return next;
  });
  const shown = onlyProblems ? problems : results;
  const byPage = useMemo(() => {
    const order = pages.map((p) => p.id);
    const groups = new Map<string, TestResult[]>();
    for (const r of shown) groups.set(r.pageId, [...(groups.get(r.pageId) ?? []), r]);
    return [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [shown, pages]);

  return (
    <div className="card">
      <div className="card-head wrap">
        <h2>{onlyProblems ? 'Problems found' : 'All results'}</h2>
        <div className="row wrap">
        {canRerun && selected.length > 0 && <>
          <button className="btn ghost" onClick={() => setPicked(new Set())}>Clear selection</button>
          <button className="btn primary" onClick={() => setRerun(selected)}>{Icon.replay} Run selected again ({selected.length})</button>
        </>}
        {canRerun && !selected.length && rerunnable.length > 0 && (
          <button className="btn" onClick={() => setRerun(rerunnable)} title="Test the failed ones again, to see whether the problems are real. Tick tests to choose which.">{Icon.replay} Run problems again ({rerunnable.length})</button>
        )}
        <div className="seg">
          <button className={onlyProblems ? 'on' : ''} onClick={() => setOnlyProblems(true)}>Problems ({problems.length})</button>
          <button className={onlyProblems ? '' : 'on'} onClick={() => setOnlyProblems(false)}>Everything ({results.length})</button>
        </div>
        </div>
      </div>
      {rerun && <RerunDialog run={run} results={rerun} onClose={() => setRerun(null)} />}
      {canRerun && rerunnable.length > 0 && !selected.length && <div className="small faint" style={{ padding: '8px 20px', borderBottom: '1px solid var(--border)' }}>Tick the tests you want to run again, or use the button to run all problems again.</div>}
      {!shown.length && <div className="empty">{onlyProblems ? 'No problems found. Everything passed.' : 'No results yet.'}</div>}
      {byPage.map(([pageId, list]) => {
        const page = pages.find((p) => p.id === pageId);
        const pickable = list.filter((r) => r.testCaseId);
        const allPicked = pickable.length > 0 && pickable.every((r) => picked.has(r.id));
        return (
          <div key={pageId}>
            <div className="row" style={{ padding: '9px 20px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
              {canRerun && pickable.length > 0 && (
                <input type="checkbox" className="pick" checked={allPicked} onChange={(e) => pick(pickable, e.target.checked)}
                  title="Select every test of this page" aria-label={`Select every test of ${page?.name || page?.url || 'this page'}`} />
              )}
              <span className="faint">{Icon.page}</span><b>{page?.name || page?.url || 'Page'}</b>
            </div>
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {[...list].sort((a, b) => order(a) - order(b)).map((r) => (
                    <ResultRow key={r.id} run={run} r={r} open={open === r.id} toggle={() => setOpen(open === r.id ? null : r.id)}
                      onRerun={canRerun && r.testCaseId ? () => setRerun([r]) : undefined}
                      picked={canRerun ? picked.has(r.id) : undefined} onPick={(on) => pick([r], on)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const order = (r: TestResult) => ({ failed: 0, blocked: 1, skipped: 2, passed: 3 }[r.status] * 10 + (r.mode === 'check' ? 1 : 0));
const HOW = { ai: 'Tested by AI', replay: 'Repeated for free', check: 'Automatic check' };

/** Starts a new run of just these test cases, by default with the browser shown so the QA can watch what really happens. */
function RerunDialog({ run, results, onClose }: { run: Run; results: TestResult[]; onClose: () => void }) {
  const [headed, setHeaded] = useState(true);
  const [fresh, setFresh] = useState(false);
  const { busy, error, run: act } = useAction();
  const caseIds = [...new Set(results.map((r) => r.testCaseId!))];
  const start = () => act(async () => {
    const created = await post<Run>(`/api/projects/${run.projectId}/runs`, {
      options: { ...run.options, caseIds, rerunOf: run.id, headed, fresh, pageIds: [], concurrency: headed ? 1 : run.options.concurrency },
    });
    go(`/runs/${created.id}`);
  });
  return (
    <Modal title={caseIds.length === 1 ? 'Run this test again' : `Run ${caseIds.length} tests again`} onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy} onClick={start}>{Icon.play} Run again</button>
    </>}>
      {error && <div className="error-box">{error}</div>}
      <span className="small muted">
        The same test case{caseIds.length === 1 ? ' runs' : 's run'} again with the same steps and settings ({run.options.dataMode} data), in a new run.
        This run stays as it is.
      </span>
      <ul className="small" style={{ margin: 0, paddingLeft: 18, maxHeight: 200, overflowY: 'auto' }}>{results.map((r) => <li key={r.id}>{r.ref} {r.title}</li>)}</ul>
      <Check checked={headed} onChange={setHeaded} label="Show the browser (Chromium window)" hint="Watch the test on your screen. Tests run one at a time so the windows don't pile up." />
      <Check checked={fresh} onChange={setFresh} label="Let the AI do it again" hint="Don't replay steps recorded earlier (only matters for tests that passed before)" />
    </Modal>
  );
}

function ResultRow({ run, r, open, toggle, onRerun, picked, onPick }: {
  run: Run; r: TestResult; open: boolean; toggle: () => void; onRerun?: () => void; picked?: boolean; onPick: (on: boolean) => void;
}) {
  const pickable = picked !== undefined;
  return (
    <>
      <tr className="click" onClick={toggle} aria-expanded={open}>
        {pickable && (
          <td style={{ width: 34, paddingRight: 0 }} onClick={(e) => e.stopPropagation()}>
            {r.testCaseId && <input type="checkbox" className="pick" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={`Select ${r.title}`} />}
          </td>
        )}
        <td style={{ width: 96 }}><ResultBadge status={r.status} /></td>
        <td>
          <span style={{ fontWeight: 550 }}>{r.title}</span>
          {r.classification === 'flaky' && <span className="badge warn" style={{ marginLeft: 6 }} title="Failed once, then passed when checked again">unstable</span>}
          {r.status !== 'passed' && <div className="small muted ellipsis" style={{ maxWidth: 700 }}>{r.bug?.title ?? r.actual}</div>}
        </td>
        <td className="small faint nowrap" style={{ width: 150 }}>{HOW[r.mode]}</td>
        <td className="faint" style={{ width: 30, transform: open ? 'rotate(90deg)' : undefined }}>{Icon.chevron}</td>
      </tr>
      {open && <tr><td colSpan={pickable ? 5 : 4} style={{ padding: 0 }}><ResultDetail run={run} r={r} onRerun={onRerun} /></td></tr>}
    </>
  );
}

function ResultDetail({ run, r, onRerun }: { run: Run; r: TestResult; onRerun?: () => void }) {
  const [attempts, setAttempts] = useState(false);
  const retries = r.steps.filter((s) => !s.ok).length;
  const steps = attempts || r.status !== 'passed' ? r.steps : r.steps.filter((s) => s.ok);
  const screenshot = r.screenshot ? `/api/runs/${run.id}/files/${r.screenshot}` : null;
  return (
    <div className="result-detail">
      <div className="stack">
        <div className="row between">
          <span className="section-title">What was done</span>
          {retries > 0 && r.status === 'passed' && (
            <a href="#" className="small" onClick={(e) => { e.preventDefault(); setAttempts(!attempts); }}>{attempts ? 'Hide' : 'Show'} retried steps ({retries})</a>
          )}
        </div>
        {steps.length ? (
          <ol className="steps">
            {steps.map((s, i) => <li key={i} className={s.ok ? '' : 'bad'}>{s.text}{s.error && <div className="err">{s.error}</div>}</li>)}
          </ol>
        ) : <span className="small faint">No steps recorded.</span>}
        <span className="small faint">{r.ref} · {seconds(r.durationMs)}{r.mode === 'ai' ? ` · ${money(r.costUsd)} · ${r.model}` : ''}</span>
        {onRerun && <div><button className="btn sm" onClick={onRerun}>{Icon.replay} Run this test again</button></div>}
      </div>
      <div className="stack">
        <div><div className="section-title">Expected</div><div style={{ whiteSpace: 'pre-wrap' }}>{r.expected || '—'}</div></div>
        <div><div className="section-title">What happened</div><div style={{ whiteSpace: 'pre-wrap' }}>{r.actual || '—'}</div></div>
        {r.bug && r.status === 'failed' && (
          <div className="bug stack tight">
            <div className="row between"><b>Bug: {r.bug.title}</b><span className={`badge ${r.bug.severity === 'critical' || r.bug.severity === 'major' ? 'fail' : 'warn'}`}>{r.bug.severity}</span></div>
            {r.bug.stepsToReproduce.length > 0 && <div className="small"><div className="section-title">How to reproduce</div><ol className="steps">{r.bug.stepsToReproduce.map((s, i) => <li key={i}>{s}</li>)}</ol></div>}
          </div>
        )}
        {screenshot && <a href={screenshot} target="_blank" rel="noreferrer"><img className="shot" src={screenshot} alt={`Screenshot of ${r.title}`} loading="lazy" /></a>}
      </div>
    </div>
  );
}

function LogPanel({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length, open]);
  const cls = (l: string) => (/ ✓ |Done:|approved/.test(l) ? 'ok' : / ✗ |failed|Error|error/.test(l) ? 'bad' : / ! |↻|skipped|Cost cap|blocked/.test(l) ? 'warn' : l.includes('] ·') || l.includes(']   ·') ? 'dim' : '');
  return (
    <div className="card">
      <div className="card-head" style={{ cursor: 'pointer', borderBottom: open ? undefined : 0 }} onClick={() => setOpen(!open)}>
        <div className="row"><span className="faint" style={{ transform: open ? 'rotate(90deg)' : undefined, display: 'flex' }}>{Icon.chevron}</span><span className="small muted">Technical log (every action the AI took)</span></div>
      </div>
      {open && <div className="log" ref={ref}>{lines.map((l, i) => <div key={i} className={cls(l)}>{l}</div>)}</div>}
    </div>
  );
}
