import { describe, expect, it } from 'vitest';

import {
  createCollabService,
  type CollabService,
  type CollabServiceOptions,
  type ServiceConfigInput
} from '../src/index.js';

describe('package root', () => {
  it('constructs the public service and keeps credentials out of descriptors', async () => {
    const config: ServiceConfigInput = {
      servers: [
        {
          id: 'lab',
          kind: 'standalone',
          apiBaseUrl: 'http://127.0.0.1:8888',
          credentialRef: 'literal:not-for-network-use'
        }
      ]
    };
    const options: CollabServiceOptions = { guardStdout: false };
    const service: CollabService = createCollabService(config, options);

    try {
      const result = await service.serverList();
      expect(result.servers).toEqual([
        expect.objectContaining({
          descriptor: expect.objectContaining({ id: 'lab', kind: 'standalone' }),
          defaultChoice: true,
          origin: 'configured'
        })
      ]);
      expect(JSON.stringify(result)).not.toContain('not-for-network-use');
    } finally {
      await service.shutdown('client_request');
    }
  });
});
