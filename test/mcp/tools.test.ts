import { afterEach, describe, expect, it } from 'vitest';

import { coreError, type ServerProfile } from '../../src/core/index.js';
import { ChangeJournal } from '../../src/core/notebook/index.js';
import { DEDUPLICATED_TOOLS, TOOL_SPECS, jsonByteSize } from '../../src/mcp/index.js';
import { createCollabService } from '../../src/service/index.js';
import { FakeCollabService, TINY_PNG } from './fake-service.js';
import { connect, metaError } from './harness.js';
import type { Harness, ToolAnswer } from './harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const VALID_ARGS: Record<string, Record<string, unknown>> = {
  server_list: {},
  notebook_list: { server_id: 'default', directory: 'work' },
  notebook_create: { server_id: 'default', request_id: '1', directory: 'work', name: 'new.ipynb' },
  notebook_open: { server_id: 'default', path: 'work/analysis.ipynb' },
  notebook_close: { notebook_id: 'nb_1' },
  notebook_read: { notebook_id: 'nb_1', view: 'summary' },
  notebook_apply: {
    notebook_id: 'nb_1',
    request_id: '2',
    operations: [
      {
        op: 'replace_text',
        cell_id: 'cell_a',
        expected_source_revision: 's1_aaaaaaaaaaaaaaaa',
        old_text: 'df.head()',
        new_text: 'df.head(20)'
      }
    ]
  },
  notebook_execute: {
    notebook_id: 'nb_1',
    request_id: '3',
    cells: [{ cell_id: 'cell_a', expected_source_revision: 's1_aaaaaaaaaaaaaaaa' }],
    wait_ms: 1000
  },
  execution_get: { execution_id: 'exe_1' },
  output_read: { output_id: 'out_1' },
  execution_cancel: { execution_id: 'exe_1' },
  notebook_changes: { notebook_id: 'nb_1', cursor: 'chg_7' },
  notebook_save: { notebook_id: 'nb_1' },
  kernel_list: { server_id: 'default' },
  kernel_status: { notebook_id: 'nb_1' },
  kernel_control: { notebook_id: 'nb_1', request_id: '4', action: 'start', expected_kernel_id: null }
};

describe('tools/list', () => {
  it('publishes all 16 SPEC §9 tools with an input and an output schema', async () => {
    harness = await connect();
    const listed = await harness.client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(TOOL_SPECS.map((spec) => spec.name).sort());
    expect(names).toHaveLength(16);
    for (const tool of listed.tools) {
      expect(tool.inputSchema, tool.name).toBeDefined();
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.description ?? '', tool.name).not.toBe('');
    }
  });

  it('marks exactly the deduplicated mutations as idempotent', async () => {
    harness = await connect();
    const listed = await harness.client.listTools();
    const deduplicated = listed.tools
      .filter((tool) => tool.annotations?.idempotentHint === true)
      .map((tool) => tool.name)
      .sort();
    expect(deduplicated).toEqual([...DEDUPLICATED_TOOLS].sort());
    for (const name of deduplicated) {
      const schema = listed.tools.find((tool) => tool.name === name)?.inputSchema as
        | { properties?: Record<string, unknown>; oneOf?: { properties?: Record<string, unknown> }[] }
        | undefined;
      const branch = schema?.properties ?? schema?.oneOf?.[0]?.properties ?? {};
      expect(Object.keys(branch), name).toContain('request_id');
    }
  });

  it('returns a failed kernel execution as a successful tool result', async () => {
    harness = await connect({ fake: { executionFailed: true } });
    for (const name of ['notebook_execute', 'execution_get']) {
      const answer = await harness.call(name, VALID_ARGS[name]);
      expect(answer.isError ?? false, name).toBe(false);
      expect(answer.structuredContent?.['state'], name).toBe('failed');
      expect(answer.structuredContent?.['reason'], name).toBe('ValueError: boom');
      const cells = answer.structuredContent?.['cells'] as Array<Record<string, unknown>>;
      expect(cells[0]?.['state'], name).toBe('failed');
    }
  });
});

