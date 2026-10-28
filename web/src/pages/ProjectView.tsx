import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ExtractJob, PageConfig, Project, Provider, Run, RunOptions, TestCase } from '../../../server/types';
import { del, get, post, put, type PageRow, type ProjectDetail } from '../api';
import { go, useMeta } from '../App';
import { Check, Field, Icon, Modal, RunBadge, duration, money, useAction, useLoad, useToast, when } from '../ui';

/** The AI focus areas a QA can pick for a page, in plain words. (Automatic checks always run.) */
const FOCUS: Array<[string, string]> = [
  ['validation', 'Forms & validation'],
  ['negative', 'Error handling'],
  ['search', 'Search & filters'],
  ['navigation', 'Menus & navigation'],
  ['uploads', 'File uploads'],
  ['content', 'Text & labels'],
];

export function ProjectPage({ id, tab }: { id: string; tab: string }) {
  const { data, error, reload } = useLoad(() => get<ProjectDetail>(`/api/projects/${id}`), [id]);
  const [running, setRunning] = useState(false);
  if (error) return <div className="error-box">{error}</div>;
  if (!data) return null;
  const { project, pages, runs } = data;
  const live = runs.find((r) => ['queued', 'running', 'review'].includes(r.status));

  return (
    <div className="stack loose">
      <div className="row between wrap top">
        <div className="stack tight" style={{ minWidth: 0 }}>
          <div className="crumbs small"><a href="#/">Projects</a><span>/</span></div>
          <div className="row wrap"><h1>{project.name}</h1>{project.environment && <span className="badge info">{project.environment}</span>}</div>
          <a className="small" href={project.baseUrl} target="_blank" rel="noreferrer">{project.baseUrl}</a>
        </div>
        <ExtractUrls projectId={project.id} onAdded={reload}>
          {live && <a className="btn" href={`#/runs/${live.id}`}><span className="dot pulse" style={{ color: 'var(--accent)' }} /> Run in progress</a>}
          <button className="btn primary lg" onClick={() => setRunning(true)}>{Icon.play} Run tests</button>
        </ExtractUrls>
      </div>

      <div className="tabs" role="tablist">
        {[['pages', 'Pages'], ['runs', `Results (${runs.length})`], ['settings', 'Settings']].map(([t, label]) => (
          <button key={t} role="tab" className={tab === t ? 'on' : ''} onClick={() => go(`/projects/${id}/${t}`)}>{label}</button>
        ))}
      </div>

      {tab === 'pages' && <PagesTab project={project} pages={pages} reload={reload} />}
      {tab === 'runs' && <RunsTab runs={runs} />}
      {tab === 'settings' && <SettingsTab project={project} reload={reload} />}
      {running && <RunDialog project={project} pages={pages} onClose={() => setRunning(false)} />}
    </div>
  );
}

// ── Pages ────────────────────────────────────────────────────────────────────────────────────

