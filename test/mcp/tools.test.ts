import { afterEach, describe, expect, it } from 'vitest';

import { coreError } from '../../src/core/index.js';
import { TOOL_SPECS, jsonByteSize } from '../../src/mcp/index.js';
import { connect, metaError } from './harness.js';
import type { Harness, ToolAnswer } from './harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const VALID_ARGS: Record<string, Record<string, unknown>> = {
  server_list: {},
  session_open: { server_id: 'default', label: 'tests' },
  session_close: { session_id: 'ses_1' },
  notebook_list: { session_id: 'ses_1', directory: 'work' },
  notebook_create: { session_id: 'ses_1', request_id: '1', directory: 'work', name: 'new.ipynb' },
  notebook_open: { session_id: 'ses_1', path: 'work/analysis.ipynb' },
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
  kernel_list: { session_id: 'ses_1' },
  kernel_status: { notebook_id: 'nb_1' },
  kernel_control: { notebook_id: 'nb_1', request_id: '4', action: 'start', expected_kernel_id: null }
};

describe('tools/list', () => {
  it('publishes all 18 SPEC §9 tools with an input and an output schema', async () => {
    harness = await connect();
    const listed = await harness.client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(TOOL_SPECS.map((spec) => spec.name).sort());
    expect(names).toHaveLength(18);
    for (const tool of listed.tools) {
      expect(tool.inputSchema, tool.name).toBeDefined();
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.description ?? '', tool.name).not.toBe('');
    }
  });

  it('documents the sequential request_id rule on exactly the four mutations', async () => {
    harness = await connect();
    const listed = await harness.client.listTools();
    const deduplicated = listed.tools
      .filter((tool) => /Deduplicated and sequential/u.test(tool.description ?? ''))
      .map((tool) => tool.name)
      .sort();
    expect(deduplicated).toEqual(['kernel_control', 'notebook_apply', 'notebook_create', 'notebook_execute']);
    for (const name of deduplicated) {
      const schema = listed.tools.find((tool) => tool.name === name)?.inputSchema as
        | { properties?: Record<string, unknown>; oneOf?: { properties?: Record<string, unknown> }[] }
        | undefined;
      const branch = schema?.properties ?? schema?.oneOf?.[0]?.properties ?? {};
      expect(Object.keys(branch), name).toContain('request_id');
    }
  });

  it('says that a Python error is a job result on the execution tools', async () => {
    harness = await connect();
    const listed = await harness.client.listTools();
    for (const name of ['notebook_execute', 'execution_get']) {
      const description = listed.tools.find((tool) => tool.name === name)?.description ?? '';
      expect(description, name).toMatch(/Python error/u);
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
    ['session_open', { server_id: 42 }, /server_id/u]
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
});

describe('response size and output content', () => {
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
    const summary = answer.structuredContent?.['summary'] as { cells: unknown[]; cell_count: number };
    expect(summary.cell_count).toBe(400);
    expect(summary.cells.length).toBeLessThan(400);
  });

  it('honours a smaller configured budget', async () => {
    harness = await connect({ server: { responseMaxBytes: 2048 } });
    const answer: ToolAnswer = await harness.call('notebook_read', { notebook_id: 'nb_1', view: 'outputs' });
    expect(jsonByteSize(answer.structuredContent)).toBeLessThanOrEqual(2048);
  });
});
