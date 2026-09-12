/**
 * Browser integration check — SPEC.md §8 and §12 "Shared execution".
 *
 * Question it answers: what does JupyterLab 4.6.3 actually key the cell prompt
 * on ([*] vs [n]) when the cell is driven by a HEADLESS RTC client, and does a
 * real browser see clear/count=null/running -> outputs/count/idle?
 *
 * Steps:
 *   1  stand on PORT (default 8894) + notebook via POST /api/contents
 *   2  headless YNotebook client (dev/browser/rtc.ts) -> initial sync
 *   3  kernel session for the notebook path (started BEFORE the browser, so
 *      JupyterLab attaches to it instead of opening a kernel-picker dialog)
 *   4  chromium via Playwright -> <base>/lab/tree/<path>
 *   5  headless adds a code cell; the browser must render it
 *   6  the four (execution_state, execution_count) combinations, each read back
 *      from the browser DOM
 *   7  real run A driven headless, publishing execution_count as soon as
 *      execute_input arrives -> shows that the browser then cancels [*]
 *   8  real run B, count written only at the end -> [*] holds for the run
 *   9  browser -> headless: typing in Lab, then Shift+Enter in Lab
 *  10  teardown: browser, RTC client, kernel session, stand
 *
 * Run:  cd dev/browser && pnpm shared-execution
 * Env:  PORT (default 8894), JUPYTER_TOKEN (default devtoken),
 *       JUPYTER_URL (reuse a live server), HEADFUL=1, KEEP_SERVER=1
 *
 * Exit code 0 only if every check passed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import type { CellChange, YCodeCell } from '@jupyter/ydoc';
import {
  assert,
  connect,
  createNotebook,
  executeInKernel,
  findCell,
  log,
  PORT,
  requestDocSession,
  sleep,
  startKernelSession,
  startStand,
  stopStand,
  TOKEN,
  transactAs,
  waitFor,
  waitForNotebook,
  type KernelStack,
  type RtcClient,
  type Stand
} from './rtc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');

const ORIGIN_HEADLESS = 'browser-check-headless';
const CODE = 'import time; time.sleep(3); 42';
const CODE_MARKER = 'time.sleep(3)';
const TYPED_IN_LAB = ' # typed in lab';

// ---------------------------------------------------------------------------
// result table
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): boolean {
  checks.push({ name, ok, detail });
  log(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
  return ok;
}

// ---------------------------------------------------------------------------
// DOM probes
// ---------------------------------------------------------------------------

interface DomCell {
  index: number;
  prompt: string;
  source: string;
  outputs: string;
  hasOutputArea: boolean;
}

/**
 * One pass over the rendered notebook. `.jp-InputPrompt` is the element that
 * carries "[ ]:", "[*]:" or "[7]:" in JupyterLab 4.x.
 */