function PagesTab({ project, pages, reload }: { project: Project; pages: PageRow[]; reload: () => void }) {
  // New cards stay the same card after they are saved, so typing is not interrupted.
  const [drafts, setDrafts] = useState<Array<{ key: string; id?: string }>>([]);
  const [extras, setExtras] = useState<PageRow | null>(null);
  const own = pages.filter((p) => !p.discovered);
  const listed = own.filter((p) => !drafts.some((d) => d.id === p.id));
  const found = pages.filter((p) => p.discovered);
  const removeFound = async (list: PageRow[]) => {
    if (!confirm(`Remove all ${list.length} pages found automatically? Their test cases are removed too.`)) return;
    for (const p of list) await del(`/api/pages/${p.id}`);
    reload();
  };
  return (
    <div className="stack loose">
      <div className="card card-pad stack">
        <div className="stack tight">
          <h2>What to test</h2>
          <span className="muted">
            Add the pages to test and, for each one, what to test on it. A page with an empty description gets general
            testing. No pages at all: the AI explores the whole site and tests it in general.
          </span>
        </div>
        {listed.map((p, i) => <PageCard key={p.id} n={i + 1} projectId={project.id} page={p} onChanged={reload} onExtras={() => setExtras(p)} />)}
        {drafts.map((d, i) => {
          const saved = pages.find((p) => p.id === d.id);
          return (
            <PageCard key={d.key} n={listed.length + i + 1} projectId={project.id} baseUrl={project.baseUrl} page={saved}
              onCreated={(id) => { setDrafts((all) => all.map((x) => (x.key === d.key ? { ...x, id } : x))); reload(); }}
              onChanged={() => { setDrafts((all) => all.filter((x) => x.key !== d.key)); reload(); }}
              onExtras={() => saved && setExtras(saved)} />
          );
        })}
        <div><button className="btn" onClick={() => setDrafts((d) => [...d, { key: Math.random().toString(36).slice(2) }])}>{Icon.plus} Add page</button></div>
      </div>
      {found.length > 0 && (
        <div className="card card-pad stack">
          <div className="stack tight">
            <h2>Pages found automatically</h2>
            <span className="small muted">
              Found with <b>Extract URLs</b> or while the AI explored. With no pages listed above, a run tests all of these.
              Type a description to test one in a particular way.
            </span>
          </div>
          {found.length > 1 && <div><button className="btn ghost" onClick={() => removeFound(found)}>{Icon.trash} Remove all {found.length}</button></div>}
          {found.map((p, i) => <PageCard key={p.id} n={i + 1} projectId={project.id} page={p} onChanged={reload} onExtras={() => setExtras(p)} />)}
        </div>
      )}
      {extras && <PageExtras page={extras} onClose={() => { setExtras(null); reload(); }} />}
    </div>
  );
}

/** One page: its URL and what to test, saved as soon as the QA leaves a field. */
function PageCard({ n, projectId, page, baseUrl, onChanged, onCreated, onExtras }: {
  n: number; projectId: string; page?: PageRow; baseUrl?: string;
  onChanged: () => void; onCreated?: (id: string) => void; onExtras?: () => void;
}) {
  // Set as soon as a new card is saved, before the page list has been reloaded.
  const createdId = useRef<string | null>(null);
  const pageId = page?.id ?? createdId.current;
  const [url, setUrl] = useState(page?.url ?? '');
  const [instructions, setInstructions] = useState(page?.instructions ?? '');
  const [status, setStatus] = useState<'' | 'saving' | 'saved'>('');
  const { error, setError, run } = useAction();
  const saved = useRef({ url: page?.url ?? '', instructions: page?.instructions ?? '' });

  const save = () => {
    const u = url.trim();
    if (u === saved.current.url && instructions === saved.current.instructions) return;
    if (!u) return pageId ? setError('Enter the page address, or remove the page with ✕') : undefined;
    if (!/^https?:\/\/\S+$/.test(u)) return setError('The address must start with http:// or https://');
    setStatus('saving');
    run(async () => {
      const body = { url: u, name: page?.name ?? '', instructions, checklist: page?.checklist ?? [], onlyMyTests: page?.onlyMyTests ?? false };
      if (pageId) await put(`/api/pages/${pageId}`, body);
      else {
        createdId.current = (await post<PageConfig>(`/api/projects/${projectId}/pages`, body)).id;
        onCreated?.(createdId.current);
      }
      saved.current = { url: u, instructions };
      setStatus('saved');
      setTimeout(() => setStatus(''), 1500);
    }).then(() => setStatus((s) => (s === 'saving' ? '' : s)));
  };
  const remove = () => run(async () => {
    const yours = page ? page.caseCount - page.aiCaseCount : 0;
    if (yours > 0 && !confirm(`Remove this page and its ${yours} test case${yours === 1 ? '' : 's'}?`)) return;
    if (pageId) await del(`/api/pages/${pageId}`);
    onChanged();
  });

  const yours = page ? page.caseCount - page.aiCaseCount : 0;
  const focus = page?.checklist.filter((c) => FOCUS.some(([id]) => id === c)).length ?? 0;
  return (
    <div className="page-card">
      <span className="page-num">{n}</span>
      <div className="grow stack tight">
        <input className="input" type="url" value={url} onChange={(e) => { setUrl(e.target.value); setError(null); }} onBlur={save}
          placeholder={baseUrl ? `${baseUrl.replace(/\/?$/, '/')}…` : 'https://…'} autoFocus={!page} aria-label={`Page ${n} address`} />
        <textarea className="textarea" rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} onBlur={save}
          placeholder="What should be tested on this page? Leave empty for general testing." aria-label={`What to test on page ${n}`} />
        {error && <span className="small" style={{ color: 'var(--fail)' }}>{error}</span>}
        {page && (
          <div className="row small wrap" style={{ gap: 10 }}>
            <a href="#" onClick={(e) => { e.preventDefault(); onExtras?.(); }}>
              {yours || focus ? `${yours ? `${yours} test case${yours === 1 ? '' : 's'} of yours` : ''}${yours && focus ? ' · ' : ''}${focus ? `${focus} focus area${focus === 1 ? '' : 's'}` : ''}` : 'Upload test cases or pick focus areas'}
            </a>
            {status && <span className="faint">{status === 'saving' ? 'Saving…' : 'Saved'}</span>}
          </div>
        )}
      </div>
      <button className="btn ghost icon-btn" onClick={remove} title="Remove page" aria-label={`Remove page ${n}`}>{Icon.x}</button>
    </div>
  );
}