describe('every tool round-trips', () => {
  for (const spec of TOOL_SPECS) {
    it(`${spec.name} answers with structuredContent and text`, async () => {
      harness = await connect();
      const answer = await harness.call(spec.name, VALID_ARGS[spec.name]);
      expect(answer.isError ?? false, JSON.stringify(answer.content)).toBe(false);
      expect(answer.structuredContent).toBeDefined();
      const text = answer.content.find((block) => block.type === 'text')?.text ?? '';
      expect(text.length).toBeGreaterThan(0);
      expect(jsonByteSize(answer.structuredContent)).toBeLessThanOrEqual(64 * 1024);
    });
  }

  it('renames snake_case arguments to the camelCase of CollabService', async () => {
    harness = await connect();
    await harness.call('notebook_execute', VALID_ARGS['notebook_execute']);
    expect(harness.fake.lastRequest('notebookExecute')).toEqual({
      notebookId: 'nb_1',
      requestId: '3',
      cells: [{ cellId: 'cell_a', expectedSourceRevision: 's1_aaaaaaaaaaaaaaaa' }],
      waitMs: 1000
    });
  });

  it('keeps user-chosen metadata keys verbatim in both directions', async () => {
    harness = await connect();
    await harness.call('notebook_apply', {
      notebook_id: 'nb_1',
      request_id: '2',
      operations: [
        {
          op: 'set_cell_metadata',
          cell_id: 'cell_a',
          expected_cell_revision: 'c1_bbbbbbbbbbbbbbbb',
          key: 'user/Weird Key',
          value: { deepKey: [1, 2] }
        }
      ]
    });
    const request = harness.fake.lastRequest('notebookApply') as {
      operations: { key: string; value: unknown }[];
    };
    expect(request.operations[0]?.key).toBe('user/Weird Key');
    expect(request.operations[0]?.value).toEqual({ deepKey: [1, 2] });

    const read = await harness.call('notebook_read', { notebook_id: 'nb_1', view: 'cells' });
    const cells = (read.structuredContent?.['cells'] ?? []) as { metadata: Record<string, unknown> }[];
    expect(cells[0]?.metadata).toEqual({ tags: ['keep'], 'user/Weird Key': 1 });
  });

  it('carries the session envelope into every session-scoped answer', async () => {
    harness = await connect();
    const created = await harness.call('notebook_create', VALID_ARGS['notebook_create']);
    expect(created.structuredContent?.['next_request_id']).toBe('2');
    expect(created.structuredContent?.['request_accepted']).toBe(true);
    expect(created.structuredContent?.['first_accepted_at']).toBe('2026-09-06T10:01:00Z');

    const read = await harness.call('notebook_read', VALID_ARGS['notebook_read']);
    expect(read.structuredContent?.['next_request_id']).toBe('5');
    expect(read.structuredContent?.['request_accepted']).toBeUndefined();
  });
});

describe('argument validation', () => {
  const bad: [string, Record<string, unknown>, RegExp][] = [
    ['notebook_read', { view: 'summary' }, /notebook_id/u],
    ['notebook_read', { notebook_id: 'nb_1', view: 'nonsense' }, /view/u],
    ['notebook_apply', { notebook_id: 'nb_1', request_id: '1', operations: [] }, /operations/u],
    ['notebook_execute', { notebook_id: 'nb_1', request_id: '007', cells: [] }, /request_id|cells/u],
    ['kernel_control', { notebook_id: 'nb_1', request_id: '1', action: 'interrupt' }, /expected_kernel_id/u],
    ['kernel_list', { server_id: 42 }, /server_id/u]
  ];

  for (const [tool, args, expected] of bad) {
    it(`${tool} rejects ${JSON.stringify(args)} as INVALID_ARGUMENT`, async () => {
      harness = await connect();
      const answer = await harness.call(tool, args);
      expect(answer.isError).toBe(true);
      const error = metaError(answer);
      expect(error['code']).toBe('INVALID_ARGUMENT');
      expect(error['retryable']).toBe(false);
      expect(error['side_effects']).toBe('none');
      expect(String(error['message'])).toMatch(expected);
      expect(harness.fake.calls).toHaveLength(0);
    });
  }
});

