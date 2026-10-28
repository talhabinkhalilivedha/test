import { useState, type FormEvent } from 'react';
import type { Project } from '../../../server/types';
import { get, post, type ProjectRow } from '../api';
import { go } from '../App';
import { Field, Icon, Modal, RunBadge, money, useAction, useLoad, when } from '../ui';

export function ProjectsPage() {
  const { data: list, error } = useLoad(() => get<ProjectRow[]>('/api/projects'), []);
  const [creating, setCreating] = useState(false);

  return (
    <div className="stack loose">
      <div className="row between wrap">
        <div className="stack tight">
          <h1>Projects</h1>
          <span className="muted">Each project is one website. Everything tested is saved here for the whole team.</span>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>{Icon.plus} New project</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {list && !list.length && (
        <div className="card empty stack" style={{ alignItems: 'center' }}>
          <h2>No projects yet</h2>
          <p className="muted" style={{ maxWidth: 460, margin: 0 }}>Create a project for the site you want to test, add the pages and what to test on each, then start a run.</p>
          <button className="btn primary" onClick={() => setCreating(true)}>{Icon.plus} New project</button>
        </div>
      )}
      <div className="project-grid">
        {list?.map((p) => (
          <a key={p.id} className="card project-card" href={`#/projects/${p.id}`}>
            <div className="row between">
              <h3 className="ellipsis">{p.name}</h3>
              {p.environment && <span className="badge info">{p.environment}</span>}
            </div>
            <span className="small muted ellipsis">{p.baseUrl}</span>
            <div className="row small faint">
              <span>{p.pageCount} page{p.pageCount === 1 ? '' : 's'}</span>
              <span>·</span>
              {p.lastRun ? <span>Last run {when(p.lastRun.createdAt)}</span> : <span>Never run</span>}
            </div>
            {p.lastRun && (
              <div className="row wrap">
                <RunBadge status={p.lastRun.status} />
                {p.lastRun.summary && <>
                  <span className="badge pass">{p.lastRun.summary.passed} passed</span>
                  {p.lastRun.summary.failed > 0 && <span className="badge fail">{p.lastRun.summary.failed} failed</span>}
                  <span className="small faint">{money(p.lastRun.costUsd)}</span>
                </>}
              </div>
            )}
          </a>
        ))}
      </div>
      {creating && <NewProject onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewProject({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ name: '', baseUrl: '', environment: '', instructions: '' });
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const p = await post<Project>('/api/projects', form);
      go(`/projects/${p.id}`);
    });
  };
  return (
    <Modal title="New project" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" form="new-project" disabled={busy}>Create project</button>
    </>}>
      <form id="new-project" className="stack" onSubmit={submit}>
        <div className="grid-2">
          <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Customer portal" required autoFocus /></Field>
          <Field label="Environment" hint="optional"><input className="input" value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })} placeholder="UAT, staging…" /></Field>
        </div>
        <Field label="Website URL" hint="any environment">
          <input className="input" type="url" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://uat.example.com" required />
        </Field>
        <Field label="About the application" hint="optional, helps the AI understand the site">
          <textarea className="textarea" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })}
            placeholder="e.g. An internal tool where staff upload and search contracts. Users have the Editor role." />
        </Field>
        <p className="small muted" style={{ margin: 0 }}>You can add the pages to test, login details and per-page instructions next.</p>
        {error && <div className="error-box">{error}</div>}
      </form>
    </Modal>
  );
}
