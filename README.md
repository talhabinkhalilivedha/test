# AI QA Engineer

AI agents test a website in a real browser (Playwright), page by page, following what the QA asks for, and
report every step they performed. Projects and run history are saved, so anyone can look back at what was tested and how.

The app also explains this in plain language for QA users: **How it works** in the top bar.

## Run it

```bash
npm install
npx playwright install chromium
cp .env.example .env        # optional: API keys, port
npm run build && npm start  # http://localhost:4400
```

Development, with live reload: `npm run dev` (UI on http://localhost:5173, API on 4400).

There are no accounts or sign-in: everyone who can open the app can use it. The server only listens on
this computer (127.0.0.1). To let teammates reach it, start it with `HOST=0.0.0.0 npm start`, and only do that
on a trusted network, since there is no login protecting it.

### AI providers

| Provider | Needs | Billing |
|---|---|---|
| Claude (subscription) | the `claude` CLI installed and logged in on the server | your Claude plan's usage limits |
| Claude API | `ANTHROPIC_API_KEY` in `.env` | per token |
| OpenAI | `OPENAI_API_KEY` in `.env` | per token |

Without an Anthropic key, Claude runs fall back to the CLI. The subscription mode is meant for development:
switch to API keys before the whole team uses the app, so team work does not run on one person's
personal plan.

## How a run works

1. **Login** (optional): Playwright logs in with the project's saved username and password. No AI is involved, so
   the AI never sees the password. The login can be a page or a modal: a cookie banner is accepted first, and a
   modal is opened with its "Log in" / "Sign in" button, an account button or icon, or the menu that one opens. Passwords are stored encrypted (AES-256-GCM, key in `data/secret.key`).
2. **Automatic checks**, with no AI: console errors, failed requests, broken links and images, accessibility (axe-core),
   mobile layout and load time, on every page. With **Find more pages** on, same-site links are added as pages.
3. **Plan**: for each page, the planning model explores it and writes QA test cases, following the page's
   instructions and the focus areas picked under "Pay extra attention to". A page with nothing filled in gets general testing of all its features.
   Uploaded and manually written test cases always run as they are.
4. **Review** (optional): the run pauses, and a QA unticks or edits test cases before they run.
5. **Execute**: the step model carries out each test case in its own browser, checks every expected result
   with an explicit verify step, and gives a verdict: passed, failed (with a bug write-up and screenshot) or blocked.
6. **Cleanup**: when the AI may add, edit and delete data, it deletes the `pw-test-` records it created.
7. **Report**: steps performed, expected vs actual, bugs, a comparison with the previous run, and CSV/Excel export.

## How cost is kept down

| What | Effect |
|---|---|
| Automatic checks are plain Playwright | $0 |
| A page's plan is cached and reused while the page's controls and settings stay the same | no re-planning cost |
| A test that passed is **recorded** (stable Playwright locators) and later **replayed without AI** | $0 per re-run; AI only steps in when a replay breaks, and its new recording replaces the old one |
| Two models: a cheap **step model** clicks through tests, the **planning model** only plans, takes over when the step model is stuck, and re-checks failures | most tokens go to the cheap model |
| Our own lean browser tools: snapshots return only what changed, no screenshots unless needed, Claude Code's system prompt and built-in tools are replaced | fewer tokens per step |
| Prompt caching (Claude API) / server-side conversation (OpenAI), low effort for steps | cheaper repeated context |
| Cost cap per run | AI work stops at the budget; replays and checks continue |

Measured on a small demo page: planning about $0.035, about $0.001–0.002 per AI-executed test with Haiku, and a
re-run with nothing changed cost **$0**.

## Test case files

Upload a `.csv` or `.xlsx` per page (sample files in the app: Pages → a page → "Sample file"). Columns:
`Test ID, Title, Category, Priority, Preconditions, Steps, Expected Result, Test Data`. Common alternative
headers (`TC ID`, `Test Scenario`, `Test Steps`, `Expected Results`, …) are recognised. Write `{{uid}}` where a
value must be unique on every run.

## Project layout

```
server/
  index.ts              HTTP API (Fastify), SSE, serves the built UI
  db.ts                 SQLite (node:sqlite): projects, pages, test cases, runs, results
  types.ts              types shared with the UI
  runs/pipeline.ts      one run: login → checks → plan → review → execute → cleanup → report
  runs/queue.ts         runs MAX_PARALLEL_RUNS at a time; stop / approve
  ai/agent.ts           provider-neutral agent runner
  ai/claude-cli.ts      Claude via the `claude` CLI (subscription)
  ai/claude-api.ts      Claude via the API (prompt caching)
  ai/openai.ts          OpenAI Responses API
  ai/prompts.ts         system prompts and safety rules
  browser/session.ts    the browser tools: act, verify, record steps and replayable locators
  browser/mcp-server.ts MCP server exposing the tools to every provider
  browser/replay.ts     replays recordings without AI
  browser/checks.ts     automatic checks, page fingerprint, page discovery
  browser/login.ts      automatic username/password login
web/src/                React UI
data/                   database, run artifacts (screenshots, logs, agent transcripts) — gitignored
```

## Safety

Agents only get the browser tools: no shell, no files. Every agent is told to stay on the site, never log out,
pay or send real messages, and to respect the run's data mode: **Only look** (nothing is saved), **Create data**
(`pw-test-` records only) or **Create, edit, delete** (only `pw-test-` records). Confirm dialogs are dismissed
unless the run may delete data. Navigation to other sites is refused or undone.