describe('error mapping', () => {
  it('turns a CoreError into isError with the SPEC §9 fields', async () => {
    harness = await connect({
      fake: {
        failWith: {
          method: 'notebookExecute',
          error: coreError('KERNEL_NOT_BOUND', 'no kernel is bound to work/analysis.ipynb', {
            details: { next_request_id: '4', request_accepted: false, execution_id: 'exe_9', revision: 's1_x' }
          })
        }
      }
    });
    const answer = await harness.call('notebook_execute', VALID_ARGS['notebook_execute']);
    expect(answer.isError).toBe(true);
    expect(metaError(answer)).toMatchObject({
      code: 'KERNEL_NOT_BOUND',
      retryable: false,
      side_effects: 'none',
      next_request_id: '4',
      request_accepted: false,
      execution_id: 'exe_9',
      revision: 's1_x'
    });
    const text = answer.content.find((block) => block.type === 'text')?.text ?? '';
    expect(text).toContain('KERNEL_NOT_BOUND');
    expect(text).toContain('next_request_id=4');
  });

  it('maps an unknown throw to INTERNAL_ERROR with side_effects unknown', async () => {
    harness = await connect({ fake: { failWith: { method: 'notebookSave', error: new Error('boom') } } });
    const answer = await harness.call('notebook_save', { notebook_id: 'nb_1' });
    expect(metaError(answer)).toMatchObject({ code: 'INTERNAL_ERROR', side_effects: 'unknown' });
  });

  it('redacts a token that leaked into a message', async () => {
    harness = await connect({
      fake: {
        failWith: {
          method: 'notebookOpen',
          error: coreError('NETWORK_ERROR', 'GET http://h/api?token=s3cret failed', {
            details: { url: 'ws://h/room?token=s3cret' }
          })
        }
      }
    });
    const answer = await harness.call('notebook_open', VALID_ARGS['notebook_open']);
    const error = metaError(answer);
    expect(JSON.stringify(error)).not.toContain('s3cret');
    expect(String(error['message'])).toContain('token=<redacted>');
    expect(JSON.stringify(error['details'])).toContain('token=<redacted>');
  });

  it('rejects credential-bearing configured URLs before server_list serialization', async () => {
    const profile: ServerProfile = {
      id: 'unsafe',
      kind: 'standalone',
      apiBaseUrl: 'https://host.invalid/user/alice?token=url-secret',
      browserBaseUrl: 'https://url-secret@host.invalid/user/alice',
      credentialRef: 'literal:transport-secret'
    };
    harness = await connect({
      service: createCollabService({ servers: [profile] }, { guardStdout: false })
    });
    const answer = await harness.call('server_list');
    expect(answer.isError).toBe(true);
    expect(metaError(answer)).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(JSON.stringify(answer)).not.toContain('url-secret');
    expect(JSON.stringify(answer)).not.toContain('transport-secret');
  });
});

