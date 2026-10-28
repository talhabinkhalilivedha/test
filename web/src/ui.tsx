// Small shared components and helpers.
import { createContext, useCallback, useContext, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { ResultStatus, RunStatus } from '../../server/types';

// ── Formatting ──

export const money = (usd: number) => (usd === 0 ? '$0' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
export const seconds = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
export function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = (Date.now() - d.getTime()) / 60_000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
export function duration(start: string | null, end: string | null): string {
  if (!start) return '';
  return seconds((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime());
}

// ── Status badges ──

const RESULT: Record<ResultStatus, [string, string]> = {
  passed: ['pass', 'Passed'], failed: ['fail', 'Failed'], blocked: ['warn', 'Blocked'], skipped: ['skip', 'Skipped'],
};
export const ResultBadge = ({ status }: { status: ResultStatus }) => <span className={`badge ${RESULT[status][0]}`}>{RESULT[status][1]}</span>;

const RUN: Record<RunStatus, [string, string]> = {
  queued: ['skip', 'Queued'], running: ['accent', 'Running'], review: ['warn', 'Needs review'], done: ['pass', 'Finished'],
  error: ['fail', 'Error'], stopped: ['skip', 'Stopped'],
};
export function RunBadge({ status }: { status: RunStatus }) {
  const live = status === 'running' || status === 'queued';
  return <span className={`badge ${RUN[status][0]}`}>{live && <span className="dot pulse" />}{RUN[status][1]}</span>;
}

// ── Controls ──

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string, boolean?]>; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([v, label, disabled]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} disabled={disabled} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}{hint && <> <span className="hint">· {hint}</span></>}</span>
      {children}
    </label>
  );
}

export function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span><b>{label}</b>{hint && <><br /><span className="small faint">{hint}</span></>}</span>
    </label>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head"><h2>{title}</h2><button className="btn ghost icon-btn" onClick={onClose} aria-label="Close">{Icon.x}</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ── Toasts ──

const ToastContext = createContext<(message: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 3500);
    return () => clearTimeout(t);
  }, [message]);
  return <ToastContext.Provider value={setMessage}>{children}{message && <div className="toast" role="status">{message}</div>}</ToastContext.Provider>;
}

// ── Data loading ──

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void; setData: Dispatch<SetStateAction<T | null>> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    load().then((d) => alive && (setData(d), setError(null))).catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []), setData };
}

/** Runs an async action with a busy flag and an error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

// ── Icons (inline SVG, inherit the text color) ──

const svg = (d: ReactNode, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
export const Icon = {
  check: svg(<path d="M5 12.5l4.5 4.5L19 7.5" />),
  x: svg(<path d="M6 6l12 12M18 6L6 18" />),
  play: svg(<path d="M7 5v14l11-7z" fill="currentColor" stroke="none" />),
  stop: svg(<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  chevron: svg(<path d="M9 6l6 6-6 6" />),
  down: svg(<path d="M6 9l6 6 6-6" />),
  upload: svg(<><path d="M12 15V4M7 9l5-5 5 5" /><path d="M5 15v4h14v-4" /></>),
  download: svg(<><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 19h14" /></>),
  trash: svg(<><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>),
  edit: svg(<path d="M4 20h4L19 9l-4-4L4 16v4z" />),
  settings: svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>),
  bolt: svg(<path d="M13 3L5 13h6l-1 8 8-10h-6z" />),
  replay: svg(<><path d="M4 12a8 8 0 1 0 2.3-5.7" /><path d="M4 4v4h4" /></>),
  robot: svg(<><rect x="5" y="8" width="14" height="11" rx="2" /><path d="M12 4v4M9 13h.01M15 13h.01" /></>),
  gauge: svg(<><path d="M12 14l3-5" /><path d="M4 18a9 9 0 1 1 16 0" /></>),
  page: svg(<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>),
  link: svg(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>),
  external: svg(<><path d="M14 4h6v6" /><path d="M10 14L20 4" /><path d="M19 14v6H4V5h6" /></>),
};
