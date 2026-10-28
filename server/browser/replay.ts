// Replays a test recorded during an earlier AI run, with plain Playwright: no AI, no cost.
// If the site changed and a step no longer works, the caller falls back to an AI agent.
import type { PerformedStep, RecordedStep } from '../types.js';
import { BrowserSession, describeVerify, gotoPage, runVerify, type SessionConfig } from './session.js';
import { FIXTURES_DIR } from './fixtures.js';
import { join } from 'node:path';

export interface ReplayOutcome {
  ok: boolean;
  performed: PerformedStep[];
  /** The step that failed, in words, and why. */
  error?: string;
  /** True when a check failed (the site behaves differently), false when an element could not be found or used. */
  checkFailed?: boolean;
  screenshot?: string;
  consoleErrors: string[];
}

export async function replay(recording: RecordedStep[], config: SessionConfig): Promise<ReplayOutcome> {
  const session = new BrowserSession(config);
  const performed: PerformedStep[] = [];
  const uid = Math.random().toString(36).slice(2, 8);
  try {
    await session.start();
    const page = session.page;
    for (const step of recording) {
      const text = describeStep(step);
      try {
        const locator = step.selector ? page.locator(step.selector) : undefined;
        const need = () => {
          if (!locator) throw new Error('no locator recorded');
          return locator;
        };
        switch (step.action) {
          case 'goto': await gotoPage(page, step.url!); break;
          case 'click': await need().click(); break;
          case 'dblclick': await need().dblclick(); break;
          case 'fill': await need().fill((step.value ?? '').replaceAll('{{uid}}', uid)); break;
          case 'select': await need().selectOption(step.values ?? []); break;
          case 'check': await need().setChecked(true); break;
          case 'uncheck': await need().setChecked(false); break;
          case 'press': await page.keyboard.press(step.key!); break;
          case 'hover': await need().hover(); break;
          case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }); break;
          case 'upload': {
            const file = join(FIXTURES_DIR, step.file!);
            const isInput = await need().evaluate((el) => el instanceof HTMLInputElement && el.type === 'file').catch(() => false);
            if (isInput) await need().setInputFiles(file);
            else {
              const chooser = page.waitForEvent('filechooser');
              await need().click();
              await (await chooser).setFiles(file);
            }
            break;
          }
          case 'wait':
            if (step.ms) await page.waitForTimeout(step.ms);
            else if (step.value?.startsWith('!')) await page.getByText(step.value.slice(1)).first().waitFor({ state: 'hidden', timeout: 15_000 });
            else if (step.value) await page.getByText(step.value).first().waitFor({ state: 'visible', timeout: 15_000 });
            break;
          case 'verify':
            try {
              await runVerify(page, step.verify!.kind, locator, step.verify!.expected ?? '');
            } catch (e) {
              performed.push({ text, ok: false, error: message(e) });
              return { ok: false, performed, error: `${text}: ${message(e)}`, checkFailed: true, screenshot: await session.screenshot('replay-failure').catch(() => undefined), consoleErrors: session.consoleErrors };
            }
            break;
        }
        performed.push({ text, ok: true });
        await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), page.waitForTimeout(800)]);
      } catch (e) {
        performed.push({ text, ok: false, error: message(e) });
        return { ok: false, performed, error: `${text}: ${message(e)}`, checkFailed: false, screenshot: await session.screenshot('replay-failure').catch(() => undefined), consoleErrors: session.consoleErrors };
      }
    }
    return { ok: true, performed, consoleErrors: session.consoleErrors };
  } catch (e) {
    return { ok: false, performed, error: message(e), checkFailed: false, consoleErrors: session.consoleErrors };
  } finally {
    await session.close();
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0] : String(e)).slice(0, 300);

/** The same wording the agent's tools use, so replayed and AI-run reports read alike. */
export function describeStep(s: RecordedStep): string {
  const el = s.element ?? s.code ?? 'element';
  switch (s.action) {
    case 'goto': return `Open ${s.url}`;
    case 'click': return `Click "${el}"`;
    case 'dblclick': return `Double-click "${el}"`;
    case 'fill': return `Enter "${s.value}" in "${el}"`;
    case 'select': return `Select "${(s.values ?? []).join('", "')}" in "${el}"`;
    case 'check': return `Tick "${el}"`;
    case 'uncheck': return `Untick "${el}"`;
    case 'press': return `Press ${s.key}`;
    case 'hover': return `Hover over "${el}"`;
    case 'upload': return `Upload ${s.file} with "${el}"`;
    case 'back': return 'Go back';
    case 'wait': return s.ms ? `Wait ${s.ms / 1000} seconds` : s.value?.startsWith('!') ? `Wait for "${s.value.slice(1)}" to disappear` : `Wait for "${s.value}" to appear`;
    case 'verify': return `Verify ${describeVerify(s.verify!.kind, s.element ?? '', s.verify!.expected ?? '')}`;
  }
}