describe('response size and output content', () => {
  it('extracts only protocol outputs and leaves opaque notebook data byte-identical', async () => {
    harness = await connect({ fake: { outputShapedOpaqueData: true } });
    const cellsAnswer = await harness.call('notebook_read', {
      notebook_id: 'nb_1',
      view: 'cells',
      cell_ids: ['cell_a']
    });
    const cells = cellsAnswer.structuredContent?.['cells'] as Record<string, unknown>[];
    const outputShapedValue = {
      output_type: 'display_data',
      index: 91,
      output: { output_type: 'display_data', data: { 'image/png': TINY_PNG }, metadata: {} }
    };
    const expectedMetadata = {
      'user/Weird Key': outputShapedValue,
      value: ['kept', { exactlyAsGiven: true }]
    };
    const expectedAttachments = {
      'opaque.png': { 'image/png': TINY_PNG },
      nested: outputShapedValue
    };
    expect(JSON.stringify(cells[0]?.['metadata'])).toBe(JSON.stringify(expectedMetadata));
    expect(JSON.stringify(cells[0]?.['attachments'])).toBe(JSON.stringify(expectedAttachments));
    expect(cellsAnswer.content.some((block) => block.type === 'image')).toBe(false);

    const outputsAnswer = await harness.call('notebook_read', {
      notebook_id: 'nb_1',
      view: 'outputs'
    });
    const image = outputsAnswer.content.find((block) => block.type === 'image');
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png', data: TINY_PNG });
  });

  it('returns a small PNG as MCP image content and drops it from structuredContent', async () => {
    harness = await connect();
    const answer = await harness.call('notebook_read', { notebook_id: 'nb_1', view: 'outputs' });
    const image = answer.content.find((block) => block.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(image?.data?.startsWith('iVBORw0KGgo')).toBe(true);

    const cells = (answer.structuredContent?.['cells'] ?? []) as { outputs: Record<string, unknown>[] }[];
    const png = cells[0]?.outputs[1];
    expect(png?.['delivered_as']).toBe('image');
    expect(png?.['output']).toBeUndefined();
    expect((png?.['snapshot'] as { uri: string }).uri).toBe('jupyter-output:out_1');
  });

  it('links a large PNG instead of inlining it', async () => {
    harness = await connect({ fake: { bigImage: true } });
    const answer = await harness.call('notebook_read', { notebook_id: 'nb_1', view: 'outputs' });
    expect(answer.content.some((block) => block.type === 'image')).toBe(false);
    const link = answer.content.find((block) => block.type === 'resource_link');
    expect(link?.uri).toBe('jupyter-output:out_1');
    expect(link?.mimeType).toBe('image/png');
    expect(jsonByteSize(answer.structuredContent)).toBeLessThanOrEqual(64 * 1024);
    expect(answer.structuredContent?.['response_truncated']).toBe(true);
    expect(String(answer.structuredContent?.['read_more'])).toContain('output_read');
  });

  it('keeps a bulky summary inside the byte budget and says how to read the rest', async () => {
    harness = await connect({ fake: { bulkCells: 400 } });
    const answer = await harness.call('notebook_read', { notebook_id: 'nb_1', view: 'summary' });
    expect(jsonByteSize(answer.structuredContent)).toBeLessThanOrEqual(64 * 1024);
    expect(answer.structuredContent?.['response_truncated']).toBe(true);
    expect(String(answer.structuredContent?.['read_more'])).toMatch(/limits|cursor/u);
    const summary = answer.structuredContent?.['summary'] as {
      cells: unknown[];
      cell_count: number;
      page_cursor: string;
    };
    expect(summary.cell_count).toBe(400);
    expect(summary.cells.length).toBeLessThan(400);
    const cursor = String(summary['page_cursor']);
    expect(Number(cursor.slice(cursor.lastIndexOf('.') + 1))).toBe(summary.cells.length);
    expect(answer.structuredContent?.['next_cursor']).toBe(cursor);
  });

  it('pages every real journal event exactly once through the SDK', async () => {
    const journal = new ChangeJournal({ limit: 200 });
    for (let sequence = 1; sequence <= 100; sequence += 1) {
      journal.publish({
        kind: 'source_changed',
        cellId: `cell_${String(sequence)}`,
        revisions: {},
        origin: 'remote'
      });
    }
    const service = new FakeCollabService();
    service.notebookChanges = async (request) => {
      const page = journal.since(request.cursor, request.limit);
      return {
        notebookId: request.notebookId,
        events: page.events,
        nextCursor: page.nextCursor,
        truncated: page.nextCursor !== journal.cursor,
        connectionState: 'ready',
        stale: false,
        waitTimedOut: false,
        nextRequestId: '1'
      };
    };
    harness = await connect({ service, server: { responseMaxBytes: 1800 } });

    const sequences: number[] = [];
    let cursor = 'chg_0';
    while (cursor !== journal.cursor) {
      const answer = await harness.call('notebook_changes', {
        notebook_id: 'nb_1',
        cursor,
        limit: 100
      });
      expect(answer.isError ?? false).toBe(false);
      expect(jsonByteSize(answer.structuredContent)).toBeLessThanOrEqual(1800);
      const events = answer.structuredContent?.['events'] as { sequence: number }[];
      sequences.push(...events.map((event) => event.sequence));
      cursor = String(answer.structuredContent?.['next_cursor']);
    }
    expect(sequences).toEqual(Array.from({ length: 100 }, (_unused, index) => index + 1));
    journal.dispose();
  });

  it('returns a bounded RESOURCE_LIMIT instead of an oversized metadata success', async () => {
    harness = await connect({ fake: { oversizedMetadata: true } });
    const answer = await harness.call('notebook_read', {
      notebook_id: 'nb_1',
      view: 'cells',
      cell_ids: ['cell_a']
    });
    expect(answer.isError).toBe(true);
    expect(answer.structuredContent).toBeUndefined();
    expect(metaError(answer)).toMatchObject({ code: 'RESOURCE_LIMIT' });
  });

  it('honours a smaller configured budget', async () => {
    harness = await connect({ server: { responseMaxBytes: 2048 } });
    const answer: ToolAnswer = await harness.call('notebook_read', { notebook_id: 'nb_1', view: 'outputs' });
    expect(jsonByteSize(answer.structuredContent)).toBeLessThanOrEqual(2048);
  });
});
