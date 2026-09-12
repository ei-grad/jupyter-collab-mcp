import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { YNotebook } from '@jupyter/ydoc';

describe('@jupyter/ydoc runs headless', () => {
  it('has no DOM available', () => {
    expect('window' in globalThis).toBe(false);
    expect('document' in globalThis).toBe(false);
  });

  it('creates a YNotebook, adds a code cell and reads it back', () => {
    const notebook = new YNotebook();
    try {
      expect(notebook.cells).toHaveLength(0);

      const source = 'print("hello")\n';
      const cell = notebook.addCell({ cell_type: 'code', source });

      expect(notebook.cells).toHaveLength(1);
      const readBack = notebook.getCell(0);
      expect(readBack.getId()).toBe(cell.getId());
      expect(readBack.cell_type).toBe('code');
      expect(readBack.getSource()).toBe(source);
    } finally {
      // YNotebook owns a y-protocols Awareness with a 3s setInterval; without
      // dispose() the Node event loop never drains.
      notebook.dispose();
    }
  });

  it('round-trips notebook state through a Yjs update', () => {
    const origin = new YNotebook();
    const replica = new YNotebook();
    try {
      const cell = origin.addCell({ cell_type: 'code', source: 'df.head()' });
      Y.applyUpdate(replica.ydoc, Y.encodeStateAsUpdate(origin.ydoc));

      expect(replica.cells).toHaveLength(1);
      expect(replica.getCell(0).getId()).toBe(cell.getId());
      expect(replica.getCell(0).getSource()).toBe('df.head()');

      // Once converged, the outstanding diff is empty.
      const diff = Y.encodeStateAsUpdate(origin.ydoc, Y.encodeStateVector(replica.ydoc));
      expect(Y.decodeUpdate(diff).structs).toHaveLength(0);
    } finally {
      replica.dispose();
      origin.dispose();
    }
  });

  it('uses a single yjs instance across packages', () => {
    const notebook = new YNotebook();
    try {
      expect(notebook.ydoc).toBeInstanceOf(Y.Doc);
      const cell = notebook.addCell({ cell_type: 'code', source: '' });
      expect(cell.ymodel.doc).toBe(notebook.ydoc);
    } finally {
      notebook.dispose();
    }
  });
});
