import { expect, it, vi } from 'vitest';
import { YNotebook } from '@jupyter/ydoc';
import { captureNotebookPersistence, notebookPersistenceDigest as digest } from '../../../src/core/notebook/persistence.js';

const fixture = () => ({ nbformat: 4, nbformat_minor: 5, metadata: { custom: { labels: ['a', 'b'] } }, cells: [
  { id: 'code', cell_type: 'code', source: 'π = 1\nprint(π)', metadata: { tag: 'kept' }, execution_count: 2, outputs: [
    { output_type: 'stream', name: 'stdout', text: 'π\n🙂\n' },
    { output_type: 'display_data', metadata: { custom: true }, data: { 'text/plain': 'α\nβ', 'application/json': ['a', 'b'], 'application/vnd.custom+json': ['x', 'y'] } }
  ], custom_persistent_field: { keep: true } },
  { id: 'md', cell_type: 'markdown', source: '![x](attachment:image.png)', metadata: {}, attachments: { 'image.png': { 'image/png': 'YWJjZA==' } } }
] });

it('normalizes notebook multiline serialization and server trust decoration', () => {
  const a = fixture();
  const b: any = structuredClone(a);
  b.cells[0].source = ['π = 1\n', 'print(π)'];
  b.cells[0].outputs[0].text = ['π\n', '🙂\n'];
  b.cells[0].outputs[1].data['text/plain'] = ['α\n', 'β'];
  b.cells[1].attachments['image.png']['image/png'] = ['YWJj', 'ZA=='];
  b.cells[0].metadata.trusted = true;
  b.cells[0].execution_state = 'busy';
  expect(digest(b)).toBe(digest(a));
  expect(digest(a)).toMatch(/^sha256:[a-f0-9]{64}$/);
});

it.each(['source', 'metadata', 'output', 'attachment', 'count', 'id', 'order', 'format', 'extra', 'json-array'])('retains persistent %s differences', change => {
  const a = fixture(); const b: any = structuredClone(a);
  if (change === 'source') b.cells[0].source += '\n';
  if (change === 'metadata') b.metadata.custom.labels.reverse();
  if (change === 'output') b.cells[0].outputs[0].text += 'changed';
  if (change === 'attachment') b.cells[1].attachments['image.png']['image/png'] = 'different';
  if (change === 'count') b.cells[0].execution_count++;
  if (change === 'id') b.cells[0].id = 'other';
  if (change === 'order') b.cells.reverse();
  if (change === 'format') b.nbformat_minor++;
  if (change === 'extra') b.cells[0].custom_persistent_field.keep = false;
  if (change === 'json-array') b.cells[0].outputs[1].data['application/json'] = 'ab';
  expect(digest(b)).not.toBe(digest(a));
});

it('matches documented old-format IDs and empty optional attachments', () => {
  const a: any = fixture(); a.nbformat_minor = 4; a.cells[1].attachments = {};
  const b = structuredClone(a); delete b.cells[0].id; delete b.cells[1].id; delete b.cells[1].attachments;
  expect(digest(a)).toBe(digest(b));
});

it('captures raw cell fields that ordinary cell.toJSON omits', () => {
  const notebook = new YNotebook();
  notebook.setSource(fixture() as never);
  notebook.cells[0]!.ymodel.set('extra_persistent', 'first');
  const first = captureNotebookPersistence(notebook);
  notebook.cells[0]!.ymodel.set('extra_persistent', 'second');
  expect(captureNotebookPersistence(notebook)).not.toBe(first);
  notebook.dispose();
});

it('enforces exact UTF-8 JSON capture boundaries before cloning and hashing', () => {
  const notebook = fixture();
  notebook.cells[0]!.source = 'π🙂\n"\\\ud800';
  const bytes = Buffer.byteLength(JSON.stringify(notebook));
  expect(digest(notebook, bytes)).not.toBeNull();
  expect(digest(notebook, bytes - 1)).toBeNull();
  const model = new YNotebook(); model.setSource(notebook as never);
  expect(captureNotebookPersistence(model, 10)).toBeNull();
  model.dispose();
});