/** The optional extras of a page: focus areas and the QA's own test cases. */
function PageExtras({ page: initial, onClose }: { page: PageConfig; onClose: () => void }) {
  const [page, setPage] = useState(initial);
  const focus = page.checklist.filter((c) => FOCUS.some(([id]) => id === c));
  const savePage = async (patch: Partial<PageConfig>) => {
    const next = { ...page, ...patch };
    setPage(await put<PageConfig>(`/api/pages/${page.id}`, {
      url: next.url, name: next.name, instructions: next.instructions, checklist: next.checklist, onlyMyTests: next.onlyMyTests,
    }));
  };
  const toggle = (id: string) => savePage({ checklist: focus.includes(id) ? focus.filter((c) => c !== id) : [...focus, id] });

  return (
    <Modal wide title={page.name || page.url} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="stack tight">
        <b>Pay extra attention to <span className="faint" style={{ fontWeight: 400 }}>· optional</span></b>
        <div className="row wrap">
          {FOCUS.map(([id, label]) => (
            <button type="button" key={id} className={`chip${focus.includes(id) ? ' on' : ''}`} onClick={() => toggle(id)} aria-pressed={focus.includes(id)}>
              {focus.includes(id) && Icon.check}{label}
            </button>
          ))}
        </div>
        <span className="small faint">Broken links, console errors, accessibility and mobile layout are always checked, for free.</span>
      </div>
      <div className="divider" />
      <CasesSection page={page} onlyMyTests={page.onlyMyTests} setOnlyMyTests={(v) => savePage({ onlyMyTests: v })} />
    </Modal>
  );
}

// ── Test cases ───────────────────────────────────────────────────────────────────────────────

