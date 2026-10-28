import { Icon } from '../ui';

const STEPS: Array<[string, string, string]> = [
  ['Logs in', 'If the site needs a login, the app signs in by itself with the username and password from Settings. This is a normal script, not the AI: the AI never sees the password.', 'Free'],
  ['Runs the automatic checks', 'It opens every page and checks for broken links, broken images, JavaScript errors, failing requests, accessibility problems, pages that do not fit a phone screen, and slow loading.', 'Free'],
  ['Looks at each page and writes test cases', 'An AI opens the page in a real browser, looks at everything on it (buttons, forms, menus, dialogs) and writes test cases like a QA engineer would. It follows what you wrote for the page first. Test cases you uploaded or wrote are used exactly as they are.', 'AI'],
  ['Lets you check the test cases', 'Only if you ticked “Let me check the test cases”. You can skip or change any of them before testing starts.', 'Optional'],
  ['Carries out every test case', 'For each test case, an AI opens its own browser, follows the steps (clicking, typing, uploading files) and checks every expected result. It then decides: passed, failed, or could not test. When a test fails, a second, stronger AI tries it again before it is reported as a bug.', 'AI'],
  ['Cleans up', 'Only if the AI was allowed to add and delete data: it deletes the “pw-test-…” records it created.', 'Optional'],
  ['Writes the report', 'For every test: the exact steps that were done, what was expected, what happened, and for failures a bug description with steps to reproduce and a screenshot. It also shows what broke or got fixed since the previous run.', 'Free'],
];

export function HowItWorksPage() {
  return (
    <div className="stack loose" style={{ maxWidth: 820 }}>
      <div className="stack tight">
        <h1>How it works</h1>
        <p className="muted" style={{ margin: 0 }}>
          You tell the app which pages to test and, if you want, what to focus on. AI agents then test the site in a real
          Chrome browser, the way a person would, and write down every step they take.
        </p>
      </div>

      <div className="card card-pad stack">
        <h2>What happens when you click “Run tests”</h2>
        <ol className="flow">
          {STEPS.map(([title, text, cost], i) => (
            <li key={title}>
              <span className="flow-num">{i + 1}</span>
              <div className="stack" style={{ gap: 2 }}>
                <div className="row wrap"><b>{title}</b><span className={`badge ${cost === 'Free' ? 'pass' : cost === 'AI' ? 'accent' : ''}`}>{cost}</span></div>
                <span className="muted">{text}</span>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="card card-pad stack">
        <h2 className="row">{Icon.replay} The second run is (almost) free</h2>
        <p className="muted" style={{ margin: 0 }}>
          While the AI carries out a test, the app records each click and check. When the test passes, that recording is
          saved. Next time, the app simply <b>repeats the recording</b> in the browser, without any AI, which costs nothing
          and is fast. Only when the site has changed and the recording no longer works does the AI take over again,
          and it records the new way.
        </p>
        <p className="muted" style={{ margin: 0 }}>
          The same goes for planning: as long as a page still has the same buttons and fields, and you did not change its
          instructions, the test cases written last time are reused.
        </p>
        <div className="info-box">
          Example from a small demo page: the first run cost $0.04 (planning about $0.035, each test about $0.002).
          The second run cost $0.
        </div>
      </div>

      <div className="card card-pad stack">
        <h2 className="row">{Icon.bolt} Why it costs little</h2>
        <ul className="steps">
          <li>The automatic checks use no AI at all.</li>
          <li>Two AIs share the work: a cheap, fast one clicks through the tests; a stronger one only writes the test cases and double-checks failures.</li>
          <li>The AI only sees what changed on the page after each action, not the whole page every time.</li>
          <li>Each run has a spending limit (under “More options”). When it is reached, no more AI work starts; free repeats and checks still run.</li>
        </ul>
      </div>

      <div className="card card-pad stack">
        <h2 className="row">{Icon.check} Is it safe for our site?</h2>
        <ul className="steps">
          <li>By default the AI <b>only looks around</b>: it fills in forms to see what happens but never saves anything.</li>
          <li>If you allow it to add data, everything it creates is named “pw-test-…” so it is easy to spot, and it only ever edits or deletes those records.</li>
          <li>It never logs out, changes passwords or settings, pays, or sends real emails or messages, and it stays on your site.</li>
          <li>The AI can only use the browser: it has no access to the server, files or anything else.</li>
        </ul>
      </div>

      <div className="card card-pad stack">
        <h2>Words used in the results</h2>
        <div className="stack tight">
          <div><span className="badge pass">Passed</span> <span className="muted">Every expected result was checked and was right.</span></div>
          <div><span className="badge fail">Failed</span> <span className="muted">The site did not do what was expected. Checked twice, so it is most likely a real bug.</span></div>
          <div><span className="badge warn">Could not test</span> <span className="muted">The AI could not carry out the steps (for example a button it needed was missing), or the spending limit was reached.</span></div>
          <div><span className="badge warn">unstable</span> <span className="muted">Failed once, then passed when tried again: worth a look, but not reliably broken.</span></div>
          <div><span className="badge">Repeated for free</span> <span className="muted">Replayed from an earlier run, without AI.</span></div>
        </div>
      </div>
    </div>
  );
}
