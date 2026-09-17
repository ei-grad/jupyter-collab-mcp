import { describe, expect, it } from 'vitest';

import {
  decryptValue,
  encryptValue,
  EncryptedStore,
  MemoryKeyValueBackend
} from '../../src/gateway/crypto-store.js';

const KEY = new Uint8Array(32).fill(11);

describe('encrypted gateway storage', () => {
  it('authenticates encryption and never stores plaintext JSON', async () => {
    const backend = new MemoryKeyValueBackend();
    const store = new EncryptedStore(backend, KEY, () => 1_000);
    const secret = 'exact-upstream-id-token';

    await store.put('tokens', 'one', { assertion: secret }, 60);

    const raw = [...backend.values.values()][0]?.value;
    expect(raw).toBeDefined();
    expect(raw).not.toContain(secret);
    expect(await store.get('tokens', 'one')).toEqual({ assertion: secret });

    const corrupted = raw!.slice(0, -1) + (raw!.endsWith('A') ? 'B' : 'A');
    backend.values.set('jupyter-collab-mcp:tokens:one', { value: corrupted });
    expect(await store.get('tokens', 'one')).toBeNull();
  });

  it('expires values and consumes authorization material exactly once', async () => {
    let now = 10_000;
    const backend = new MemoryKeyValueBackend(() => now);
    const store = new EncryptedStore(backend, KEY, () => now);

    await store.put('codes', 'code', { owner: 'alice' }, 2);
    expect(await store.take('codes', 'code')).toEqual({ owner: 'alice' });
    expect(await store.take('codes', 'code')).toBeNull();

    await store.put('tokens', 'token', { owner: 'alice' }, 2);
    now += 2_001;
    expect(await store.get('tokens', 'token')).toBeNull();
  });

  it('serializes concurrent one-time consumption', async () => {
    const backend = new MemoryKeyValueBackend();
    const store = new EncryptedStore(backend, KEY);
    await store.put('codes', 'single', { owner: 'alice' }, 60);

    const results = await Promise.all([
      store.take('codes', 'single'),
      store.take('codes', 'single')
    ]);

    expect(results.filter((value) => value !== null)).toEqual([{ owner: 'alice' }]);
  });

  it('round-trips the Fernet layout and rejects wrong keys', () => {
    const token = encryptValue('private assertion', KEY, () => 1_700_000_000_000);
    expect(decryptValue(token, KEY)).toBe('private assertion');
    expect(() => decryptValue(token, new Uint8Array(32).fill(12))).toThrow(
      'invalid encrypted value'
    );
    expect(Buffer.from(token, 'base64url')[0]).toBe(0x80);
  });
});
