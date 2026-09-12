import { describe, expect, it } from 'vitest';

import {
  REVISION_BODY_LENGTH,
  REVISION_PREFIX,
  canonicalJson,
  cellRevision,
  isRevisionOfKind,
  notebookMetadataRevision,
  outputsRevision,
  revisionKind,
  sourceRevision,
  structureRevision
} from '../../src/core/revision.js';
import type { NbOutput } from '../../src/core/types.js';

const outputs: NbOutput[] = [
  {
    output_type: 'execute_result',
    data: { 'text/plain': '42' },
    metadata: {},
    execution_count: 1
  }
];

describe('canonicalJson', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested keys too', () => {
    const left = canonicalJson({ outer: { z: [1, { y: 1, x: 2 }], a: null } });
    const right = canonicalJson({ outer: { a: null, z: [1, { x: 2, y: 1 }] } });
    expect(left).toBe(right);
  });

  it('preserves array order', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined properties and encodes non-finite numbers as null', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: Number.NaN })).toBe('{"a":null}');
  });
});

describe('sourceRevision', () => {
  it('is deterministic', () => {
    expect(sourceRevision('code', 'df.head()')).toBe(sourceRevision('code', 'df.head()'));
  });

  it('changes when the text changes', () => {
    expect(sourceRevision('code', 'df.head()')).not.toBe(sourceRevision('code', 'df.head(20)'));
  });

  it('changes when the cell type changes (SPEC.md §7)', () => {
    expect(sourceRevision('code', 'x = 1')).not.toBe(sourceRevision('markdown', 'x = 1'));
    expect(sourceRevision('markdown', 'x = 1')).not.toBe(sourceRevision('raw', 'x = 1'));
  });

  it('distinguishes whitespace exactly', () => {
    expect(sourceRevision('code', 'x=1')).not.toBe(sourceRevision('code', 'x=1\n'));
  });

  it('carries the s1_ prefix and a full-length base64url body', () => {
    const rev = sourceRevision('code', 'x = 1');
    expect(rev.startsWith(REVISION_PREFIX.source)).toBe(true);
    expect(rev.length).toBe(REVISION_PREFIX.source.length + REVISION_BODY_LENGTH);
    expect(rev.slice(REVISION_PREFIX.source.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('outputsRevision', () => {
  it('is deterministic and order sensitive', () => {
    expect(outputsRevision(outputs)).toBe(outputsRevision([...outputs]));
    const two: NbOutput[] = [
      ...outputs,
      { output_type: 'stream', name: 'stdout', text: 'hi\n' }
    ];
    expect(outputsRevision(two)).not.toBe(outputsRevision([two[1]!, two[0]!]));
  });

  it('ignores key order inside an output', () => {
    const a: NbOutput = {
      output_type: 'display_data',
      data: { 'text/plain': 'x', 'image/png': 'AAA' },
      metadata: {}
    };
    const b: NbOutput = {
      metadata: {},
      data: { 'image/png': 'AAA', 'text/plain': 'x' },
      output_type: 'display_data'
    };
    expect(outputsRevision([a])).toBe(outputsRevision([b]));
  });

  it('differs between an empty output area and one output', () => {
    expect(outputsRevision([])).not.toBe(outputsRevision(outputs));
  });
});

describe('source and outputs revisions are independent (SPEC.md §7)', () => {
  it('an outputs change does not move source_revision', () => {
    const source = 'x = 40 + 2\nx';
    const before = sourceRevision('code', source);
    const cellBefore = {
      id: 'c1',
      cell_type: 'code',
      source,
      metadata: {},
      execution_count: null,
      outputs: []
    } as const;
    const cellAfter = {
      ...cellBefore,
      execution_count: 1,
      outputs: [
        {
          output_type: 'execute_result',
          data: { 'text/plain': '42' },
          metadata: {},
          execution_count: 1
        }
      ]
    };

    expect(sourceRevision('code', source)).toBe(before);
    expect(outputsRevision([])).not.toBe(outputsRevision(cellAfter.outputs as NbOutput[]));
    expect(cellRevision(cellBefore)).not.toBe(cellRevision(cellAfter));
  });

  it('a source change does not move outputs_revision', () => {
    const before = outputsRevision(outputs);
    void sourceRevision('code', 'changed');
    expect(outputsRevision(outputs)).toBe(before);
  });
});

describe('cellRevision', () => {
  it('is deterministic and key-order independent', () => {
    const a = { id: 'c1', cell_type: 'code', source: 'x', metadata: { tags: ['a'] } };
    const b = { metadata: { tags: ['a'] }, source: 'x', cell_type: 'code', id: 'c1' };
    expect(cellRevision(a)).toBe(cellRevision(b));
  });

  it('covers unknown keys, so foreign metadata cannot be lost silently', () => {
    const a = { id: 'c1', cell_type: 'code', source: 'x', metadata: {} };
    const b = { ...a, metadata: { vendor_extension: { keep: true } } };
    expect(cellRevision(a)).not.toBe(cellRevision(b));
  });

  it('covers metadata and outputs, unlike sourceRevision', () => {
    const base = { id: 'c1', cell_type: 'code', source: 'x', metadata: {}, outputs: [] };
    expect(cellRevision(base)).not.toBe(cellRevision({ ...base, metadata: { tags: ['t'] } }));
  });
});

describe('notebookMetadataRevision and structureRevision', () => {
  it('notebook metadata is key-order independent', () => {
    const a = { kernelspec: { name: 'python3' }, language_info: { name: 'python' } };
    const b = { language_info: { name: 'python' }, kernelspec: { name: 'python3' } };
    expect(notebookMetadataRevision(a)).toBe(notebookMetadataRevision(b));
  });

  it('structure follows the order of ids', () => {
    expect(structureRevision(['a', 'b'])).not.toBe(structureRevision(['b', 'a']));
    expect(structureRevision(['a', 'b'])).toBe(structureRevision(['a', 'b']));
  });

  it('structure keeps duplicates visible', () => {
    expect(structureRevision(['a', 'a'])).not.toBe(structureRevision(['a']));
  });
});

describe('kind tags', () => {
  it('gives each kind its own prefix', () => {
    const prefixes = Object.values(REVISION_PREFIX);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('never lets two kinds produce the same digest for the same payload', () => {
    // Same canonical payload ([] and []), different kind -> different digest.
    expect(outputsRevision([]).slice(3)).not.toBe(structureRevision([]).slice(3));
    // Same for the two object-shaped kinds.
    expect(cellRevision({}).slice(3)).not.toBe(notebookMetadataRevision({}).slice(3));
  });

  it('reports the kind back', () => {
    expect(revisionKind(sourceRevision('code', 'x'))).toBe('source');
    expect(revisionKind(outputsRevision([]))).toBe('outputs');
    expect(revisionKind(cellRevision({}))).toBe('cell');
    expect(revisionKind(notebookMetadataRevision({}))).toBe('notebookMetadata');
    expect(revisionKind(structureRevision([]))).toBe('structure');
    expect(revisionKind('rev_before')).toBeNull();
  });

  it('validates a caller-supplied expected_* value by kind', () => {
    const source = sourceRevision('code', 'x');
    expect(isRevisionOfKind(source, 'source')).toBe(true);
    expect(isRevisionOfKind(source, 'cell')).toBe(false);
    expect(isRevisionOfKind('s1_short', 'source')).toBe(false);
    expect(isRevisionOfKind(undefined, 'source')).toBe(false);
  });
});
