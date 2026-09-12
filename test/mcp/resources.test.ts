import { afterEach, describe, expect, it } from 'vitest';

import { connect } from './harness.js';
import type { Harness } from './harness.js';
import { TINY_PNG } from './fake-service.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('jupyter-output resources (SPEC §9)', () => {
  it('declares the resources capability and lists the live snapshots', async () => {
    harness = await connect();
    expect(harness.client.getServerCapabilities()?.resources).toBeDefined();
    const listed = await harness.client.listResources();
    expect(listed.resources).toEqual([
      expect.objectContaining({ uri: 'jupyter-output:out_1', mimeType: 'image/png' })
    ]);
    expect(harness.fake.calls.some((call) => call.method === 'listOutputResources')).toBe(true);
  });

  it('reads one snapshot through resources/read', async () => {
    harness = await connect();
    const read = await harness.client.readResource({ uri: 'jupyter-output:out_1' });
    expect(read.contents).toEqual([
      { uri: 'jupyter-output:out_1', mimeType: 'image/png', blob: TINY_PNG }
    ]);
    expect(harness.fake.lastRequest('readOutputResource')).toBe('jupyter-output:out_1');
  });

  it('points at output_read when the snapshot does not fit one read', async () => {
    harness = await connect({ fake: { resourceTooLarge: true } });
    const read = await harness.client.readResource({ uri: 'jupyter-output:out_1' });
    const first = read.contents[0] as { mimeType: string; text: string };
    expect(first.mimeType).toBe('application/json');
    const payload = JSON.parse(first.text) as Record<string, unknown>;
    expect(payload).toMatchObject({ output_id: 'out_1', truncated: true });
    expect(String(payload['read_more'])).toContain('output_read');
  });

  it('reports an expired snapshot as HANDLE_EXPIRED', async () => {
    harness = await connect();
    await expect(harness.client.readResource({ uri: 'jupyter-output:gone' })).rejects.toThrow(
      /HANDLE_EXPIRED/u
    );
  });

  it('serves the same bytes through the output_read tool for hosts without resources', async () => {
    harness = await connect();
    const answer = await harness.call('output_read', { output_id: 'out_1' });
    expect(answer.structuredContent).toMatchObject({
      output_id: 'out_1',
      uri: 'jupyter-output:out_1',
      encoding: 'base64',
      data: TINY_PNG,
      truncated: false
    });
  });
});