async function readCells(page: Page): Promise<DomCell[]> {
  return page.evaluate(() => {
    // Lumino hides inactive dock widgets with .lm-mod-hidden; a restored
    // workspace can hold several notebook panels, so scope to the visible one.
    const panel =
      document.querySelector('.jp-NotebookPanel:not(.lm-mod-hidden)') ??
      document.querySelector('.jp-NotebookPanel');
    if (!panel) return [];
    const cells = Array.from(panel.querySelectorAll('.jp-Notebook .jp-Cell'));
    return cells.map((cell, index) => {
      const prompt = cell.querySelector('.jp-InputPrompt');
      const editor = cell.querySelector('.jp-InputArea-editor .cm-content');
      const outputs = cell.querySelector('.jp-OutputArea');
      return {
        index,
        prompt: (prompt?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        source: (editor?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        outputs: (outputs?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        hasOutputArea: Boolean(outputs)
      };
    });
  });
}

async function findDomCell(page: Page, marker: string): Promise<DomCell | undefined> {
  const cells = await readCells(page);
  return cells.find((c) => c.source.includes(marker));
}

/** Poll the DOM until `predicate(cell)` holds. Returns the last seen cell. */
async function pollCell(
  what: string,
  page: Page,
  marker: string,
  timeoutMs: number,
  predicate: (cell: DomCell | undefined) => boolean
): Promise<{ ok: boolean; cell: DomCell | undefined; ms: number }> {
  const started = Date.now();
  let cell: DomCell | undefined;
  for (;;) {
    cell = await findDomCell(page, marker);
    if (predicate(cell)) return { ok: true, cell, ms: Date.now() - started };
    if (Date.now() - started > timeoutMs) {
      log(`  poll timeout: ${what} (last=${JSON.stringify(cell)})`);
      return { ok: false, cell, ms: Date.now() - started };
    }
    await sleep(50);
  }
}

async function dismissDialogs(page: Page): Promise<string | null> {
  const dialog = page.locator('.jp-Dialog');
  if ((await dialog.count()) === 0) return null;
  const text = (await dialog.first().innerText()).replace(/\s+/g, ' ').trim();
  log(`  dismissing JupyterLab dialog: ${text.slice(0, 160)}`);
  const accept = page.locator('.jp-Dialog .jp-mod-accept');
  if ((await accept.count()) > 0) await accept.first().click();
  await sleep(500);
  return text;
}

async function shot(page: Page, name: string): Promise<string> {
  const file = path.join(OUT_DIR, name);
  await page.screenshot({ path: file, fullPage: false });
  log(`  screenshot -> ${file}`);
  return file;
}

// ---------------------------------------------------------------------------
// shared-model writes (SPEC.md §8: one writer, one transaction per generation)
// ---------------------------------------------------------------------------

function beginGeneration(client: RtcClient, cell: YCodeCell): void {
  transactAs(client.notebook, ORIGIN_HEADLESS, () => {
    cell.setOutputs([]);
    cell.execution_count = null;
    cell.executionState = 'running';
  });
}

function setCombo(
  client: RtcClient,
  cell: YCodeCell,
  count: number | null,
  state: 'running' | 'idle'
): void {
  transactAs(client.notebook, ORIGIN_HEADLESS, () => {
    cell.execution_count = count;
    cell.executionState = state;
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface StateEvent {
  at: number;
  kind: 'executionState' | 'executionCount' | 'outputs';
  value: string;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stand = startStand();
  let browser: Browser | undefined;
  let client: RtcClient | undefined;
  let kernel: KernelStack | undefined;

  try {
    // -- 1. notebook + headless client --------------------------------------
    const notebookPath = await createNotebook(stand);
    const docSession = await requestDocSession(stand, 'json', 'notebook', notebookPath);
    client = await connect(stand, 'H', docSession);
    const nb = client.notebook;
    record(
      '1 headless client synced',
      nb.nbformat !== undefined,
      `path=${notebookPath}, fileId=${docSession.fileId}, cells=${nb.cells.length}, nbformat=${nb.nbformat}.${nb.nbformat_minor}`
    );

    // -- 2. kernel session BEFORE the browser -------------------------------
    // Lab's SessionContext reuses a running session whose path matches, so this
    // both avoids the kernel-picker dialog and gives step 8 a shared kernel.
    kernel = await startKernelSession(stand, notebookPath);
    record(
      '2 kernel session for the notebook path',
      Boolean(kernel.session.kernel?.id),
      `session=${kernel.session.id}, kernel=${kernel.session.kernel?.name}/${kernel.session.kernel?.id}`
    );

    // -- 3. browser ----------------------------------------------------------
    browser = await chromium.launch({ headless: process.env['HEADFUL'] !== '1' });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (err) => log(`  [lab pageerror] ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') log(`  [lab console.error] ${msg.text().slice(0, 200)}`);
    });

    const encodedPath = notebookPath.split('/').map(encodeURIComponent).join('/');
    // `reset` throws away a workspace left over by an earlier run, so the dock
    // panel does not restore yesterday's notebook next to today's.
    await page.goto(`${stand.baseUrl}/lab?token=${TOKEN}&reset`, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000
    });
    await page.waitForSelector('#jp-main-dock-panel, .jp-LabShell', { timeout: 120_000 });
    await page.goto(`${stand.baseUrl}/lab/tree/${encodedPath}`, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000
    });
    await page.waitForSelector('.jp-NotebookPanel:not(.lm-mod-hidden) .jp-Notebook', {
      timeout: 120_000
    });
    await page.waitForSelector(
      '.jp-NotebookPanel:not(.lm-mod-hidden) .jp-Notebook .jp-Cell .jp-InputPrompt',
      { timeout: 120_000 }
    );
    await sleep(2000);
    const dialogText = await dismissDialogs(page);
    const initialCells = await readCells(page);
    record(
      '3 JupyterLab opened the notebook',
      initialCells.length >= 1,
      `DOM cells=${initialCells.length}, prompts=${JSON.stringify(initialCells.map((c) => c.prompt))}${dialogText ? `, dialog=${JSON.stringify(dialogText.slice(0, 80))}` : ''}`
    );
    await shot(page, '01-opened.png');

    // -- 4. headless adds a code cell; the browser must render it ------------
    const cellId = transactAs(nb, ORIGIN_HEADLESS, () =>
      nb.addCell({ cell_type: 'code', source: CODE }).getId()
    );
    const cell = findCell(nb, cellId);
    assert(cell, 'the cell we just added is missing locally');

    const appeared = await pollCell('the new cell in the DOM', page, CODE_MARKER, 15_000, (c) =>
      Boolean(c)
    );
    record(
      '4 browser renders the headless-added cell',
      appeared.ok,
      appeared.ok
        ? `index=${appeared.cell?.index}, prompt=${JSON.stringify(appeared.cell?.prompt)}, source=${JSON.stringify(appeared.cell?.source)}, after ${appeared.ms}ms`
        : `cell with ${JSON.stringify(CODE_MARKER)} never appeared`
    );

    // -- 5. the four (execution_state, execution_count) combinations ---------
    const combos: Array<{
      label: string;
      count: number | null;
      state: 'running' | 'idle';
      expect: string | null; // null = "record what happens", no assertion
    }> = [
      { label: 'state=running, count=null', count: null, state: 'running', expect: '[*]:' },
      { label: 'state=idle, count=7', count: 7, state: 'idle', expect: '[7]:' },
      { label: 'state=running, count=7', count: 7, state: 'running', expect: null },
      { label: 'state=idle, count=null', count: null, state: 'idle', expect: null }
    ];
    const comboPrompts: Record<string, string> = {};
    for (const combo of combos) {
      setCombo(client, cell, combo.count, combo.state);
      let result: { ok: boolean; cell: DomCell | undefined; ms: number };
      if (combo.expect !== null) {
        result = await pollCell(
          `prompt ${combo.expect}`,
          page,
          CODE_MARKER,
          2500,
          (c) => c?.prompt === combo.expect
        );
      } else {
        // no expectation: let the DOM settle, then read whatever Lab renders
        await sleep(1200);
        const c = await findDomCell(page, CODE_MARKER);
        result = { ok: true, cell: c, ms: 1200 };
      }
      const prompt = result.cell?.prompt ?? '(no cell)';
      comboPrompts[combo.label] = prompt;
      if (combo.expect !== null) {
        record(
          `5 combo ${combo.label} -> ${JSON.stringify(combo.expect)}`,
          result.ok,
          `rendered ${JSON.stringify(prompt)} after ${result.ms}ms`
        );
      } else {
        record(`5 combo ${combo.label} (observation)`, true, `rendered ${JSON.stringify(prompt)}`);
      }
      if (combo.label === 'state=running, count=null') await shot(page, '02-star-synthetic.png');
    }
    log(`combo table: ${JSON.stringify(comboPrompts, null, 2)}`);

    // -- 6. real run A: execution_count written from execute_input ---------
    // JupyterLab's CodeCell.onStateChanged does
    //   case 'executionCount': newValue !== null && (this.model.executionState = 'idle')
    // and CodeCellModel's setter writes straight back into the shared model.
    // So a headless client that publishes the count while the cell is still
    // running makes the browser cancel its own [*].
    setCombo(client, cell, null, 'idle'); // clean prompt
    await sleep(400);

    const remoteStates: StateEvent[] = [];
    const tA = Date.now();
    const watchStates = (_s: unknown, change: CellChange): void => {
      if (change.executionStateChange) {
        remoteStates.push({
          at: Date.now() - tA,
          kind: 'executionState',
          value: String(change.executionStateChange.newValue)
        });
      }
    };
    cell.changed.connect(watchStates);

    beginGeneration(client, cell);
    const runA = executeInKernel(kernel.session, cell.getSource(), {
      onExecuteInput: (count) => {
        transactAs(nb, ORIGIN_HEADLESS, () => {
          cell.execution_count = count;
        });
      }
    });
    const starA = await pollCell(
      'prompt [*] right after clear+running',
      page,
      CODE_MARKER,
      2500,
      (c) => c?.prompt === '[*]:'
    );
    record(
      '6a browser shows [*] as soon as clear+count=null+running lands',
      starA.ok,
      `prompt=${JSON.stringify(starA.cell?.prompt)} after ${starA.ms}ms`
    );
    await shot(page, '03-star-real-run.png');

    // sample the prompt across the remaining sleep window
    const samplesA: string[] = [];
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      samplesA.push((await findDomCell(page, CODE_MARKER))?.prompt ?? '(gone)');
    }
    const resultA = await runA;
    const labForcedIdle = remoteStates.some((e) => e.value === 'idle');
    cell.changed.disconnect(watchStates);
    record(
      '6b writing execution_count while running makes Lab drop [*] (documented, not desired)',
      labForcedIdle && samplesA.every((p) => p !== '[*]:'),
      `prompt samples during the run=${JSON.stringify(samplesA)}, shared execution_state after our single 'running' write=${JSON.stringify(remoteStates)}, cell.executionState=${cell.executionState}, browser-forced idle=${labForcedIdle}`
    );
    transactAs(nb, ORIGIN_HEADLESS, () => {
      cell.setOutputs(resultA.outputs as never);
      cell.execution_count = resultA.executionCount;
      cell.executionState = 'idle';
    });
    const doneA = await pollCell(
      `prompt [${resultA.executionCount}] and the output`,
      page,
      CODE_MARKER,
      10_000,
      (c) => c?.prompt === `[${resultA.executionCount}]:` && c.outputs.includes('42')
    );
    record(
      '6c browser shows [n] and renders the output',
      doneA.ok,
      `reply=${resultA.replyStatus}, count=${resultA.executionCount}, prompt=${JSON.stringify(doneA.cell?.prompt)}, .jp-OutputArea=${JSON.stringify(doneA.cell?.outputs)}, after ${doneA.ms}ms`
    );

    // -- 7. real run B: count only at the end (what JupyterLab itself does) --
    beginGeneration(client, cell);
    const runB = executeInKernel(kernel.session, cell.getSource());
    const starB = await pollCell(
      'prompt [*] for run B',
      page,
      CODE_MARKER,
      2500,
      (c) => c?.prompt === '[*]:'
    );
    const samplesB: string[] = [];
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      samplesB.push((await findDomCell(page, CODE_MARKER))?.prompt ?? '(gone)');
    }
    const heldStar = starB.ok && samplesB.every((p) => p === '[*]:');
    record(
      '7a [*] holds for the whole run when the count is written only at the end',
      heldStar,
      `first [*] after ${starB.ms}ms, samples every 200ms=${JSON.stringify(samplesB)}`
    );
    await shot(page, '04-star-held.png');
    const resultB = await runB;
    transactAs(nb, ORIGIN_HEADLESS, () => {
      cell.setOutputs(resultB.outputs as never);
      cell.execution_count = resultB.executionCount;
      cell.executionState = 'idle';
    });
    const doneB = await pollCell(
      `prompt [${resultB.executionCount}] for run B`,
      page,
      CODE_MARKER,
      10_000,
      (c) => c?.prompt === `[${resultB.executionCount}]:` && c.outputs.includes('42')
    );
    record(
      '7b run B ends with [n] and the rendered output',
      doneB.ok,
      `count=${resultB.executionCount}, prompt=${JSON.stringify(doneB.cell?.prompt)}, .jp-OutputArea=${JSON.stringify(doneB.cell?.outputs)}, after ${doneB.ms}ms`
    );
    await shot(page, '05-done.png');

    // -- 8. browser -> headless: typing --------------------------------------
    const domCell = await findDomCell(page, CODE_MARKER);
    assert(domCell, 'the driven cell disappeared from the DOM');
    const editor = page
      .locator('.jp-NotebookPanel:not(.lm-mod-hidden) .jp-Notebook .jp-Cell')
      .nth(domCell.index)
      .locator('.cm-content');
    await editor.click();
    await page.keyboard.press('End');
    const sourceBefore = cell.getSource();
    const typedAt = Date.now();
    const sawTyping = waitForNotebook('headless sees the typed text', nb, 4000, () =>
      cell.getSource().includes('typed in lab')
    );
    await page.keyboard.type(TYPED_IN_LAB, { delay: 25 });
    let typingOk = true;
    let typingError = '';
    try {
      await sawTyping;
    } catch (err) {
      typingOk = false;
      typingError = String(err);
    }
    record(
      '8 headless observes text typed in the browser',
      typingOk,
      typingOk
        ? `source=${JSON.stringify(cell.getSource())} ${Date.now() - typedAt}ms after the first keystroke (was ${JSON.stringify(sourceBefore)})`
        : typingError
    );

    // -- 9. browser -> headless: Shift+Enter ---------------------------------
    const events: StateEvent[] = [];
    const t0 = Date.now();
    const onChange = (_sender: unknown, change: CellChange): void => {
      if (change.executionStateChange) {
        events.push({
          at: Date.now() - t0,
          kind: 'executionState',
          value: String(change.executionStateChange.newValue)
        });
      }
      if (change.executionCountChange) {
        events.push({
          at: Date.now() - t0,
          kind: 'executionCount',
          value: String(change.executionCountChange.newValue)
        });
      }
      if (change.outputsChange) {
        events.push({
          at: Date.now() - t0,
          kind: 'outputs',
          value: `len=${cell.getOutputs().length}`
        });
      }
    };
    cell.changed.connect(onChange);
    try {
      const sawLabOutputs = waitFor<void>('headless sees Lab-written outputs', 30_000, (resolve) => {
        const handler = (): void => {
          if (cell.getOutputs().length > 0 && events.some((e) => e.kind === 'executionCount')) {
            resolve();
          }
        };
        cell.changed.connect(handler);
        return () => cell.changed.disconnect(handler);
      });
      await page.keyboard.press('Shift+Enter');
      let labRunOk = true;
      let labRunError = '';
      try {
        await sawLabOutputs;
      } catch (err) {
        labRunOk = false;
        labRunError = String(err);
      }
      await sleep(1500); // let a trailing idle land
      const states = events.filter((e) => e.kind === 'executionState');
      const sawRunning = states.some((e) => e.value === 'running');
      const sawIdle = states.some((e) => e.value === 'idle');
      record(
        '9a headless observes outputs written by Lab',
        labRunOk && cell.getOutputs().length > 0,
        labRunOk
          ? `outputs=${JSON.stringify(cell.getOutputs())}, execution_count=${cell.execution_count}`
          : labRunError
      );
      record(
        '9b Lab writes execution_state running -> idle into the shared model',
        sawRunning && sawIdle,
        `executionState events=${JSON.stringify(states)}; full timeline=${JSON.stringify(events)}`
      );
    } finally {
      cell.changed.disconnect(onChange);
    }

    await shot(page, '06-final.png');
  } finally {
    if (browser) {
      await browser.close().catch((err: unknown) => log(`browser close: ${String(err)}`));
    }
    if (client) client.destroy();
    if (kernel) await kernel.dispose();
    stopStand(stand);
  }
}

// ---------------------------------------------------------------------------

let exitCode = 0;
try {
  await main();
} catch (err) {
  const e = err as Error;
  record('unexpected error', false, `${e.name}: ${e.message}`);
  log(e.stack ?? '');
  exitCode = 1;
}

const width = Math.max(...checks.map((c) => c.name.length));
process.stdout.write(`\nPORT=${PORT}\n\n`);
for (const c of checks) {
  process.stdout.write(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(width)}  ${c.detail}\n`);
}
const failed = checks.filter((c) => !c.ok).length;
process.stdout.write(`\n${checks.length - failed}/${checks.length} passed\n`);
if (failed > 0) exitCode = 1;

process.exitCode = exitCode;
setTimeout(() => process.exit(exitCode), 5000).unref();
