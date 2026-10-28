import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, type Meta } from './api';
import { ProjectsPage } from './pages/Projects';
import { ProjectPage } from './pages/ProjectView';
import { RunPage } from './pages/RunView';
import { HowItWorksPage } from './pages/HowItWorks';

const MetaContext = createContext<Meta | null>(null);
export const useMeta = () => useContext(MetaContext)!;

/** Hash routes: #/ · #/projects/:id[/tab] · #/runs/:id · #/how-it-works */
function useRoute(): string[] {
  const parse = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => {
      setRoute(parse());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (path: string) => { window.location.hash = path; };

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const route = useRoute();

  useEffect(() => {
    get<Meta>('/api/meta').then(setMeta).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <main className="page"><div className="error-box">The app server is not reachable: {error}</div></main>;
  if (!meta) return null;

  let page: ReactNode;
  if (route[0] === 'projects' && route[1]) {
    page = <ProjectPage key={route[1]} id={route[1]} tab={route[2] ?? 'pages'} />;
  } else if (route[0] === 'runs' && route[1]) {
    page = <RunPage key={route[1]} id={route[1]} />;
  } else if (route[0] === 'how-it-works') {
    page = <HowItWorksPage />;
  } else {
    page = <ProjectsPage />;
  }

  return (
    <MetaContext.Provider value={meta}>
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="brand-mark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
          AI QA Engineer
        </a>
        <div className="grow" />
        <a className="btn ghost sm" href="#/how-it-works">How it works</a>
      </header>
      <main className="page">{page}</main>
    </MetaContext.Provider>
  );
}
