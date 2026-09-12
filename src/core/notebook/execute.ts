/**
 * Execution half of `notebook_apply` (SPEC.md §7).
 *
 * Everything here runs inside **one** `ydoc.transact(fn, origin)` opened by
 * {@link NotebookModel.apply}; there is no `await` anywhere in this file. The
 * addressing was already resolved by `plan.ts`, so an instruction is a direct
 * write against the shared model.
 *
 * Two Yjs facts shape the code:
 *
 * 1. `YNotebook.cells` is refreshed by a *shallow* observer that only runs when
 *    the outermost transaction ends, so mid-batch it is stale. Cells are
 *    therefore addressed by `Y.Map` identity ({@link resolveCell}) and inserts
 *    are indexed against the live `Y.Array`, which the simulation mirrors.
 * 2. `@jupyter/ydoc` drops custom origins in its own `transact` wrappers
 *    (spike/NOTES.md §3.2). Nested transactions inherit the outer origin, which
 *    is why every write below is safe to make through the library API.
 * 3. Metadata is the one place where the library API is *not* safe. Both
 *    `YNotebook.deleteMetadata` and `YBaseCell.deleteMetadata` touch keys the
 *    caller never named - see {@link writeMetadataKey} - so the two metadata
 *    instructions write straight into the metadata `Y.Map` instead.
 *
 * @module
 */

import type { YCellType, YNotebook } from '@jupyter/ydoc';
import type * as Y from 'yjs';

import { coreError } from '../errors.js';
import { isCodeCell, resolveCell } from './read.js';
import type { PlannedOp, SimCell } from './plan.js';

/** Cells created earlier in the same batch, by simulated cell. */
export type CreatedCells = Map<SimCell, YCellType>;

function cellOf(notebook: YNotebook, target: SimCell, created: CreatedCells): YCellType {
  if (target.entry !== null) return resolveCell(notebook, target.entry);
  const fresh = created.get(target);
  if (fresh !== undefined) return fresh;
  throw coreError('INTERNAL_ERROR', 'a cell planned for this batch is missing', {
    details: { cell_id: target.id }
  });
}

/**
 * Apply one planned instruction.
 *
 * Throws only on an unexpected failure: every expected error was raised during
 * planning, before the first mutation (SPEC.md §7). A throw here means the
 * batch is partially applied and the answer must say so.
 */
export function executeOne(notebook: YNotebook, planned: PlannedOp, created: CreatedCells): void {
  switch (planned.kind) {
    case 'noop':
      return;
    case 'insert': {
      const json = planned.cell.json;
      const inserted = notebook.insertCell(planned.at, {
        id: planned.cell.id,
        cell_type: json['cell_type'],
        source: json['source'],
        metadata: json['metadata']
      } as Parameters<YNotebook['insertCell']>[1]);
      created.set(planned.cell, inserted as unknown as YCellType);
      return;
    }
    case 'text': {
      const cell = cellOf(notebook, planned.target, created);
      const { index, deleteCount, insert } = planned.edit;
      const ysource = cell.ysource;
      // Insert first, then delete: this is what `YBaseCell.updateSource` does,
      // and it keeps a remote cursor sitting after the edited range in place.
      if (insert.length > 0) ysource.insert(index, insert);
      if (deleteCount > 0) ysource.delete(index + insert.length, deleteCount);
      return;
    }
    case 'delete': {
      notebook.deleteCell(planned.at);
      return;
    }
    case 'clear': {
      const cell = cellOf(notebook, planned.target, created);
      if (!isCodeCell(cell)) {
        throw coreError('INTERNAL_ERROR', 'clear_outputs reached a cell with no output area', {
          details: { cell_id: planned.target.id }
        });
      }
      cell.clearOutputs();
      return;
    }
    case 'cell_meta': {
      const cell = cellOf(notebook, planned.target, created);
      writeMetadataKey(
        metadataMapOf(cell.ymodel, 'cell'),
        planned.topKey,
        planned.removeTop,
        planned.value
      );
      return;
    }
    case 'nb_meta': {
      writeMetadataKey(
        metadataMapOf(notebook.ymeta as Y.Map<unknown>, 'notebook'),
        planned.topKey,
        planned.removeTop,
        planned.value
      );
      return;
    }
    default: {
      const unreachable = planned as { kind: string };
      throw coreError('INTERNAL_ERROR', `unknown planned instruction ${unreachable.kind}`);
    }
  }
}

/**
 * The `metadata` child of a cell `Y.Map` or of `ymeta`.
 *
 * @throws CoreError `INTERNAL_ERROR` when it is missing, which `@jupyter/ydoc`
 * describes as a transient state during destruction: there is nothing to write
 * to, and silently dropping the operation would be worse than saying so.
 */
function metadataMapOf(owner: Y.Map<unknown>, what: 'cell' | 'notebook'): Y.Map<unknown> {
  const ymetadata = owner.get('metadata');
  if (ymetadata === undefined || ymetadata === null) {
    throw coreError('INTERNAL_ERROR', `the ${what} has no shared metadata map`);
  }
  return ymetadata as Y.Map<unknown>;
}

/**
 * Write or delete **one** metadata key, and nothing else (SPEC.md §7:
 * "Untouched keys are preserved").
 *
 * The library helpers cannot be used here:
 *
 * - `YNotebook.deleteMetadata(key)` reads the whole metadata object, deletes
 *   the key from the copy and calls the object form of `setMetadata`, which
 *   does `ymetadata.clear()` and then re-`set`s every surviving key
 *   (node_modules/@jupyter/ydoc/lib/ynotebook.js:373-380, 411-425). Every
 *   untouched key becomes a concurrent `Y.Map` write, and Yjs resolves the
 *   collision with a concurrent browser edit by client id - so deleting an
 *   unrelated key could revert the browser's edit. Verified in
 *   test/core/notebook/review.concurrency.test.ts.
 * - `YBaseCell.deleteMetadata('jupyter')` also deletes `collapsed`, and
 *   `setMetadata('collapsed', v)` also writes `jupyter.outputs_hidden`
 *   (node_modules/@jupyter/ydoc/lib/ycell.js:388-411, 429-464). That mirroring
 *   is JupyterLab's own convenience; SPEC.md §7 asks for the named key only.
 *
 * A per-key write is also exactly what the batch simulation predicted, so the
 * revision a later operation of the same batch quotes stays correct.
 */
function writeMetadataKey(
  ymetadata: Y.Map<unknown>,
  key: string,
  remove: boolean,
  value: unknown
): void {
  if (remove) {
    if (ymetadata.has(key)) ymetadata.delete(key);
    return;
  }
  ymetadata.set(key, value);
}
