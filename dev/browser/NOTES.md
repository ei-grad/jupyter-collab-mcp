# Browser integration check — cell prompts in JupyterLab 4.6.3

This checks SPEC.md §8 (“Execution and output”) and §12 “Shared execution”:
exactly what JupyterLab 4.6.3 renders in a cell prompt (`[ ]`, `[*]`,
`[n]`) when a **headless** RTC client controls the cell, and what the
headless client observes when the browser acts.

Script: [`shared-execution.ts`](./shared-execution.ts); RTC helpers:
[`rtc.ts`](./rtc.ts), a deliberate copy of the required parts of
`spike/rtc-spike.ts`. The spike remains frozen and is not imported here.

```sh
cd dev/browser
pnpm install
pnpm exec playwright install chromium   # once
PORT=8894 pnpm shared-execution         # exit 0 only after a complete PASS
```

Variables: `PORT` (default 8894), `JUPYTER_TOKEN` (`devtoken`),
`JUPYTER_URL` (reuse a live server), `HEADFUL=1` (visible Chromium),
`KEEP_SERVER=1`.

Run against the `dev/jupyter` environment (JupyterLab 4.6.3, jupyter-server
2.21.0, jupyter-collaboration 5.0.2 / jupyter_server_ydoc 3.0.2,
jupyter-ydoc 4.1.1, @jupyter/ydoc 4.1.1, y-websocket 3.1.0, Node 24.14.0,
Playwright 1.63.0, Chromium 153.0.8010.12, macOS arm64):
**16/16 PASS, exit 0**. Screenshots are in `out/` (gitignored).

## 1. What Lab reads when rendering a prompt

Both fields are shared (part of the shared model), and both are read from
`YCodeCell`: `ymodel.get('execution_state')` and
`ymodel.get('execution_count')`
(`node_modules/@jupyter/ydoc/lib/ycell.js:622-655`).

Widget code (minified `jupyterlab/static/jlab_core.*.js`, class `CodeCell`,
corresponding to `packages/cells/src/widget.ts`):

```js
_updatePrompt(){
  let e;
  e = "running" == this.model.executionState ? "*" : `${this.model.executionCount||""}`;
  this._setPrompt(e)
}
onStateChanged(e,t){switch(t.name){
  case "executionCount": null!==t.newValue && (this.model.executionState="idle"), this._updatePrompt(); break;
  case "executionState": this._updatePrompt(); break;
  case "isDirty": ...
}}
```

`CodeCellModel` is a thin wrapper around the shared model:
`get executionState(){return this.sharedModel.executionState}` and
`set executionState(e){this.sharedModel.executionState=e}`.

Conclusion: **the prompt is computed from both fields, but
`execution_state` takes precedence**. `execution_state === 'running'` →
`*`; otherwise `execution_count` is displayed, with `null`/`0`
producing an empty string (`[ ]`). Measured table of all four combinations
(written by the headless client, read by the browser):

| `execution_state` | `execution_count` | `.jp-InputPrompt` |
| --- | --- | --- |
| `running` | `null` | `[*]:` |
| `idle` | `7` | `[7]:` |
| `running` | `7` | `[*]:` |
| `idle` | `null` | `[ ]:` |

Therefore the SPEC §8 requirement to “clear outputs, set
`execution_count = null`, and set `execution_state = 'running'` in one
transaction before sending” is necessary and sufficient for `[*]` in an
observing browser. `execution_count = null` alone does not produce `[*]`;
`execution_state` without it does.

## 2. Main surprise: the browser clears `[*]` itself if the count arrives early

The branch
`case "executionCount": null !== newValue && (this.model.executionState = "idle")`
also runs for a **remote** change: any nonempty `execution_count` received
over RTC makes the browser widget write `execution_state = 'idle'`
**back into the shared document**. This is not a local effect confined to one
browser; every participant, including the headless client, receives the value.

This was verified by script step 6b. The headless client writes
`execution_count` immediately after `execute_input` (following “count comes
from matching kernel messages”), while the state remains `running`:

```
our only execution_state write:             'running'  (t = 0 ms)
received back from the browser:             'idle'     (t = 9…17 ms)
browser prompt during sleep(3):             [1] [1] [1] … (10 samples at 200 ms)
```

Step 7a runs the same program, but writes `execution_count` **only in the
final transaction** together with `idle`:

```
browser prompt during sleep(3): [*] [*] [*] [*] [*] [*] [*] [*] [*] [*]
after completion:               [2]: and '42' in .jp-OutputArea
```

**Implementation conclusion (§8):** write only `outputs` to the shared model
during execution. Write `execution_count` in one transaction with
`execution_state = 'idle'` at the end. Lab itself does the same:
`i.done.then(e => { a.model.executionCount = e.content.execution_count;
a.model.executionState = "idle" })`. The value from `execute_input` can and
should be stored on the job, but must not be published to the document before
completion.

A side effect is that while at least one browser is in the room,
`execution_state` is not “our” field: the browser may overwrite it. The
output-area generation logic (§8 “Races”) must not treat incoming `idle` as
proof that our execution has completed.

## 3. What Lab writes when it performs execution

Shift+Enter in the browser (using the same kernel session started by the
headless client), observed through `cell.changed` on the headless client;
times are measured from the key press:

```
+9 ms     execution_count -> null     (Lab: clearExecution in transact(..., false, 'silent-change'))
+9 ms     outputs         -> len=0
+9 ms     execution_state -> 'running'
+3040 ms  outputs         -> len=1     {"output_type":"execute_result","data":{"text/plain":"42"},...}
+3042 ms  execution_state -> 'idle'
+3043 ms  execution_count -> 3
```

Lab therefore **does write `execution_state`** to the shared document, in
exactly the sequence SPEC §8 requires from us: clear + count=null + running
before sending, then count + idle after `execute_reply`. The client (browser),
not the server, writes outputs; `serverSideExecution` is disabled in the
test environment.

One more detail from the bundle: Lab clears with
`sharedModel.transact(() => { clearExecution(); outputHidden = false }, /*undoable*/ false, 'silent-change')`,
but sets `executionState = 'running'` **outside** that transaction. Thus an
observer sees the generation boundary in two transactions rather than one,
and origin `'silent-change'` belongs to the browser; it cannot distinguish
our edits from foreign ones.

## 4. Working DOM selectors

| Item | Selector |
| --- | --- |
| Shell loaded | `#jp-main-dock-panel, .jp-LabShell` |
| Visible notebook panel | `.jp-NotebookPanel:not(.lm-mod-hidden)` |
| Cell | `<panel> .jp-Notebook .jp-Cell` |
| Input prompt | `<cell> .jp-InputPrompt` → `textContent` = `"[ ]:"` / `"[*]:"` / `"[7]:"` |
| Cell text | `<cell> .jp-InputArea-editor .cm-content` (CodeMirror 6) |
| Output | `<cell> .jp-OutputArea` (its `textContent` also includes the output prompt: `"[1]:42"`) |
| Modal dialog | `.jp-Dialog`; confirmation button `.jp-Dialog .jp-mod-accept` |

**`.lm-mod-hidden` is mandatory.** Without it, the first repeated run fails:
JupyterLab restores the workspace, the dock panel contains multiple
`.jp-NotebookPanel` elements, and
`document.querySelectorAll('.jp-Notebook .jp-Cell')` returns cells from a
different (previous day's) notebook. Adding `?reset` to the URL **did not
remove** the tabs in the observed run (the screenshots show four tabs).
Restricting selection to the visible panel is what provides determinism.

The DOM has no cell identifier: neither `cell_id` nor a `data-*` containing
it. The cell is found by a source substring (`time.sleep(3)`), and its index
in the `.jp-Cell` list is then taken from the matched element.

## 5. Timings (headless Chromium, local server)

| Event | Observed |
| --- | --- |
| Write to headless Y.Doc → updated browser prompt | 2–57 ms (poll resolution is 50 ms; often the first immediate poll already sees the new value) |
| Write `execution_count` → browser returns `idle` | 9–17 ms |
| Text entry in Lab → `cell.getSource()` on headless | 414 ms after the first key press with `delay: 25` ms for 15 characters (about 40 ms after the last) |
| Shift+Enter in Lab → `running` on headless | 9 ms |
| Headless-added cell appears in the DOM | 55 ms |
| Entire browser phase of the script (first screenshot to last) | ~14 s |
| First JupyterLab load with a clean profile | within the 120 s budget; actually a few seconds |

## 6. Other pitfalls

1. **The kernel session must start before the browser opens.** Otherwise Lab
   displays the kernel-selection modal for a fresh `newUntitled` notebook and
   the test hangs. During initialization, `SessionContext` looks for an
   already running session with the same `path` and connects to it. The order
   “headless starts the kernel → browser opens the notebook” therefore both
   avoids the dialog and provides §12 “Shared kernel”: Shift+Enter in the
   browser reaches the same kernel. The script still calls `dismissDialogs()`
   as a precaution.
2. **`@jupyterlab/services` prints `Starting WebSocket: <url>` to stdout**
   through `console.debug`. stdout is the report channel in this script, so
   the line enters the PASS/FAIL table. For MCP, interception of `console.*`
   is already a requirement (spike/NOTES.md, pitfall 4).
3. **`.jp-OutputArea` also contains the output prompt.** Check
   `includes('42')`, not equality.
4. **The “Would you like to get notified about official Jupyter news?”
   notification** appears even with `LabApp.news_url=None` in the
   environment. It is not modal and does not intercept clicks, but it appears
   in screenshots.
5. **The environment directory is not cleared between runs**, so
   `Untitled*.ipynb` files accumulate. The script always uses a newly created
   file, so this does not affect the result; clean it by removing
   `dev/jupyter/.runtime/`.
6. **`?reset` in the Lab URL does not guarantee an empty workspace** (see §4).
7. The `Invalid access: Add Yjs type to a document before reading data.`
   stderr noise during `addCell` matches the spike and is harmless.

## 7. Outside the scope of this check

- Late output from an old generation with a live browser (§12 “Shared
  execution”, second half of the row); this check covers only clear/running
  and count/idle.
- `clear_output(wait)`, `update_display_data`, large PNGs, and a long `stream`.
- Reordering/deleting a cell in the browser during execution.
- Behavior with `serverSideExecution` enabled (the server then writes outputs).