/** The test cases of a page: the QA's own (uploaded or written here) and, folded away, the AI's. */
export function CasesSection({ page, onlyMyTests, setOnlyMyTests, review }: {
  page: PageConfig; onlyMyTests?: boolean; setOnlyMyTests?: (v: boolean) => void; review?: boolean;
}) {
  const { data: cases, reload } = useLoad(() => get<TestCase[]>(`/api/pages/${page.id}/cases`), [page.id]);
  const [editing, setEditing] = useState<TestCase | 'new' | null>(null);
  const [showAi, setShowAi] = useState(!!review);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { busy, error, run } = useAction();
  const mine = cases?.filter((c) => c.source !== 'ai') ?? [];
  const ai = cases?.filter((c) => c.source === 'ai') ?? [];

  const upload = (file: File) => run(async () => {
    const body = new FormData();
    body.append('file', file);
    const r = await post<{ imported: number; warnings: string[] }>(`/api/pages/${page.id}/upload`, body);
    toast(`Added ${r.imported} test case${r.imported === 1 ? '' : 's'} from ${file.name}${r.warnings.length ? `. ${r.warnings.join(' ')}` : ''}`);
    reload();
  });
  const replan = () => run(async () => {
    if (!confirm('Throw away the AI\'s test cases for this page? The next run will look at the page again and write new ones.')) return;
    await post(`/api/pages/${page.id}/replan`);
    reload();
  });

  return (
    <div className="stack">
      {!review && (
        <div className="row between wrap">
          <div className="stack" style={{ gap: 2 }}>
            <h3>Your test cases {mine.length > 0 && <span className="faint">({mine.length})</span>}</h3>
            <span className="small muted">Optional. Upload your existing test cases or write one here: they run exactly as written.</span>
          </div>
          <div className="row">
            <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={busy}>{Icon.upload} Upload Excel / CSV</button>
            <button className="btn sm" onClick={() => setEditing('new')}>{Icon.plus} Write one</button>
            <input ref={fileRef} type="file" accept=".csv,.xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} />
          </div>
        </div>
      )}
      {!review && <span className="small faint" style={{ marginTop: -6 }}>Not sure about the file format? <a href="/api/sample/xlsx">Download a sample Excel file</a>. A new upload replaces the previous one.</span>}
      {error && <div className="error-box">{error}</div>}
      {mine.length > 0 && <div className="stack tight">{mine.map((c) => <CaseRow key={c.id} c={c} onEdit={() => setEditing(c)} onChange={reload} />)}</div>}
      {!review && mine.length > 0 && setOnlyMyTests && (
        <Check checked={!!onlyMyTests} onChange={setOnlyMyTests} label="Only run my test cases" hint="The AI will not add test cases of its own for this page" />
      )}

      {(ai.length > 0 || review) && !(onlyMyTests && !review) && (
        <div className="stack tight">
          <div className="row between">
            <a href="#" className="row" style={{ gap: 4, fontWeight: 550 }} onClick={(e) => { e.preventDefault(); setShowAi(!showAi); }}>
              <span style={{ display: 'flex', transform: showAi ? 'rotate(90deg)' : undefined }}>{Icon.chevron}</span>
              Test cases written by the AI ({ai.length})
            </a>
            {ai.length > 0 && !review && <button className="btn ghost sm" onClick={replan} disabled={busy}>{Icon.replay} Write new ones</button>}
          </div>
          {showAi && (ai.length
            ? ai.map((c) => <CaseRow key={c.id} c={c} onEdit={() => setEditing(c)} onChange={reload} />)
            : <span className="small faint">None for this page.</span>)}
        </div>
      )}
      {editing && <CaseEditor page={page} c={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function CaseRow({ c, onEdit, onChange }: { c: TestCase; onEdit: () => void; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const toggle = async (enabled: boolean) => { await post(`/api/cases/${c.id}/enabled`, { enabled }); onChange(); };
  const remove = async () => { if (confirm(`Delete the test case "${c.title}"?`)) { await del(`/api/cases/${c.id}`); onChange(); } };
  return (
    <div className={`case${c.enabled ? '' : ' off'}`}>
      <div className="row top">
        <input type="checkbox" checked={c.enabled} onChange={(e) => toggle(e.target.checked)} title={c.enabled ? 'Untick to skip this test' : 'Tick to run this test'}
          style={{ marginTop: 3, accentColor: 'var(--accent)' }} />
        <div className="grow" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
          <span style={{ fontWeight: 550 }}>{c.title}</span>
          <span className="small faint"> · {c.ref}{c.enabled ? '' : ' · skipped'}</span>
        </div>
        <button className="btn ghost icon-btn" onClick={onEdit} title="Edit">{Icon.edit}</button>
        <button className="btn ghost icon-btn" onClick={remove} title="Delete">{Icon.trash}</button>
      </div>
      {open && (
        <div className="grid-2 small" style={{ marginTop: 10, paddingLeft: 24 }}>
          <div><div className="section-title">Steps</div><div style={{ whiteSpace: 'pre-wrap' }}>{c.steps || '—'}</div></div>
          <div className="stack tight">
            <div><div className="section-title">Expected result</div><div style={{ whiteSpace: 'pre-wrap' }}>{c.expected || '—'}</div></div>
            {c.preconditions && <div><div className="section-title">Before you start</div>{c.preconditions}</div>}
            {c.testData && <div><div className="section-title">Test data</div>{c.testData}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function CaseEditor({ page, c, onClose, onSaved }: { page: PageConfig; c: TestCase | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    ref: c?.ref ?? '', title: c?.title ?? '', category: c?.category ?? 'functional', priority: c?.priority ?? 'medium',
    preconditions: c?.preconditions ?? '', steps: c?.steps ?? '', expected: c?.expected ?? '', testData: c?.testData ?? '', enabled: c?.enabled ?? true,
  });
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (c) await put(`/api/cases/${c.id}`, form);
      else await post(`/api/pages/${page.id}/cases`, form);
      onSaved();
    });
  };
  return (
    <Modal title={c ? 'Edit test case' : 'Write a test case'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" form="case-form" disabled={busy}>Save</button>
    </>}>
      <form id="case-form" className="stack" onSubmit={submit}>
        <Field label="Title"><input className="input" value={form.title} onChange={set('title')} required autoFocus placeholder="e.g. Upload a PDF document" /></Field>
        <Field label="Steps" hint="one per line, using the words shown on the page">
          <textarea className="textarea" rows={5} value={form.steps} onChange={set('steps')} placeholder={'1. Click "New document"\n2. Type a title\n3. Click "Save"'} />
        </Field>
        <Field label="Expected result"><textarea className="textarea" rows={3} value={form.expected} onChange={set('expected')} placeholder='The message "Document saved" appears and the document is in the list' /></Field>
        <div className="grid-2">
          <Field label="Test data" hint="optional"><input className="input" value={form.testData} onChange={set('testData')} /></Field>
          <Field label="Test ID" hint="optional"><input className="input" value={form.ref} onChange={set('ref')} placeholder="TC-001" /></Field>
        </div>
        {error && <div className="error-box">{error}</div>}
      </form>
    </Modal>
  );
}

// ── Extract URLs ─────────────────────────────────────────────────────────────────────────────

/**
 * The header buttons, with "Extract URLs" first: it finds the site's pages by following its links (no AI) and adds
 * them to "Pages found automatically", so they can be checked before testing. Optional: runs work without it.
 */
function ExtractUrls({ projectId, onAdded, children }: { projectId: string; onAdded: () => void; children: ReactNode }) {
  const toast = useToast();
  const [job, setJob] = useState<ExtractJob | null>(null);
  const [starting, setStarting] = useState(false);
  const added = useRef(0);
  const running = job?.status === 'running';
  const follow = (next: ExtractJob | null) => {
    if (next && next.added !== added.current) { added.current = next.added; onAdded(); }
    setJob(next);
  };
  // Picks up a job that is still running (after leaving and coming back), then follows it every 2 seconds.
  useEffect(() => { get<{ job: ExtractJob | null }>(`/api/projects/${projectId}/extract`).then((r) => r.job?.status === 'running' && follow(r.job)).catch(() => {}); }, [projectId]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const r = await get<{ job: ExtractJob | null }>(`/api/projects/${projectId}/extract`).catch(() => null);
      if (!r?.job) return;
      follow(r.job);
      if (r.job.status === 'done') toast(r.job.message);
    }, 2_000);
    return () => clearInterval(t);
  }, [running, projectId]);
  const start = async () => {
    setStarting(true);
    try {
      const next = await post<ExtractJob>(`/api/projects/${projectId}/extract`);
      added.current = next.added;
      setJob(next);
    } catch (e) {
      setJob({ status: 'failed', message: e instanceof Error ? e.message : String(e), added: 0, startedAt: '' });
    } finally {
      setStarting(false);
    }
  };
  return (
    <div className="stack tight" style={{ alignItems: 'flex-end', maxWidth: 520 }}>
      <div className="row">
        <button className="btn lg" onClick={start} disabled={running || starting}
          title="Find the site's pages by following its links, and add them to the list. No AI, no cost.">
          {running || starting ? <span className="dot pulse" style={{ color: 'var(--accent)' }} /> : Icon.link} {running ? 'Extracting URLs…' : 'Extract URLs'}
        </button>
        {children}
      </div>
      {running && <span className="small muted" style={{ textAlign: 'right' }}>{job.message}</span>}
      {job?.status === 'failed' && <div className="error-box small">Extract URLs failed: {job.message}</div>}
    </div>
  );
}

// ── Results (run history) ────────────────────────────────────────────────────────────────────

function RunsTab({ runs }: { runs: Run[] }) {
  if (!runs.length) return <div className="card empty">Nothing tested yet. Click <b>Run tests</b> to start.</div>;
  return (
    <div className="card table-wrap">
      <table className="table">
        <thead><tr><th>When</th><th>Status</th><th>Result</th><th>Cost</th><th>Took</th><th>By</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="click" onClick={() => go(`/runs/${r.id}`)}>
              <td className="nowrap">{when(r.createdAt)}</td>
              <td><RunBadge status={r.status} /></td>
              <td>{r.summary ? <div className="row wrap" style={{ gap: 5 }}>
                <span className="badge pass">{r.summary.passed} passed</span>
                {r.summary.failed > 0 && <span className="badge fail">{r.summary.failed} failed</span>}
              </div> : <span className="faint">—</span>}</td>
              <td className="nowrap">{money(r.costUsd)}</td>
              <td className="nowrap small muted">{duration(r.startedAt, r.finishedAt)}</td>
              <td className="small muted">{r.createdByName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────

function SettingsTab({ project, reload }: { project: Project; reload: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: project.name, baseUrl: project.baseUrl, environment: project.environment, instructions: project.instructions,
    loginUrl: project.login?.loginUrl ?? '', username: project.login?.username ?? '', password: '',
    open: project.login?.selectors.open ?? '', usernameSel: project.login?.selectors.username ?? '',
    passwordSel: project.login?.selectors.password ?? '', submit: project.login?.selectors.submit ?? '',
    rememberMe: project.login?.rememberMe ?? 'auto', remember: project.login?.selectors.remember ?? '',
  });
  const [advanced, setAdvanced] = useState(!!(form.open || form.usernameSel || form.passwordSel || form.submit || form.remember));
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const save = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await put(`/api/projects/${project.id}`, {
        name: form.name, baseUrl: form.baseUrl, environment: form.environment, instructions: form.instructions,
        login: form.username ? {
          loginUrl: form.loginUrl, username: form.username, password: form.password || undefined, rememberMe: form.rememberMe,
          selectors: {
            open: form.open || undefined, username: form.usernameSel || undefined, password: form.passwordSel || undefined,
            submit: form.submit || undefined, remember: form.remember || undefined,
          },
        } : null,
      });
      setForm({ ...form, password: '' });
      toast('Settings saved');
      reload();
    });
  };
  const remove = () => run(async () => {
    if (prompt('This deletes the project with all its pages, test cases and results. Type the project name to confirm:') !== project.name) return;
    await del(`/api/projects/${project.id}`);
    go('/');
  });
  return (
    <form className="stack loose" onSubmit={save} style={{ maxWidth: 760 }}>
      <div className="card card-pad stack">
        <h2>Website</h2>
        <div className="grid-2">
          <Field label="Project name"><input className="input" value={form.name} onChange={set('name')} required /></Field>
          <Field label="Environment" hint="optional"><input className="input" value={form.environment} onChange={set('environment')} placeholder="UAT, staging…" /></Field>
        </div>
        <Field label="Website address"><input className="input" type="url" value={form.baseUrl} onChange={set('baseUrl')} required /></Field>
        <Field label="Tell the AI about the application" hint="optional">
          <textarea className="textarea" value={form.instructions} onChange={set('instructions')} rows={3} placeholder="e.g. An internal tool where staff upload and search contracts." />
        </Field>
      </div>
      <div className="card card-pad stack">
        <div className="stack tight">
          <h2>Login</h2>
          <span className="small muted">Only if the site needs a login. The app logs in by itself before testing; the AI never sees the password.</span>
        </div>
        <div className="grid-2">
          <Field label="Username or email"><input className="input" value={form.username} onChange={set('username')} autoComplete="off" /></Field>
          <Field label="Password" hint={project.login?.hasPassword ? 'saved' : undefined}>
            <input className="input" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" placeholder={project.login?.hasPassword ? '•••••••• (type to change)' : ''} />
          </Field>
        </div>
        <Field label="Login page address" hint="only if it is not the website address"><input className="input" type="url" value={form.loginUrl} onChange={set('loginUrl')} /></Field>
        <Field label="Remember me" hint="keeps the login for every test browser">
          <select className="select" value={form.rememberMe} onChange={set('rememberMe')}>
            <option value="auto">Tick it when the login form has one</option>
            <option value="off">Leave it unticked</option>
          </select>
        </Field>
        <a href="#" className="small" onClick={(e) => { e.preventDefault(); setAdvanced(!advanced); }}>{advanced ? 'Hide' : 'Login does not work?'} {advanced ? 'technical settings' : 'Set the form fields by hand'}</a>
        {advanced && (
          <div className="grid-2">
            <Field label="Button that opens the login form" hint="CSS"><input className="input mono" value={form.open} onChange={set('open')} placeholder="button.login" /></Field>
            <Field label="Username field" hint="CSS"><input className="input mono" value={form.usernameSel} onChange={set('usernameSel')} placeholder="#email" /></Field>
            <Field label="Password field" hint="CSS"><input className="input mono" value={form.passwordSel} onChange={set('passwordSel')} placeholder="#password" /></Field>
            <Field label="Login button" hint="CSS"><input className="input mono" value={form.submit} onChange={set('submit')} placeholder="button[type=submit]" /></Field>
            <Field label="Remember me checkbox" hint="CSS"><input className="input mono" value={form.remember} onChange={set('remember')} placeholder="#remember-me" /></Field>
          </div>
        )}
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy}>Save settings</button>
        <div className="grow" />
        <button type="button" className="btn danger" onClick={remove} disabled={busy}>{Icon.trash} Delete project</button>
      </div>
    </form>
  );
}

// ── Run dialog ───────────────────────────────────────────────────────────────────────────────

const DEPTHS: Array<[RunOptions['depth'], string, string]> = [
  ['smoke', 'Quick check', 'A few key tests per page'],
  ['standard', 'Normal', 'Every feature’s main flow'],
  ['deep', 'Thorough', 'Plus validation and edge cases'],
];
const DATA: Array<[RunOptions['dataMode'], string, string]> = [
  ['read-only', 'No, only look around', 'Safest. Forms are filled in but never saved.'],
  ['create', 'Yes, it may add test records', 'Records are named "pw-test-…". Nothing is edited or deleted.'],
  ['full', 'Yes, it may add, edit and delete test records', 'Only "pw-test-…" records, and they are deleted again at the end.'],
];

function RunDialog({ project, pages, onClose }: { project: Project; pages: PageRow[]; onClose: () => void }) {
  const meta = useMeta();
  const [o, setO] = useState<RunOptions>(() => {
    const d = { ...project.defaults, pageIds: [], fresh: false };
    if (!meta.providers[d.provider].available) {
      const p = (Object.keys(meta.providers) as Provider[]).find((k) => meta.providers[k].available) ?? 'claude-cli';
      return { ...d, provider: p, strongModel: meta.models[p].strong, fastModel: meta.models[p].fast };
    }
    return d;
  });
  const [more, setMore] = useState(false);
  const set = <K extends keyof RunOptions>(k: K, v: RunOptions[K]) => setO((x) => ({ ...x, [k]: v }));
  const { busy, error, run } = useAction();
  const own = pages.filter((p) => !p.discovered);
  const found = pages.filter((p) => p.discovered);
  const selected = o.pageIds.length ? pages.filter((p) => o.pageIds.includes(p.id)) : own;
  const recorded = selected.reduce((n, p) => n + p.recordedCount, 0);
  const choices = meta.models[o.provider].choices;

  const setProvider = (p: Provider) => setO((x) => ({ ...x, provider: p, strongModel: meta.models[p].strong, fastModel: meta.models[p].fast }));
  const togglePage = (id: string) => {
    const ids = o.pageIds.length ? o.pageIds : own.map((p) => p.id);
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    set('pageIds', next.length === own.length ? [] : next);
  };
  const start = () => run(async () => {
    // Deleting test data again at the end goes with permission to delete.
    const r = await post<Run>(`/api/projects/${project.id}/runs`, { options: { ...o, cleanup: o.dataMode === 'full' } });
    go(`/runs/${r.id}`);
  });

  return (
    <Modal title="Run tests" onClose={onClose} footer={<>
      <span className="grow small muted">
        {own.length ? `${selected.length} page${selected.length === 1 ? '' : 's'}`
          : found.length > 1 ? `${found.length} pages found on the site` : 'No pages listed: the AI explores the whole site'}
        {recorded > 0 && !o.fresh ? ` · ${recorded} test${recorded === 1 ? '' : 's'} can be repeated for free` : ''}
      </span>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={start} disabled={busy || (own.length > 0 && !selected.length)}>{Icon.play} Start</button>
    </>}>
      <div className="stack tight">
        <b>How thorough?</b>
        <div className="grid-3">
          {DEPTHS.map(([v, label, hint]) => (
            <button key={v} type="button" className={`option${o.depth === v ? ' on' : ''}`} onClick={() => set('depth', v)} aria-pressed={o.depth === v}>
              <b>{label}</b><span className="small muted">{hint}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="stack tight">
        <b>May the AI change data on the site?</b>
        {DATA.map(([v, label, hint]) => (
          <label key={v} className="check">
            <input type="radio" name="data" checked={o.dataMode === v} onChange={() => set('dataMode', v)} />
            <span><b>{label}</b><br /><span className="small faint">{hint}</span></span>
          </label>
        ))}
      </div>
      <Check checked={o.review} onChange={(v) => set('review', v)} label="Let me check the test cases before they run" hint="The run waits after planning until you approve" />

      <a href="#" className="row small" style={{ gap: 4 }} onClick={(e) => { e.preventDefault(); setMore(!more); }}>
        <span style={{ display: 'flex', transform: more ? 'rotate(90deg)' : undefined }}>{Icon.chevron}</span> More options
      </a>
      {more && (
        <div className="stack" style={{ paddingLeft: 18 }}>
          {own.length > 1 && (
            <Field label="Pages to test">
              <div className="stack tight" style={{ maxHeight: 150, overflowY: 'auto' }}>
                {own.map((p) => <label key={p.id} className="row small" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={!o.pageIds.length || o.pageIds.includes(p.id)} onChange={() => togglePage(p.id)} style={{ accentColor: 'var(--accent)' }} />
                  <span className="ellipsis">{p.name || p.url}</span>
                </label>)}
              </div>
            </Field>
          )}
          <Check checked={o.discoverPages} onChange={(v) => set('discoverPages', v)} label="Find more pages" hint={`Also test up to ${o.maxExtraPages} pages found by following links from your pages`} />
          {o.discoverPages && (
            <Field label="Max pages to find" hint="up to 50"><input className="input" type="number" min={1} max={50} value={o.maxExtraPages} onChange={(e) => set('maxExtraPages', Math.min(50, Math.max(1, Number(e.target.value))))} /></Field>
          )}
          <div className="grid-2">
            <Field label="AI">
              <select className="select" value={o.provider} onChange={(e) => setProvider(e.target.value as Provider)}>
                {(Object.keys(meta.providers) as Provider[]).map((p) => (
                  <option key={p} value={p} disabled={!meta.providers[p].available}>{meta.providers[p].label}{meta.providers[p].available ? '' : ' (not set up)'}</option>
                ))}
              </select>
            </Field>
            <Field label="Spending limit per run ($)" hint="0 = none"><input className="input" type="number" min={0} step={0.5} value={o.costCapUsd} onChange={(e) => set('costCapUsd', Number(e.target.value))} /></Field>
            <Field label="Model that plans">
              <select className="select" value={o.strongModel} onChange={(e) => set('strongModel', e.target.value)}>
                {[...new Set([...choices, o.strongModel])].map((m) => <option key={m}>{m}</option>)}
              </select>
            </Field>
            <Field label="Model that clicks through tests">
              <select className="select" value={o.fastModel} onChange={(e) => set('fastModel', e.target.value)}>
                {[...new Set([...choices, o.fastModel])].map((m) => <option key={m}>{m}</option>)}
              </select>
            </Field>
            <Field label="Max AI test cases per page" hint="0 = no limit"><input className="input" type="number" min={0} max={200} value={o.maxTestsPerPage} onChange={(e) => set('maxTestsPerPage', Number(e.target.value))} /></Field>
            <Field label="Tests at the same time"><input className="input" type="number" min={1} max={8} value={o.concurrency} onChange={(e) => set('concurrency', Number(e.target.value))} /></Field>
          </div>
          <Check checked={o.fresh} onChange={(v) => set('fresh', v)} label="Start from scratch" hint="Ignore what earlier runs learned (costs more)" />
          <Check checked={o.headed} onChange={(v) => set('headed', v)} label="Show the browser windows" hint="Only useful when the app runs on your own computer" />
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
    </Modal>
  );
}
