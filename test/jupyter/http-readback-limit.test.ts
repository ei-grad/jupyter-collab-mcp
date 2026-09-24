import { expect, it } from 'vitest';
import { httpRequest } from '../../src/jupyter/http.js';

it('counts actual UTF-8 bytes and decodes split code points at the exact cap', async () => {
  const raw = new TextEncoder().encode('π🙂');
  const response = () => new Response(new ReadableStream({ start(controller) {
    for (const byte of raw) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }));
  expect((await httpRequest('http://fixture/content', 'fixture', { maxResponseBytes: raw.length, fetchImpl: async () => response() })).text).toBe('π🙂');
  await expect(httpRequest('http://fixture/content', 'fixture', { maxResponseBytes: raw.length - 1, fetchImpl: async () => response() })).rejects.toThrow('byte limit');
});
