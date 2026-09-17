import { YNotebook } from '@jupyter/ydoc';
import { describe, expect, it } from 'vitest';

import { NotebookModel } from '../../../src/core/notebook/index.js';
import { Wire, reviewBook, reviewCode, reviewPeer, typeInto } from './review.helpers.js';

function emptyNotebook(extra: Record<string, unknown> = {}): YNotebook {
  const notebook = new YNotebook();
  notebook.setSource({
    cells: [reviewCode('placeholder', '', extra)],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5
  } as never);
  return notebook;
}

describe('new-notebook placeholder', () => {
  it('removes the sole entirely default code cell', () => {
    const notebook = emptyNotebook();
    const model = new NotebookModel(notebook, { origin: {} });

    expect(model.removePristineServerPlaceholder()).toBe(true);
    expect(model.summary().cellCount).toBe(0);

    model.dispose();
    notebook.dispose();
  });

  it('accepts the trusted marker added by the server to its default cell', () => {
    const notebook = emptyNotebook({ metadata: { trusted: true }, execution_state: 'idle' });
    const model = new NotebookModel(notebook, { origin: {} });

    expect(model.removePristineServerPlaceholder()).toBe(true);
    expect(model.summary().cellCount).toBe(0);

    model.dispose();
    notebook.dispose();
  });

  it.each([
    ['source', { source: 'x = 1' }],
    ['metadata', { metadata: { tags: ['keep'] } }],
    ['outputs', { outputs: [{ output_type: 'stream', name: 'stdout', text: 'keep' }] }],
    ['execution count', { execution_count: 1 }]
  ])('preserves a placeholder with nondefault %s', (_label, extra) => {
    const notebook = emptyNotebook(extra);
    const model = new NotebookModel(notebook, { origin: {} });

    expect(model.removePristineServerPlaceholder()).toBe(false);
    expect(model.summary().cellCount).toBe(1);

    model.dispose();
    notebook.dispose();
  });

  it('preserves a cell carrying an additional shared field', () => {
    const notebook = emptyNotebook();
    notebook.getCell(0).ymodel.set('unexpected', true);
    const model = new NotebookModel(notebook, { origin: {} });

    expect(model.removePristineServerPlaceholder()).toBe(false);
    expect(model.summary().cellCount).toBe(1);

    model.dispose();
    notebook.dispose();
  });

  it('preserves a running default-looking cell', () => {
    const notebook = emptyNotebook();
    notebook.getCell(0).ymodel.set('execution_state', 'running');
    const model = new NotebookModel(notebook, { origin: {} });

    expect(model.removePristineServerPlaceholder()).toBe(false);
    expect(model.summary().cellCount).toBe(1);

    model.dispose();
    notebook.dispose();
  });

  it('preserves a second cell', () => {
    const notebook = new YNotebook();
    notebook.setSource(reviewBook([reviewCode('placeholder', ''), reviewCode('other', '')]) as never);
    const model = new NotebookModel(notebook, { origin: {} });

    expect(model.removePristineServerPlaceholder()).toBe(false);
    expect(model.summary().cellCount).toBe(2);

    model.dispose();
    notebook.dispose();
  });

  it('preserves a placeholder edited by another replica before cleanup', () => {
    const local = reviewPeer(11, reviewBook([reviewCode('placeholder', '')]));
    const remote = reviewPeer(22);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    wire.setAuto(true);

    typeInto(remote.notebook, 0, 'edited in the browser');

    expect(local.model.removePristineServerPlaceholder()).toBe(false);
    expect(local.notebook.getCell(0).getSource()).toBe('edited in the browser');

    wire.dispose();
    local.dispose();
    remote.dispose();
  });
});

describe('selected kernelspec metadata', () => {
  it('writes the complete kernelspec without replacing unrelated metadata', () => {
    const notebook = new YNotebook();
    notebook.setSource(reviewBook([], { keep: { nested: true } }) as never);
    const model = new NotebookModel(notebook, { origin: {} });

    model.setKernelSpecMetadata({ name: 'python3', displayName: 'Python 3', language: 'python' });

    expect(notebook.getMetadata()).toEqual({
      keep: { nested: true },
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }
    });

    model.dispose();
    notebook.dispose();
  });
});