it('rejects oversized shared source before materialization or later cell access', () => {
  const notebook = new YNotebook(); notebook.setSource(fixture() as never);
  const source = notebook.cells[0]!.ymodel.get('source') as import('yjs').Text;
  source.insert(0, 'x'.repeat(2000));
  const stringSpy = vi.fn(source.toString.bind(source));
  source.toString = stringSpy;
  const cellSpy = vi.spyOn(notebook.cells[0]!.ymodel, 'toJSON');
  const cellsSpy = vi.spyOn(notebook.ydoc.getArray('cells'), 'toJSON');
  const metadataSpy = vi.spyOn(notebook, 'metadata', 'get');
  const tailSpy = vi.spyOn(notebook.cells[1]!.ymodel, Symbol.iterator);
  expect(captureNotebookPersistence(notebook, 1000)).toBeNull();
  expect(stringSpy).not.toHaveBeenCalled();
  expect(cellSpy).not.toHaveBeenCalled();
  expect(cellsSpy).not.toHaveBeenCalled();
  expect(metadataSpy).not.toHaveBeenCalled();
  expect(tailSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks(); notebook.dispose();
});

it.each(['array', 'metadata'] as const)('stops before copying an oversized %s tail', kind => {
  const notebook = new YNotebook(); notebook.setSource(fixture() as never);
  let tailReads = 0;
  const payload: Record<string, unknown> | unknown[] = kind === 'array'
    ? ['x'.repeat(2000), 'unvisited'] : { large: 'x'.repeat(2000), tail: 'unvisited' };
  if (kind === 'array') notebook.cells[0]!.ymodel.set('extra', payload);
  else (notebook.ymeta.get('metadata') as import('yjs').Map<unknown>).set('extra', payload);
  Object.defineProperty(payload, kind === 'array' ? '1' : 'tail', { enumerable: true, get: () => { tailReads++; return 'unvisited'; } });
  const getterSpy = vi.spyOn(notebook, 'metadata', 'get');
  const jsonSpy = vi.spyOn(notebook.ymeta.get('metadata') as import('yjs').Map<unknown>, 'toJSON');
  expect(captureNotebookPersistence(notebook, 1000)).toBeNull();
  expect(tailReads).toBe(0);
  expect(getterSpy).not.toHaveBeenCalled();
  expect(jsonSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks(); notebook.dispose();
});

it.each(['cell', 'cell-metadata', 'notebook-metadata'] as const)('retains shared __proto__ in %s through hashing', kind => {
  const notebook = new YNotebook(); notebook.setSource(fixture() as never);
  const map = kind === 'cell' ? notebook.cells[0]!.ymodel
    : kind === 'cell-metadata' ? notebook.cells[0]!.ymodel.get('metadata')
      : notebook.ymeta.get('metadata');
  const original = captureNotebookPersistence(notebook);
  map.set('__proto__', { persistent_marker: 'pending' });
  const first = captureNotebookPersistence(notebook);
  expect(first).not.toBe(original);
  map.set('__proto__', { persistent_marker: 'saved' });
  expect(captureNotebookPersistence(notebook)).not.toBe(first);
  notebook.dispose();
});

it.each(['root', 'cell', 'cell-metadata', 'notebook-metadata', 'output-data', 'attachment'] as const)('preserves own __proto__ in Contents %s dictionaries', kind => {
  const notebook: any = fixture();
  const target = kind === 'root' ? notebook : kind === 'cell' ? notebook.cells[0]
    : kind === 'cell-metadata' ? notebook.cells[0].metadata : kind === 'notebook-metadata' ? notebook.metadata
      : kind === 'output-data' ? notebook.cells[0].outputs[1].data : notebook.cells[1].attachments;
  const original = digest(notebook);
  Object.defineProperty(target, '__proto__', { value: { persistent_marker: 'pending' }, enumerable: true, writable: true });
  const first = digest(notebook);
  expect(first).not.toBe(original);
  target.__proto__ = { persistent_marker: 'saved' };
  expect(digest(notebook)).not.toBe(first);
});
